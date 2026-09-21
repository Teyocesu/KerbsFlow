import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExecutorAdapter } from "./adapter.js";
import {
  CONTRACT_VERSIONS,
  type AdapterDescriptor,
  type AttemptHandle,
  type AttemptId,
  type CancelOutcome,
  type ExecutionRequest,
  type ExecutorResult,
  type NormalizedEvent,
  type ReconcileOutcome,
  asValidationId,
  parseExecutorResult,
  parseExecutionRequest,
} from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import {
  ProcessSupervisor,
  type ProcessResult,
  type RawProcessEvent,
  type SupervisedProcess,
  codexEnvironment,
} from "./process.js";

export interface CodexAdapterOptions {
  cliPath: string;
  runtimeRoot: string;
  supervisor?: ProcessSupervisor;
  environment?: NodeJS.ProcessEnv;
}

interface CodexSession {
  request: ExecutionRequest;
  handle: AttemptHandle;
  process: SupervisedProcess;
  directory: string;
  resultPath: string;
  processResult?: ProcessResult;
}

export class CodexAdapter implements ExecutorAdapter {
  private readonly supervisor: ProcessSupervisor;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly attemptsRoot: string;
  private readonly sessions = new Map<string, CodexSession>();
  private descriptor: AdapterDescriptor | undefined;

  constructor(private readonly options: CodexAdapterOptions) {
    this.supervisor = options.supervisor ?? new ProcessSupervisor();
    this.environment = codexEnvironment(options.environment ?? process.env);
    this.attemptsRoot = resolve(options.runtimeRoot, "codex-attempts");
    mkdirSync(this.attemptsRoot, { recursive: true, mode: 0o700 });
  }

  probe(): AdapterDescriptor {
    const version = this.runProbe(["--version"], "version");
    const execHelp = this.runProbe(["exec", "--help"], "exec help");
    const resumeHelp = this.runProbe(["exec", "resume", "--help"], "resume help");
    const login = this.runProbe(["login", "status"], "authentication status");
    const required = ["--json", "--output-schema", "--output-last-message", "--model", "--sandbox", "--cd", "--config", "--ignore-user-config", "--strict-config"];
    const missing = required.filter((flag) => !execHelp.includes(flag));
    if (missing.length > 0 || !resumeHelp.toLowerCase().includes("resume")) {
      throw new KerbsFlowError("CODEX_CAPABILITY_MISSING", `installed Codex lacks required capabilities: ${missing.join(", ") || "resume"}`);
    }
    if (!/logged in|authenticated/iu.test(login)) {
      throw new KerbsFlowError("CODEX_AUTH_NOT_READY", "Codex CLI is not authenticated through its provider-owned credential store");
    }
    this.descriptor = {
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "codex",
      provider: "openai",
      adapterVersion: version.slice(0, 100),
      capabilities: {
        eventTransport: "jsonl",
        finalJsonSchema: true,
        modelSelection: true,
        reasoningEffort: ["low", "medium", "high", "xhigh"],
        agentSelection: false,
        filesystemEnforcement: "enforced",
        network: { providerControlPlane: "provider_owned", workload: "enforced" },
        cancellation: "process_only",
        resumableSession: true,
        authentication: { owner: "provider", mode: /chatgpt/iu.test(login) ? "chatgpt" : /api.?key/iu.test(login) ? "api_key" : "authenticated" },
        healthProbe: true,
      },
    };
    return this.descriptor;
  }

  start(request: ExecutionRequest): AttemptHandle {
    request = parseExecutionRequest(request);
    const descriptor = this.descriptor ?? this.probe();
    if (this.sessions.has(request.attemptId)) {
      throw new KerbsFlowError("DUPLICATE_EXECUTION", `attempt ${request.attemptId} is already active in this adapter`);
    }
    const directory = join(this.attemptsRoot, String(request.attemptId));
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    const schemaPath = join(directory, "executor-result.schema.json");
    const resultPath = join(directory, "executor-result.json");
    writeFileSync(schemaPath, `${JSON.stringify(EXECUTOR_RESULT_JSON_SCHEMA)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const args = [
      "exec",
      "--json",
      "--output-schema", schemaPath,
      "--output-last-message", resultPath,
      "--sandbox", "workspace-write",
      "--cd", request.workingDirectory,
      "--model", request.model,
      "--ignore-user-config",
      "--strict-config",
      "--config", "approval_policy=\"never\"",
      "--config", "sandbox_workspace_write.network_access=false",
      "--config", "allow_login_shell=false",
      ...(request.reasoning === undefined ? [] : ["--config", `model_reasoning_effort=\"${safeConfigToken(request.reasoning)}\"`]),
      request.promptSummary,
    ];
    const process = this.supervisor.start({
      executable: this.options.cliPath,
      args,
      cwd: request.workingDirectory,
      environment: this.environment,
      timeoutMs: request.timeoutMs,
      gracePeriodMs: 2000,
    });
    const handle: AttemptHandle = {
      schemaVersion: CONTRACT_VERSIONS.attemptHandle,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      providerSessionId: `process:${process.identity.supervisorId}:${process.identity.pid}`,
    };
    const metadata = {
      schemaVersion: "kerbsflow.codex-process/v1",
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      process: process.identity,
      resultPath,
      adapterVersion: descriptor.adapterVersion,
      model: request.model,
      ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
      workingDirectory: request.workingDirectory,
    };
    writeFileSync(join(directory, "process.json"), `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    this.sessions.set(request.attemptId, { request, handle, process, directory, resultPath });
    return handle;
  }

  async *events(handle: AttemptHandle): AsyncIterable<NormalizedEvent> {
    const session = this.requiredSession(handle.attemptId);
    let sequence = 0;
    for await (const event of session.process.events()) {
      sequence = event.sequence;
      const value = typeof event.value === "object" && event.value !== null ? event.value as Record<string, unknown> : undefined;
      if (value?.type === "thread.started" && typeof value.thread_id === "string" && value.thread_id.length > 0) {
        session.handle.providerSessionId = `${session.handle.providerSessionId ?? "process:unknown"}:thread:${value.thread_id}`;
      }
      yield normalizeCodexEvent(session.request, event);
    }
    const result = await this.awaitProcess(session);
    if (result.eventsTruncated) {
      yield normalized(session.request, sequence + 1, "warning", "Codex JSONL capture was truncated by the configured bound");
    }
  }

  async wait(handle: AttemptHandle): Promise<unknown> {
    const session = this.requiredSession(handle.attemptId);
    const processResult = await this.awaitProcess(session);
    const malformed = processResult.events.some((event) => event.malformed);
    if (malformed) {
      return invalidResult("Codex emitted malformed JSONL; terminal output is not trusted", processResult);
    }
    if (processResult.exitKind !== "normal" || processResult.exitCode !== 0) {
      return invalidResult(`Codex process did not exit normally with code 0 (${processResult.exitKind})`, processResult);
    }
    if (!existsSync(session.resultPath)) {
      return invalidResult("Codex exited without the required structured terminal result", processResult);
    }
    let raw: unknown;
    try {
      const bytes = readFileSync(session.resultPath);
      if (bytes.byteLength > 1024 * 1024) {
        return invalidResult("Codex structured result exceeded the 1 MiB bound", processResult);
      }
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      return invalidResult(`Codex structured result is unreadable: ${error instanceof Error ? error.message : "parse failed"}`, processResult);
    }
    if (containsLikelySecret(raw)) {
      writeFileSync(session.resultPath, `${JSON.stringify({ redacted: true, reason: "likely credential material rejected" })}\n`, { encoding: "utf8", mode: 0o600 });
      return invalidResult("Codex structured result contained likely credential material and was redacted", processResult);
    }
    try {
      const parsed = parseExecutorResult(raw);
      assertResultScope(parsed, session.request);
      return normalizeTerminalResult(parsed, session.request, this.descriptor ?? this.probe(), processResult);
    } catch (error) {
      return invalidResult(`Codex structured result failed runtime validation: ${error instanceof Error ? error.message : "invalid result"}`, processResult);
    }
  }

  cancel(handle: AttemptHandle, reason: string): CancelOutcome {
    const session = this.sessions.get(handle.attemptId);
    if (session === undefined) {
      return { outcome: "unknown", summary: `no live owned process exists for ${handle.attemptId}: ${reason}` };
    }
    const outcome = session.process.cancel();
    if (outcome.outcome === "already_terminal") {
      return { outcome: "already_terminal", summary: outcome.summary };
    }
    return {
      outcome: "unknown",
      summary: `${outcome.summary}; signal delivery is not terminal-process certainty (${outcome.processTreeEvidence})`,
    };
  }

  async reconcile(identity: { runId: ExecutionRequest["runId"]; taskId: ExecutionRequest["taskId"]; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    const live = this.sessions.get(identity.attemptId);
    if (live !== undefined) {
      const settled = await this.awaitProcess(live);
      if (
        settled.cancellationRequested
        && (settled.gracefulSignalSent || settled.forcedSignalSent)
        && settled.processTreeEvidence === "group_absent_after_exit"
        && (settled.exitKind === "signal" || settled.exitKind === "timeout" || settled.exitCode !== 0)
      ) {
        return {
          outcome: "terminal",
          result: cancellationResult(live.request, this.descriptor?.adapterVersion ?? "unknown", settled),
          summary: "owned supervisor observed the cancellation-requested process terminate",
        };
      }
      const result = await this.wait(live.handle);
      try {
        return { outcome: "terminal", result: parseExecutorResult(result), summary: "owned supervisor observed a valid terminal result" };
      } catch {
        return { outcome: "unknown", summary: "owned process is terminal but its terminal contract is not valid" };
      }
    }
    const directory = join(this.attemptsRoot, String(identity.attemptId));
    const metadataPath = join(directory, "process.json");
    if (!existsSync(metadataPath)) {
      return { outcome: "not_found", summary: "no durable Codex process identity exists for the attempt" };
    }
    let metadata: RecoveryProcessMetadata;
    try {
      metadata = readRecoveryMetadata(metadataPath, identity);
    } catch (error) {
      return { outcome: "unknown", summary: error instanceof Error ? error.message : "durable Codex process metadata is invalid" };
    }
    if (!processGroupIsAbsent(metadata.pid, metadata.processGroup)) {
      return { outcome: "unknown", summary: "the durable Codex process group may still exist; terminal output cannot be trusted after restart" };
    }
    const resultPath = join(directory, "executor-result.json");
    if (!existsSync(resultPath)) {
      return { outcome: "unknown", summary: "process identity exists but no terminal result can be proven after restart" };
    }
    try {
      const bytes = readFileSync(resultPath);
      if (bytes.byteLength > 1024 * 1024) {
        return { outcome: "unknown", summary: "durable result exceeds the recovery size bound" };
      }
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      if (containsLikelySecret(raw)) {
        writeFileSync(resultPath, `${JSON.stringify({ redacted: true, reason: "likely credential material rejected" })}\n`, { encoding: "utf8", mode: 0o600 });
        return { outcome: "unknown", summary: "durable result contained likely credential material and was redacted" };
      }
      const parsed = parseExecutorResult(raw);
      if (parsed.runId !== identity.runId || parsed.taskId !== identity.taskId || parsed.attemptId !== identity.attemptId) {
        return { outcome: "unknown", summary: "durable terminal result identity does not match the recovery request" };
      }
      return {
        outcome: "terminal",
        result: {
          ...parsed,
          executor: {
            adapter: "codex",
            adapterVersion: metadata.adapterVersion,
            provider: "openai",
            model: metadata.model,
            ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
          },
          exit: { kind: "unknown", detail: "recorded process group is absent; exact post-restart exit status is unavailable" },
        },
        summary: "durable schema-valid terminal result recovered after proving the recorded process group absent",
      };
    } catch {
      return { outcome: "unknown", summary: "durable result exists but is malformed or incompatible" };
    }
  }

  async processEvidence(attemptId: AttemptId): Promise<ProcessResult | undefined> {
    const session = this.sessions.get(attemptId);
    return session === undefined ? undefined : this.awaitProcess(session);
  }

  private async awaitProcess(session: CodexSession): Promise<ProcessResult> {
    if (session.processResult === undefined) {
      session.processResult = await session.process.completion;
      writeFileSync(join(session.directory, "process-result.json"), `${JSON.stringify(durableProcessEvidence(session.processResult))}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    return session.processResult;
  }

  private requiredSession(attemptId: AttemptId): CodexSession {
    const session = this.sessions.get(attemptId);
    if (session === undefined) {
      throw new KerbsFlowError("ATTEMPT_HANDLE_MISSING", `no live Codex session exists for ${attemptId}`);
    }
    return session;
  }

  private runProbe(args: string[], label: string): string {
    const result = spawnSync(this.options.cliPath, args, {
      encoding: "utf8",
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
      throw new KerbsFlowError("CODEX_PROBE_FAILED", `Codex ${label} probe failed: ${detail.slice(0, 2000)}`);
    }
    return `${result.stdout}\n${result.stderr}`.trim();
  }
}

interface RecoveryProcessMetadata {
  pid: number;
  processGroup: "owned_posix_group" | "single_process_only";
  adapterVersion: string;
  model: string;
  reasoning?: string;
}

function readRecoveryMetadata(
  path: string,
  identity: { runId: ExecutionRequest["runId"]; taskId: ExecutionRequest["taskId"]; attemptId: AttemptId },
): RecoveryProcessMetadata {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const processIdentity = raw.process as Record<string, unknown> | undefined;
    if (
      raw.schemaVersion !== "kerbsflow.codex-process/v1"
      || raw.runId !== identity.runId
      || raw.taskId !== identity.taskId
      || raw.attemptId !== identity.attemptId
      || typeof processIdentity !== "object"
      || processIdentity === null
      || !Number.isSafeInteger(processIdentity.pid)
      || Number(processIdentity.pid) <= 0
      || (processIdentity.processGroup !== "owned_posix_group" && processIdentity.processGroup !== "single_process_only")
      || typeof raw.adapterVersion !== "string"
      || typeof raw.model !== "string"
      || (raw.reasoning !== undefined && typeof raw.reasoning !== "string")
    ) {
      throw new Error("metadata fields are invalid or do not match the recovery request");
    }
    return {
      pid: Number(processIdentity.pid),
      processGroup: processIdentity.processGroup,
      adapterVersion: raw.adapterVersion,
      model: raw.model,
      ...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning as string }),
    };
  } catch (error) {
    throw new KerbsFlowError("CODEX_RECOVERY_METADATA_INVALID", `durable Codex process metadata is invalid: ${error instanceof Error ? error.message : "parse failed"}`);
  }
}

function processGroupIsAbsent(pid: number, processGroup: RecoveryProcessMetadata["processGroup"]): boolean {
  try {
    process.kill(processGroup === "owned_posix_group" ? -pid : pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

function durableProcessEvidence(result: ProcessResult): Record<string, unknown> {
  return {
    identity: result.identity,
    exitCode: result.exitCode,
    signal: result.signal,
    exitKind: result.exitKind,
    stdoutBytesCaptured: Buffer.byteLength(result.stdout),
    stdoutBytesObserved: result.stdoutBytesObserved,
    stderrBytesObserved: result.stderrBytesObserved,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    eventsTruncated: result.eventsTruncated,
    eventBytesObserved: result.eventBytesObserved,
    events: result.events.map((event) => ({
      sequence: event.sequence,
      observedAt: event.observedAt,
      malformed: event.malformed,
      type: typeof event.value === "object" && event.value !== null && typeof (event.value as Record<string, unknown>).type === "string"
        ? (event.value as Record<string, unknown>).type
        : "unknown",
    })),
    endedAt: result.endedAt,
    cancellationRequested: result.cancellationRequested,
    gracefulSignalSent: result.gracefulSignalSent,
    forcedSignalSent: result.forcedSignalSent,
    processTreeEvidence: result.processTreeEvidence,
    ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
  };
}

function normalizeTerminalResult(
  result: ExecutorResult,
  request: ExecutionRequest,
  descriptor: AdapterDescriptor,
  processResult: ProcessResult,
): ExecutorResult {
  return {
    ...result,
    executor: {
      adapter: "codex",
      adapterVersion: descriptor.adapterVersion,
      provider: "openai",
      model: request.model,
      ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    },
    exit: {
      kind: processResult.exitKind,
      ...(processResult.exitCode === null ? {} : { code: processResult.exitCode }),
      ...(processResult.signal === null ? {} : { signal: processResult.signal }),
    },
  };
}

function cancellationResult(request: ExecutionRequest, adapterVersion: string, processResult: ProcessResult): ExecutorResult {
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: request.runId,
    taskId: request.taskId,
    attemptId: request.attemptId,
    executor: {
      adapter: "codex",
      adapterVersion,
      provider: "openai",
      model: request.model,
      ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    },
    outcome: "cancelled",
    failureClass: "cancelled",
    scopeClaim: "unknown",
    summary: "the owned Codex process terminated after a durable cancellation request",
    filesChanged: [],
    checks: [],
    evidence: [{
      schemaVersion: CONTRACT_VERSIONS.validation,
      id: asValidationId(`validation_cancel_${request.attemptId}`),
      kind: "event",
      classification: "automatically_tested",
      summary: `supervisor observed ${processResult.exitKind}${processResult.signal === null ? "" : ` (${processResult.signal})`}; ${processResult.processTreeEvidence}`,
    }],
    invariantViolations: [],
    risks: processResult.processTreeEvidence === "group_absent_after_exit" ? [] : ["complete process-group termination was not proven"],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "fail",
    exit: {
      kind: processResult.exitKind,
      ...(processResult.exitCode === null ? {} : { code: processResult.exitCode }),
      ...(processResult.signal === null ? {} : { signal: processResult.signal }),
    },
  };
}

function normalizeCodexEvent(request: ExecutionRequest, event: RawProcessEvent): NormalizedEvent {
  if (event.malformed || typeof event.value !== "object" || event.value === null) {
    return normalized(request, event.sequence, "warning", "Codex emitted a malformed JSONL event");
  }
  const object = event.value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type : "unknown";
  const mapping: Record<string, NormalizedEvent["kind"]> = {
    "thread.started": "started",
    "turn.started": "progress",
    "item.started": "tool",
    "item.completed": "progress",
    "turn.completed": "completed",
    "turn.failed": "failed",
    error: "failed",
  };
  const kind = mapping[type] ?? "warning";
  return normalized(request, event.sequence, kind, mapping[type] === undefined ? `Unknown Codex event type: ${type}` : `Codex event: ${type}`);
}

function normalized(request: ExecutionRequest, sequence: number, kind: NormalizedEvent["kind"], summary: string): NormalizedEvent {
  return {
    schemaVersion: CONTRACT_VERSIONS.normalizedEvent,
    runId: request.runId,
    attemptId: request.attemptId,
    sequence,
    providerTimestamp: new Date().toISOString(),
    kind,
    summary,
  };
}

function assertResultScope(result: ExecutorResult, request: ExecutionRequest): void {
  if (result.runId !== request.runId || result.taskId !== request.taskId || result.attemptId !== request.attemptId) {
    throw new KerbsFlowError("RESULT_SCOPE_MISMATCH", "Codex result IDs do not match the supervised request");
  }
}

function invalidResult(summary: string, processResult: ProcessResult): Record<string, unknown> {
  return {
    schemaVersion: "kerbsflow.executor-result/invalid",
    summary,
    process: {
      exitKind: processResult.exitKind,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
    },
  };
}

function safeConfigToken(value: string): string {
  if (!/^[a-z0-9_-]+$/u.test(value)) {
    throw new KerbsFlowError("CODEX_CONFIG_INVALID", "reasoning effort contains unsupported characters");
  }
  return value;
}

function containsLikelySecret(value: unknown, key = ""): boolean {
  if (/token|secret|password|authorization|api[_-]?key/iu.test(key)) {
    return typeof value === "string" && value.length > 0;
  }
  if (typeof value === "string") {
    return /\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[^\s]+/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsLikelySecret(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([entryKey, entryValue]) => containsLikelySecret(entryValue, entryKey));
  }
  return false;
}

const stringArray = { type: "array", items: { type: "string" } } as const;
const emptyArtifactIdArray = { type: "array", maxItems: 0, items: { type: "string", pattern: "^artifact_" } } as const;
const evidence = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", const: CONTRACT_VERSIONS.validation },
    id: { type: "string", pattern: "^validation_" },
    kind: { type: "string", enum: ["command", "diff", "check", "review", "event", "result", "other"] },
    classification: { type: "string", enum: ["automatically_tested", "manually_validated", "inspected", "inferred", "simulated", "not_tested"] },
    summary: { type: "string" },
  },
  required: ["schemaVersion", "id", "kind", "classification", "summary"],
  additionalProperties: false,
} as const;
const check = {
  type: "object",
  properties: {
    name: { type: "string" },
    outcome: { type: "string", enum: ["passed", "failed", "skipped", "not_run", "unknown"] },
    evidenceClass: { type: "string", enum: ["automatically_tested", "manually_validated", "inspected", "inferred", "simulated", "not_tested"] },
    evidenceRefs: emptyArtifactIdArray,
  },
  required: ["name", "outcome", "evidenceClass", "evidenceRefs"],
  additionalProperties: false,
} as const;

export const EXECUTOR_RESULT_JSON_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", const: CONTRACT_VERSIONS.executorResult },
    runId: { type: "string", pattern: "^run_" },
    taskId: { type: "string", pattern: "^task_" },
    attemptId: { type: "string", pattern: "^attempt_" },
    executor: {
      type: "object",
      properties: {
        adapter: { type: "string" },
        adapterVersion: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      required: ["adapter", "adapterVersion", "provider", "model"],
      additionalProperties: false,
    },
    outcome: { type: "string", enum: ["succeeded", "failed", "blocked", "partial", "cancelled"] },
    failureClass: { type: ["string", "null"], enum: ["executor_error", "implementation_failure", "validation_failure", "scope_violation", "invariant_violation", "environment_or_tool_failure", "requirement_or_architecture_ambiguity", "security_or_privilege_gate", "repeated_loop", "cancelled", "unknown", null] },
    scopeClaim: { type: "string", enum: ["within_scope", "questionable", "violated", "unknown"] },
    summary: { type: "string" },
    filesChanged: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, change: { type: "string", enum: ["added", "modified", "deleted", "renamed", "unknown"] } },
        required: ["path", "change"],
        additionalProperties: false,
      },
    },
    checks: { type: "array", items: check },
    evidence: { type: "array", items: evidence },
    invariantViolations: stringArray,
    risks: stringArray,
    warnings: stringArray,
    artifacts: emptyArtifactIdArray,
    humanGate: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            schemaVersion: { type: "string", const: CONTRACT_VERSIONS.humanGate },
            gateId: { type: "string", pattern: "^gate_" },
            runId: { type: "string", pattern: "^run_" },
            taskId: { type: "string", pattern: "^task_" },
            attemptId: { type: "string", pattern: "^attempt_" },
            reasonCode: { type: "string" },
            summary: { type: "string" },
            evidenceRefs: emptyArtifactIdArray,
            options: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  consequence: { type: "string" },
                  target: { type: "string", enum: ["PLAN", "READY", "REWORK", "FINAL_VERIFY", "FAILED", "CANCELLED", "PAUSED"] },
                },
                required: ["id", "label", "consequence", "target"],
                additionalProperties: false,
              },
            },
            status: { type: "string", const: "open" },
          },
          required: ["schemaVersion", "gateId", "runId", "taskId", "attemptId", "reasonCode", "summary", "evidenceRefs", "options", "status"],
          additionalProperties: false,
        },
      ],
    },
    recommendedNext: { type: "string", enum: ["verify_focused", "rework", "escalate", "human_gate", "fail"] },
    exit: {
      type: "object",
      properties: { kind: { type: "string", enum: ["normal", "signal", "spawn_error", "timeout", "protocol_error", "unknown"] }, code: { type: "integer" } },
      required: ["kind", "code"],
      additionalProperties: false,
    },
  },
  required: ["schemaVersion", "runId", "taskId", "attemptId", "executor", "outcome", "failureClass", "scopeClaim", "summary", "filesChanged", "checks", "evidence", "invariantViolations", "risks", "warnings", "artifacts", "humanGate", "recommendedNext", "exit"],
  additionalProperties: false,
} as const;
