import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AdapterRoutingReadiness, ExecutorAdapter } from "./adapter.js";
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
  type RunId,
  type TaskId,
  parseExecutionRequest,
  parseExecutorResult,
} from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import { containsLikelySecret } from "./secrets.js";

export const OPENCODE_SDK_VERSION = "2.0.13";
export const OPENCODE_AGENT = "kerbsflow";
export const OPENCODE_RESULT_START = "KERBSFLOW_EXECUTOR_RESULT_V1";
export const OPENCODE_RESULT_END = "KERBSFLOW_EXECUTOR_RESULT_END";

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export const OPENCODE_EXECUTOR_PERMISSIONS: readonly OpenCodePermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "read", resource: ".env", effect: "deny" },
  { action: "read", resource: ".env.*", effect: "deny" },
  { action: "read", resource: "*/.env", effect: "deny" },
  { action: "read", resource: "*/.env.*", effect: "deny" },
  { action: "edit", resource: ".env", effect: "deny" },
  { action: "edit", resource: ".env.*", effect: "deny" },
  { action: "edit", resource: "*/.env", effect: "deny" },
  { action: "edit", resource: "*/.env.*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
] as const;

export interface OpenCodeModelInfo {
  id: string;
  modelID?: string;
  providerID: string;
  name: string;
  enabled: boolean;
  status: "alpha" | "beta" | "deprecated" | "active";
  variants: Array<{ id: string }>;
}

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
}

interface OpenCodeSessionInfo {
  id: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  metadata?: Record<string, unknown>;
}

interface OpenCodeRequestOptions {
  signal?: AbortSignal;
}

export interface OpenCodeHostBoundary {
  server: {
    info(options?: OpenCodeRequestOptions): Promise<{ version: string; pid: number; urls: string[]; paths: { tmp: string } }>;
  };
  sessions: {
    create(input: {
      title: string;
      agent: string;
      model: { id: string; providerID: string; variant?: string };
      location: { directory: string };
      metadata: Record<string, string>;
      permissions: readonly OpenCodePermissionRule[];
    }, options?: OpenCodeRequestOptions): Promise<OpenCodeSessionInfo>;
    prompt(input: { sessionID: string; text: string }, options?: OpenCodeRequestOptions): Promise<unknown>;
    wait(input: { sessionID: string }, options?: OpenCodeRequestOptions): Promise<void>;
    get(input: { sessionID: string }, options?: OpenCodeRequestOptions): Promise<OpenCodeSessionInfo>;
    list(input?: { limit?: number; order?: "asc" | "desc"; directory?: string; cursor?: string }, options?: OpenCodeRequestOptions): Promise<{ data: OpenCodeSessionInfo[]; cursor?: { previous?: string; next?: string } }>;
    context(input: { sessionID: string }, options?: OpenCodeRequestOptions): Promise<unknown[]>;
    log(input: { sessionID: string; after?: number; follow?: boolean }, options?: OpenCodeRequestOptions): AsyncIterable<unknown>;
    interrupt(input: { sessionID: string; resume?: boolean }, options?: OpenCodeRequestOptions): Promise<{ interrupted: boolean }>;
  };
  permission: {
    create(input: { sessionID: string; action: string; resources: readonly string[] }, options?: OpenCodeRequestOptions): Promise<{ id: string; effect: "allow" | "deny" | "ask" }>;
  };
  provider: {
    list(input?: { location?: { directory?: string } }, options?: OpenCodeRequestOptions): Promise<{ data: OpenCodeProviderInfo[] }>;
  };
  model: {
    list(input?: { location?: { directory?: string } }, options?: OpenCodeRequestOptions): Promise<{ data: OpenCodeModelInfo[] }>;
  };
  close(): Promise<void>;
}

export interface OpenCodeHostCreateOptions {
  app: { name: string; version: string };
  database: { path: string };
  events: { persist: boolean };
  config: { project: boolean; content: string };
  fs: { filewatcher: boolean };
}

export type OpenCodeHostFactory = (options: OpenCodeHostCreateOptions) => Promise<OpenCodeHostBoundary>;

export interface OpenCodeAdapterOptions {
  runtimeRoot: string;
  createHost?: OpenCodeHostFactory;
  hostIdentity?: string;
  now?: () => string;
  closePreparationTimeoutMs?: number;
}

export interface OpenCodeReadiness {
  ready: boolean;
  providers: OpenCodeProviderInfo[];
  models: OpenCodeModelInfo[];
  reason: string;
}

interface SelectedModel {
  providerID: string;
  id: string;
  variant?: string;
  display: string;
}

interface OpenCodeAttempt {
  request: ExecutionRequest;
  handle: AttemptHandle;
  abort: AbortController;
  session?: OpenCodeSessionInfo;
  selectedModel?: SelectedModel;
  preparation: Promise<void>;
  terminalEventObserved: boolean;
  streamEndedPrematurely: boolean;
  cancelPromise?: Promise<boolean>;
}

const OPENCODE_SDK_PACKAGE: string = "@opencode/sdk";
const DEFAULT_HOST_FACTORY: OpenCodeHostFactory = async (options) => {
  const sdk = await import(OPENCODE_SDK_PACKAGE) as unknown as {
    OpenCode: { create(value: OpenCodeHostCreateOptions): Promise<OpenCodeHostBoundary> };
  };
  return sdk.OpenCode.create(options);
};

export function openCodeHostConfiguration(): Record<string, unknown> {
  const policies = [
    "external_directory:*",
    "shell:*",
    "webfetch:*",
    "websearch:*",
    "subagent:*",
    "skill:*",
    "question:*",
    "execute:*",
  ].map((resource) => ({ action: "permission", resource, effect: "deny" }));
  return {
    websearch: false,
    plugins: [],
    mcp: {},
    skills: [],
    commands: {},
    instructions: [],
    formatter: false,
    lsp: false,
    permissions: OPENCODE_EXECUTOR_PERMISSIONS,
    agents: {
      [OPENCODE_AGENT]: {
        description: "KerbsFlow-owned bounded implementation executor",
        mode: "primary",
        permissions: OPENCODE_EXECUTOR_PERMISSIONS,
      },
    },
    experimental: { policies },
  };
}

export class OpenCodeAdapter implements ExecutorAdapter {
  private readonly createHost: OpenCodeHostFactory;
  private readonly hostIdentity: string;
  private readonly now: () => string;
  private readonly closePreparationTimeoutMs: number;
  private readonly root: string;
  private readonly databasePath: string;
  private readonly attempts = new Map<string, OpenCodeAttempt>();
  private hostPromise: Promise<OpenCodeHostBoundary> | undefined;
  private closePromise: Promise<void> | undefined;
  private lifecycle: "open" | "closing" | "closed" = "open";
  private generation = 0;

  constructor(options: OpenCodeAdapterOptions) {
    this.createHost = options.createHost ?? DEFAULT_HOST_FACTORY;
    this.hostIdentity = options.hostIdentity ?? randomUUID();
    this.now = options.now ?? (() => new Date().toISOString());
    this.closePreparationTimeoutMs = options.closePreparationTimeoutMs ?? 1000;
    if (!Number.isSafeInteger(this.closePreparationTimeoutMs) || this.closePreparationTimeoutMs < 1) {
      throw new KerbsFlowError("OPENCODE_CLOSE_TIMEOUT_INVALID", "OpenCode close preparation timeout must be a positive integer");
    }
    this.root = resolve(options.runtimeRoot, "opencode");
    this.databasePath = join(this.root, "sessions.sqlite");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  probe(): AdapterDescriptor {
    return {
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "opencode",
      provider: "provider-selected",
      adapterVersion: OPENCODE_SDK_VERSION,
      capabilities: {
        eventTransport: "async_iterable",
        finalJsonSchema: false,
        modelSelection: true,
        reasoningEffort: [],
        agentSelection: true,
        filesystemEnforcement: "tool_policy_only",
        network: { providerControlPlane: "provider_owned", workload: "tool_policy_only" },
        cancellation: "native",
        resumableSession: true,
        authentication: { owner: "provider", mode: "opencode credential store/environment" },
        healthProbe: true,
      },
    };
  }

  async readiness(workingDirectory: string): Promise<OpenCodeReadiness> {
    const host = await this.host();
    const [providers, models] = await Promise.all([
      host.provider.list({ location: { directory: workingDirectory } }),
      host.model.list({ location: { directory: workingDirectory } }),
    ]);
    const enabled = models.data.filter((model) => model.enabled && model.status !== "deprecated");
    return {
      ready: enabled.length > 0,
      providers: providers.data.map(safeProviderMetadata),
      models: enabled.map(safeModelMetadata),
      reason: enabled.length > 0 ? "OpenCode reports at least one enabled provider model" : "OpenCode reports no enabled provider model",
    };
  }

  async routingReadiness(workingDirectory: string): Promise<AdapterRoutingReadiness> {
    const readiness = await this.readiness(workingDirectory);
    return {
      ready: readiness.ready,
      models: readiness.models.map((model) => ({
        provider: model.providerID,
        model: `${model.providerID}/${model.id}`,
        aliases: [model.id, ...(model.modelID === undefined ? [] : [model.modelID])],
        reasoning: model.variants.map((variant) => variant.id),
      })),
      reason: readiness.reason,
    };
  }

  start(value: ExecutionRequest): AttemptHandle {
    if (this.lifecycle !== "open") throw new KerbsFlowError("OPENCODE_ADAPTER_CLOSING", "OpenCodeAdapter does not accept work after close begins");
    const request = parseExecutionRequest(value);
    if (request.permissionPolicy.filesystem !== "worktree_only" || request.permissionPolicy.network !== "denied") {
      throw new KerbsFlowError("OPENCODE_POLICY_UNSUPPORTED", "OpenCodeAdapter accepts only worktree-only filesystem and denied workload-network requests");
    }
    if (this.attempts.has(request.attemptId)) {
      throw new KerbsFlowError("DUPLICATE_ATTEMPT", `OpenCode attempt ${request.attemptId} is already known`);
    }
    const handle: AttemptHandle = {
      schemaVersion: CONTRACT_VERSIONS.attemptHandle,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      providerSessionId: this.pendingIdentity(request.attemptId),
    };
    const attempt: OpenCodeAttempt = {
      request,
      handle,
      abort: new AbortController(),
      preparation: Promise.resolve(),
      terminalEventObserved: false,
      streamEndedPrematurely: false,
    };
    attempt.preparation = this.prepare(attempt);
    attempt.preparation.catch(() => undefined);
    this.attempts.set(request.attemptId, attempt);
    return handle;
  }

  async *events(handle: AttemptHandle): AsyncIterable<NormalizedEvent> {
    const attempt = this.requiredAttempt(handle);
    let sequence = 0;
    try {
      await attempt.preparation;
    } catch (error) {
      yield normalized(attempt, ++sequence, "failed", `OpenCode session preparation failed: ${message(error)}`, this.now());
      return;
    }
    const sessionID = attempt.session?.id;
    if (sessionID === undefined) {
      yield normalized(attempt, ++sequence, "failed", "OpenCode did not provide a session identity", this.now());
      return;
    }
    const streamAbort = new AbortController();
    const seen = new Set<string>();
    let providerSequence: number | undefined;
    try {
      for await (const raw of (await this.host()).sessions.log({ sessionID, after: 0, follow: true }, { signal: streamAbort.signal })) {
        const event = eventRecord(raw);
        if (event === undefined) {
          yield normalized(attempt, ++sequence, "warning", "OpenCode emitted a malformed event", this.now());
          continue;
        }
        const eventID = typeof event.id === "string" ? event.id : undefined;
        if (eventID !== undefined && seen.has(eventID)) {
          yield normalized(attempt, ++sequence, "warning", `OpenCode duplicate event ignored: ${eventID}`, providerTimestamp(event, this.now()));
          continue;
        }
        if (eventID !== undefined) seen.add(eventID);
        const durable = recordOrUndefined(event.durable);
        const nextProviderSequence = durable === undefined || !Number.isSafeInteger(durable.seq) ? undefined : Number(durable.seq);
        if (providerSequence !== undefined && nextProviderSequence !== undefined && nextProviderSequence > providerSequence + 1) {
          yield normalized(attempt, ++sequence, "warning", `OpenCode durable event gap detected after ${providerSequence}`, providerTimestamp(event, this.now()));
        }
        if (nextProviderSequence !== undefined) providerSequence = Math.max(providerSequence ?? 0, nextProviderSequence);
        const type = typeof event.type === "string" ? event.type : "unknown";
        const eventSessionID = sessionIdFromEvent(event);
        if (eventSessionID !== undefined && eventSessionID !== sessionID) {
          yield normalized(attempt, ++sequence, "warning", "OpenCode event session identity did not match the active attempt", providerTimestamp(event, this.now()));
          continue;
        }
        const kind = normalizedKind(type);
        if (kind === "completed" || kind === "failed") attempt.terminalEventObserved = true;
        yield normalized(attempt, ++sequence, kind, eventSummary(type), providerTimestamp(event, this.now()));
        if (kind === "completed" || kind === "failed") return;
      }
      attempt.streamEndedPrematurely = !attempt.terminalEventObserved;
      if (attempt.streamEndedPrematurely) {
        yield normalized(attempt, ++sequence, "warning", "OpenCode event stream ended before terminal session evidence", this.now());
      }
    } catch (error) {
      if (!streamAbort.signal.aborted) {
        attempt.streamEndedPrematurely = true;
        yield normalized(attempt, ++sequence, "warning", `OpenCode event stream failed: ${message(error)}`, this.now());
      }
    } finally {
      streamAbort.abort();
    }
  }

  async wait(handle: AttemptHandle): Promise<unknown> {
    const attempt = this.requiredAttempt(handle);
    try {
      await attempt.preparation;
      const sessionID = attempt.session?.id;
      if (sessionID === undefined) throw new Error("session identity is unavailable");
      const host = await this.host();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        attempt.abort.abort();
        attempt.cancelPromise = host.sessions.interrupt({ sessionID }).then((value) => value.interrupted).catch(() => false);
      }, attempt.request.timeoutMs);
      try {
        await host.sessions.wait({ sessionID }, { signal: attempt.abort.signal });
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new Error("OpenCode execution timed out and requires cancellation reconciliation");
      const session = await host.sessions.get({ sessionID });
      attempt.session = session;
      if (session.outcome === "interrupted") return this.cancelledResult(attempt, "OpenCode session interruption is terminal");
      if (session.outcome === "failed") return this.failureResult(attempt, "OpenCode session terminated with provider failure");
      if (session.outcome !== "succeeded") throw new Error("OpenCode session has no proven terminal outcome");
      const context = await host.sessions.context({ sessionID });
      return this.extractResult(attempt, context);
    } catch (error) {
      return invalidResult(message(error));
    }
  }

  cancel(handle: AttemptHandle, reason: string): CancelOutcome {
    const attempt = this.attempts.get(handle.attemptId);
    if (attempt === undefined) return { outcome: "unknown", summary: `OpenCode attempt is not locally known: ${reason}` };
    attempt.abort.abort();
    const sessionID = attempt.session?.id;
    if (sessionID === undefined) return { outcome: "unknown", summary: "OpenCode abort requested before a durable session identity was available" };
    attempt.cancelPromise = this.host()
      .then((host) => host.sessions.interrupt({ sessionID }))
      .then((value) => value.interrupted)
      .catch(() => false);
    return { outcome: "unknown", summary: "OpenCode native interrupt was requested; terminal status requires reconciliation" };
  }

  async reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    try {
      const host = await this.host();
      const local = this.attempts.get(identity.attemptId);
      if (local !== undefined) {
        try { await local.preparation; } catch { /* Session lookup below is authoritative. */ }
        if (local.cancelPromise !== undefined) await local.cancelPromise;
      }
      const known = local?.session;
      const session = known ?? await this.findSession(host, identity);
      if (session === undefined) {
        return { outcome: "not_found", summary: "persistent OpenCode state contains no session for this exact attempt identity" };
      }
      const current = await host.sessions.get({ sessionID: session.id });
      if (current.outcome === undefined) return { outcome: "running", summary: `OpenCode session ${session.id} remains nonterminal` };
      const attempt = local ?? this.recoveredAttempt(identity, current);
      if (current.outcome === "interrupted") {
        return { outcome: "terminal", result: this.cancelledResult(attempt, "persistent OpenCode session proves interruption"), summary: "OpenCode session is terminally interrupted" };
      }
      if (current.outcome === "failed") {
        return { outcome: "terminal", result: this.failureResult(attempt, "persistent OpenCode session proves provider failure"), summary: "OpenCode session is terminally failed" };
      }
      const context = await host.sessions.context({ sessionID: current.id });
      const result = this.extractResult(attempt, context);
      return { outcome: "terminal", result, summary: "OpenCode session and exact structured result are terminal" };
    } catch (error) {
      return { outcome: "unknown", summary: `OpenCode reconciliation could not prove state: ${message(error)}` };
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.lifecycle === "closed") return Promise.resolve();
    this.lifecycle = "closing";
    this.closePromise = this.closeOwnedHost();
    return this.closePromise;
  }

  private async closeOwnedHost(): Promise<void> {
    for (const attempt of this.attempts.values()) attempt.abort.abort();
    const hostPromise = this.hostPromise;
    if (hostPromise === undefined) {
      this.lifecycle = "closed";
      return;
    }
    const hostSettlement = await boundedSettlement(hostPromise, this.closePreparationTimeoutMs);
    if (hostSettlement.status !== "fulfilled") {
      this.lifecycle = "closed";
      this.hostPromise = undefined;
      if (hostSettlement.status === "pending") {
        void hostPromise.then((host) => host.close()).catch(() => undefined);
        throw new KerbsFlowError("OPENCODE_CLOSE_UNCERTAIN", "OpenCode host creation did not settle before the close coordination deadline");
      }
      throw new KerbsFlowError("OPENCODE_CLOSE_UNCERTAIN", `OpenCode host creation failed during close: ${message(hostSettlement.reason)}`);
    }
    const host = hostSettlement.value;
    const uncertain: string[] = [];
    for (const attempt of this.attempts.values()) {
      const preparation = await boundedSettlement(attempt.preparation, this.closePreparationTimeoutMs);
      let session = attempt.session;
      try {
        session ??= await this.findSession(host, attempt.request);
      } catch {
        uncertain.push(attempt.request.attemptId);
        continue;
      }
      if (session === undefined) {
        if (preparation.status === "pending") uncertain.push(attempt.request.attemptId);
        continue;
      }
      attempt.session = session;
      try {
        let current = await host.sessions.get({ sessionID: session.id });
        if (current.outcome === undefined) {
          const outcome = await host.sessions.interrupt({ sessionID: session.id });
          current = outcome.interrupted ? await host.sessions.get({ sessionID: session.id }) : current;
        }
        if (current.outcome === undefined) uncertain.push(attempt.request.attemptId);
        else attempt.session = current;
      } catch {
        uncertain.push(attempt.request.attemptId);
      }
    }
    try {
      await host.close();
    } catch (error) {
      this.hostPromise = undefined;
      this.lifecycle = "closed";
      throw new KerbsFlowError("OPENCODE_CLOSE_FAILED", `OpenCode embedded host close failed: ${message(error)}`);
    }
    this.hostPromise = undefined;
    this.lifecycle = "closed";
    if (uncertain.length > 0) {
      throw new KerbsFlowError("OPENCODE_CLOSE_UNCERTAIN", `OpenCode host closed with unproven active sessions: ${uncertain.join(", ")}`);
    }
  }

  private async host(): Promise<OpenCodeHostBoundary> {
    if (this.lifecycle !== "open") throw new KerbsFlowError("OPENCODE_ADAPTER_CLOSING", "OpenCode embedded host cannot open after close begins");
    if (this.hostPromise === undefined) {
      this.generation += 1;
      const options: OpenCodeHostCreateOptions = {
        app: { name: "kerbsflow", version: OPENCODE_SDK_VERSION },
        database: { path: this.databasePath },
        events: { persist: true },
        config: { project: false, content: JSON.stringify(openCodeHostConfiguration()) },
        fs: { filewatcher: false },
      };
      this.hostPromise = this.createHost(options).then(async (host) => {
        const info = await host.server.info();
        if (info.urls.length !== 0) {
          await host.close().catch(() => undefined);
          throw new KerbsFlowError("OPENCODE_LISTENER_UNEXPECTED", "embedded OpenCode host reported a listener URL");
        }
        return host;
      }).catch((error) => {
        this.hostPromise = undefined;
        throw error;
      });
    }
    return this.hostPromise;
  }

  private async prepare(attempt: OpenCodeAttempt): Promise<void> {
    const host = await this.host();
    const selected = await this.selectModel(host, attempt.request.workingDirectory, attempt.request.model, attempt.request.reasoning, attempt.abort.signal);
    attempt.selectedModel = selected;
    if (attempt.abort.signal.aborted) throw new Error("OpenCode preparation was aborted before session creation");
    const session = await host.sessions.create({
      title: `KerbsFlow ${attempt.request.attemptId}`,
      agent: OPENCODE_AGENT,
      model: {
        id: selected.id,
        providerID: selected.providerID,
        ...(selected.variant === undefined ? {} : { variant: selected.variant }),
      },
      location: { directory: attempt.request.workingDirectory },
      metadata: {
        kerbsflowRunId: attempt.request.runId,
        kerbsflowTaskId: attempt.request.taskId,
        kerbsflowAttemptId: attempt.request.attemptId,
        kerbsflowHostIdentity: this.hostIdentity,
        kerbsflowHostGeneration: String(this.generation),
        kerbsflowProviderID: selected.providerID,
        kerbsflowModelID: selected.id,
        ...(selected.variant === undefined ? {} : { kerbsflowModelVariant: selected.variant }),
      },
      permissions: OPENCODE_EXECUTOR_PERMISSIONS,
    }, { signal: attempt.abort.signal });
    attempt.session = session;
    attempt.handle.providerSessionId = this.sessionIdentity(session.id);
    await host.sessions.prompt({ sessionID: session.id, text: openCodePrompt(attempt.request) }, { signal: attempt.abort.signal });
  }

  private async selectModel(host: OpenCodeHostBoundary, directory: string, requested: string, reasoning: string | undefined, signal: AbortSignal): Promise<SelectedModel> {
    const output = await host.model.list({ location: { directory } }, { signal });
    const enabled = output.data.filter((model) => model.enabled && model.status !== "deprecated");
    const slash = requested.indexOf("/");
    const requestedProvider = slash < 0 ? undefined : requested.slice(0, slash);
    const requestedModel = slash < 0 ? requested : requested.slice(slash + 1);
    const matches = enabled.filter((model) =>
      (requestedProvider === undefined || model.providerID === requestedProvider)
      && (model.id === requestedModel || model.modelID === requestedModel || model.name === requestedModel),
    );
    if (matches.length !== 1) {
      throw new KerbsFlowError("OPENCODE_MODEL_UNAVAILABLE", `requested OpenCode model ${requested} did not resolve uniquely among enabled provider models`);
    }
    const model = matches[0]!;
    const variant = reasoning === undefined ? undefined : model.variants.find((candidate) => candidate.id === reasoning)?.id;
    if (reasoning !== undefined && variant === undefined) {
      throw new KerbsFlowError("OPENCODE_REASONING_UNAVAILABLE", `OpenCode model ${requested} does not advertise reasoning variant ${reasoning}`);
    }
    return {
      providerID: model.providerID,
      id: model.id,
      ...(variant === undefined ? {} : { variant }),
      display: `${model.providerID}/${model.id}`,
    };
  }

  private extractResult(attempt: OpenCodeAttempt, context: unknown[]): ExecutorResult {
    const texts: string[] = [];
    for (const value of context) {
      const message = recordOrUndefined(value);
      if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .map(recordOrUndefined)
        .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      if (text.length > 0) texts.push(text);
    }
    const candidate = texts.at(-1);
    if (candidate === undefined) throw new Error("terminal OpenCode context contains no assistant textual output");
    if (texts.slice(0, -1).some((text) => text.includes(OPENCODE_RESULT_START) || text.includes(OPENCODE_RESULT_END))) {
      throw new Error("terminal OpenCode context contains an earlier ambiguous result marker");
    }
    const trimmed = candidate.trim();
    const prefix = `${OPENCODE_RESULT_START}\n`;
    const suffix = `\n${OPENCODE_RESULT_END}`;
    if (
      occurrences(trimmed, OPENCODE_RESULT_START) !== 1
      || occurrences(trimmed, OPENCODE_RESULT_END) !== 1
      || !trimmed.startsWith(prefix)
      || !trimmed.endsWith(suffix)
    ) throw new Error("final assistant output is not exactly one structured ExecutorResult block");
    const json = trimmed.slice(prefix.length, -suffix.length);
    if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("structured OpenCode result exceeds the 1 MiB bound");
    const raw: unknown = JSON.parse(json);
    if (containsLikelySecret(raw)) throw new Error("structured OpenCode result contains likely credential material");
    const result = parseExecutorResult(raw);
    if (result.runId !== attempt.request.runId || result.taskId !== attempt.request.taskId || result.attemptId !== attempt.request.attemptId) {
      throw new Error("structured OpenCode result identity does not match the active attempt");
    }
    const selected = attempt.selectedModel;
    if (selected === undefined) throw new Error("OpenCode model identity is unavailable");
    return {
      ...result,
      executor: {
        adapter: "opencode",
        adapterVersion: OPENCODE_SDK_VERSION,
        provider: selected.providerID,
        model: selected.display,
        ...(selected.variant === undefined ? {} : { reasoning: selected.variant }),
      },
    };
  }

  private failureResult(attempt: OpenCodeAttempt, summary: string): ExecutorResult {
    return resultBase(attempt, "failed", "executor_error", summary, "rework", { kind: "unknown", detail: summary });
  }

  private cancelledResult(attempt: OpenCodeAttempt, summary: string): ExecutorResult {
    return resultBase(attempt, "cancelled", "cancelled", summary, "fail", { kind: "signal", detail: summary });
  }

  private async findSession(host: OpenCodeHostBoundary, identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<OpenCodeSessionInfo | undefined> {
    const matches: OpenCodeSessionInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const sessions = await host.sessions.list({ limit: 100, order: "desc", ...(cursor === undefined ? {} : { cursor }) });
      matches.push(...sessions.data.filter((session) =>
        session.metadata?.kerbsflowRunId === identity.runId
        && session.metadata?.kerbsflowTaskId === identity.taskId
        && session.metadata?.kerbsflowAttemptId === identity.attemptId,
      ));
      const next = sessions.cursor?.next;
      if (next === undefined) break;
      if (seenCursors.has(next)) throw new Error("OpenCode session pagination repeated a cursor");
      seenCursors.add(next);
      cursor = next;
    } while (true);
    if (matches.length > 1) throw new Error("multiple OpenCode sessions claim the same KerbsFlow attempt identity");
    return matches[0];
  }

  private recoveredAttempt(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }, session: OpenCodeSessionInfo): OpenCodeAttempt {
    const providerID = typeof session.metadata?.kerbsflowProviderID === "string" ? session.metadata.kerbsflowProviderID : undefined;
    const modelID = typeof session.metadata?.kerbsflowModelID === "string" ? session.metadata.kerbsflowModelID : undefined;
    const variant = typeof session.metadata?.kerbsflowModelVariant === "string" ? session.metadata.kerbsflowModelVariant : undefined;
    const request = parseExecutionRequest({
      schemaVersion: CONTRACT_VERSIONS.executionRequest,
      runId: identity.runId,
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      role: "implementation",
      workingDirectory: this.root,
      promptSummary: "recovered OpenCode attempt",
      model: "recovered/unknown",
      permissionPolicy: { filesystem: "worktree_only", network: "denied" },
      timeoutMs: 1000,
      expectedResultSchema: CONTRACT_VERSIONS.executorResult,
    });
    return {
      request,
      handle: { schemaVersion: CONTRACT_VERSIONS.attemptHandle, ...identity, providerSessionId: this.sessionIdentity(session.id) },
      abort: new AbortController(),
      session,
      ...(providerID === undefined || modelID === undefined ? {} : { selectedModel: { providerID, id: modelID, ...(variant === undefined ? {} : { variant }), display: `${providerID}/${modelID}` } }),
      preparation: Promise.resolve(),
      terminalEventObserved: true,
      streamEndedPrematurely: false,
    };
  }

  private requiredAttempt(handle: AttemptHandle): OpenCodeAttempt {
    const attempt = this.attempts.get(handle.attemptId);
    if (attempt === undefined || attempt.request.runId !== handle.runId || attempt.request.taskId !== handle.taskId) {
      throw new KerbsFlowError("OPENCODE_ATTEMPT_NOT_FOUND", `OpenCode attempt ${handle.attemptId} is not active with the supplied identity`);
    }
    return attempt;
  }

  private pendingIdentity(attemptId: AttemptId): string {
    return `opencode:${this.hostIdentity}:generation:${this.generation + 1}:pending:${attemptId}`;
  }

  private sessionIdentity(sessionID: string): string {
    return `opencode:${this.hostIdentity}:generation:${this.generation}:session:${sessionID}`;
  }
}

export function openCodePrompt(request: ExecutionRequest): string {
  return [
    request.promptSummary,
    "OpenCode transport constraints:",
    "- Shell, network tools, external directories, secrets, subagents, and interactive questions are unavailable.",
    "- Use only bounded read/search/edit tools inside the assigned worktree.",
    `- End with exactly ${OPENCODE_RESULT_START}, then one ExecutorResult v1 JSON object, then ${OPENCODE_RESULT_END}.`,
    "- Do not put prose or Markdown outside those terminal markers.",
  ].join("\n");
}

function resultBase(
  attempt: OpenCodeAttempt,
  outcome: "failed" | "cancelled",
  failureClass: "executor_error" | "cancelled",
  summary: string,
  recommendedNext: "rework" | "fail",
  exit: ExecutorResult["exit"],
): ExecutorResult {
  const selected = attempt.selectedModel;
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: attempt.request.runId,
    taskId: attempt.request.taskId,
    attemptId: attempt.request.attemptId,
    executor: {
      adapter: "opencode",
      adapterVersion: OPENCODE_SDK_VERSION,
      provider: selected?.providerID ?? "unknown",
      model: selected?.display ?? attempt.request.model,
      ...(selected?.variant === undefined ? {} : { reasoning: selected.variant }),
    },
    outcome,
    failureClass,
    scopeClaim: "unknown",
    summary,
    filesChanged: [],
    checks: [],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: ["Adapter-generated failure state; independent verification remains authoritative."],
    artifacts: [],
    humanGate: null,
    recommendedNext,
    exit,
  };
}

function invalidResult(summary: string): Record<string, string> {
  return { schemaVersion: "kerbsflow.executor-result/invalid", summary };
}

function normalized(attempt: OpenCodeAttempt, sequence: number, kind: NormalizedEvent["kind"], summary: string, providerTimestamp: string): NormalizedEvent {
  return {
    schemaVersion: CONTRACT_VERSIONS.normalizedEvent,
    runId: attempt.request.runId,
    attemptId: attempt.request.attemptId,
    sequence,
    providerTimestamp,
    kind,
    summary: summary.slice(0, 2000),
  };
}

function normalizedKind(type: string): NormalizedEvent["kind"] {
  if (type === "session.execution.started") return "started";
  if (type === "session.execution.succeeded") return "completed";
  if (type === "session.execution.failed" || type === "session.execution.interrupted" || type === "session.step.failed") return "failed";
  if (type.startsWith("session.tool.")) return "tool";
  if (type.startsWith("permission.")) return "permission";
  if (type === "log.synced" || type.startsWith("session.")) return "progress";
  return "warning";
}

function eventSummary(type: string): string {
  return type === "unknown" ? "OpenCode emitted an event without a recognized type" : `OpenCode event: ${type}`;
}

function providerTimestamp(event: Record<string, unknown>, fallback: string): string {
  if (typeof event.created !== "number" || !Number.isFinite(event.created)) return fallback;
  const date = new Date(event.created);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function sessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  const data = recordOrUndefined(event.data);
  return typeof data?.sessionID === "string" ? data.sessionID : undefined;
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  const record = recordOrUndefined(value);
  if (record === undefined || (record.type !== "log.synced" && typeof record.type !== "string")) return undefined;
  return record;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeProviderMetadata(provider: OpenCodeProviderInfo): OpenCodeProviderInfo {
  return { id: provider.id, name: provider.name, activation: provider.activation };
}

function safeModelMetadata(model: OpenCodeModelInfo): OpenCodeModelInfo {
  return {
    id: model.id,
    ...(model.modelID === undefined ? {} : { modelID: model.modelID }),
    providerID: model.providerID,
    name: model.name,
    enabled: model.enabled,
    status: model.status,
    variants: model.variants.map((variant) => ({ id: variant.id })),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown OpenCode error";
}

function occurrences(value: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

type PromiseSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "pending" };

async function boundedSettlement<T>(promise: Promise<T>, timeoutMs: number): Promise<PromiseSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<PromiseSettlement<T>, PromiseSettlement<T>>(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
      new Promise<PromiseSettlement<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
