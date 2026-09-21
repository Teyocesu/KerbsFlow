import { createHash } from "node:crypto";

import {
  AdapterDescriptor,
  AttemptHandle,
  AttemptId,
  CancelOutcome,
  CONTRACT_VERSIONS,
  ExecutionRequest,
  ExecutorResult,
  HumanGate,
  ReconcileOutcome,
  RunId,
  TaskId,
  ValidationEvidence,
  asArtifactId,
  asGateId,
  asValidationId,
  parseExecutorResult,
} from "./contracts.js";
import { Clock, IdSource } from "./runtime.js";

export type FakeScriptOutcome = "success" | "implementation_failure" | "blocked" | "malformed" | "uncertain" | "cancelled";

export interface ArtifactReference {
  artifactId: ReturnType<typeof asArtifactId>;
  runId: RunId;
  attemptId?: AttemptId;
  kind: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  redactionState: "not_applicable" | "redacted";
}

export class FakeArtifactStore {
  private readonly contents = new Map<string, string>();

  constructor(private readonly ids: IdSource) {}

  put(runId: RunId, kind: string, content: string, attemptId?: AttemptId): ArtifactReference {
    const artifactId = asArtifactId(this.ids.next("artifact"));
    const contentHash = createHash("sha256").update(content).digest("hex");
    const reference: ArtifactReference = {
      artifactId,
      runId,
      ...(attemptId === undefined ? {} : { attemptId }),
      kind,
      relativePath: `runs/${runId}/${artifactId}.fake`,
      contentHash,
      sizeBytes: Buffer.byteLength(content),
      redactionState: "not_applicable",
    };
    this.contents.set(artifactId, content);
    return reference;
  }

  get(artifactId: ReturnType<typeof asArtifactId>): string | undefined {
    return this.contents.get(artifactId);
  }
}

export class FakeAdapter {
  private readonly scripts = new Map<string, FakeScriptOutcome>();
  private readonly sessions = new Map<string, { request: ExecutionRequest; outcome?: unknown; cancelled: boolean }>();

  constructor(private readonly clock: Clock, private readonly ids: IdSource) {}

  probe(): AdapterDescriptor {
    return {
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "fake",
      provider: "synthetic",
      adapterVersion: "phase1",
      capabilities: {
        eventTransport: "async_iterable",
        finalJsonSchema: true,
        modelSelection: false,
        reasoningEffort: [],
        agentSelection: false,
        filesystemEnforcement: "unavailable",
        network: { providerControlPlane: "not_applicable", workload: "unavailable" },
        cancellation: "simulated",
        resumableSession: false,
        authentication: { owner: "none", mode: "none" },
        healthProbe: true,
      },
    };
  }

  script(taskId: TaskId, outcome: FakeScriptOutcome): void {
    this.scripts.set(taskId, outcome);
  }

  start(request: ExecutionRequest): AttemptHandle {
    const handle: AttemptHandle = {
      schemaVersion: CONTRACT_VERSIONS.attemptHandle,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
    };
    this.sessions.set(request.attemptId, { request, cancelled: false });
    return handle;
  }

  async *events(handle: AttemptHandle): AsyncIterable<import("./contracts.js").NormalizedEvent> {
    yield {
      schemaVersion: CONTRACT_VERSIONS.normalizedEvent,
      runId: handle.runId,
      attemptId: handle.attemptId,
      sequence: 1,
      providerTimestamp: this.clock.now(),
      kind: "started",
      summary: "fake attempt started",
    };
    const session = this.sessions.get(handle.attemptId);
    if (session?.cancelled === true) {
      yield {
        schemaVersion: CONTRACT_VERSIONS.normalizedEvent,
        runId: handle.runId,
        attemptId: handle.attemptId,
        sequence: 2,
        providerTimestamp: this.clock.now(),
        kind: "warning",
        summary: "fake attempt cancelled",
      };
    }
  }

  async wait(handle: AttemptHandle): Promise<unknown> {
    const session = this.sessions.get(handle.attemptId);
    if (session === undefined) {
      return {
        schemaVersion: "kerbsflow.executor-result/v0",
        runId: handle.runId,
        taskId: handle.taskId,
        attemptId: handle.attemptId,
      };
    }
    if (session.outcome !== undefined) {
      return session.outcome;
    }
    const scripted = this.scripts.get(handle.taskId) ?? "success";
    if (session.cancelled || scripted === "cancelled") {
      session.outcome = this.makeCancelledResult(handle);
    } else if (scripted === "malformed") {
      session.outcome = { schemaVersion: "kerbsflow.executor-result/v0", outcome: "succeeded" };
    } else if (scripted === "uncertain") {
      session.outcome = { schemaVersion: CONTRACT_VERSIONS.executorResult, runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, outcome: "failed", failureClass: "unknown" };
    } else {
      session.outcome = this.makeResult(handle, scripted);
    }
    return session.outcome;
  }

  cancel(handle: AttemptHandle, reason: string): CancelOutcome {
    const session = this.sessions.get(handle.attemptId);
    if (session === undefined) {
      return { outcome: "unknown", summary: `fake attempt not found: ${reason}` };
    }
    session.cancelled = true;
    return { outcome: "cancelled", summary: `fake attempt cancelled: ${reason}` };
  }

  async reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    const session = this.sessions.get(identity.attemptId);
    if (session === undefined) {
      return { outcome: "not_found", summary: "fake session is not present after restart" };
    }
    if (session.outcome !== undefined) {
      try {
        const result = parseExecutorResult(session.outcome);
        return { outcome: "terminal", result, summary: "fake session has a terminal scripted result" };
      } catch {
        return { outcome: "unknown", summary: "fake session has malformed terminal output" };
      }
    }
    return { outcome: "unknown", summary: "fake session cannot prove whether work happened" };
  }

  private makeResult(handle: AttemptHandle, scripted: Exclude<FakeScriptOutcome, "malformed" | "uncertain" | "cancelled">): ExecutorResult {
    const evidence = this.evidence(handle, scripted === "success" ? "fake success" : "fake implementation failure");
    if (scripted === "blocked") {
      const gate: HumanGate = {
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(this.ids.next("gate")),
        runId: handle.runId,
        taskId: handle.taskId,
        attemptId: handle.attemptId,
        reasonCode: "security_or_privilege_gate",
        summary: "the scripted fake executor requires a human decision",
        evidenceRefs: [],
        options: [
          { id: "rework", label: "Create bounded rework", consequence: "Return to REWORK with the same scope.", target: "REWORK" },
          { id: "cancel", label: "Cancel the run", consequence: "Stop the run and preserve the evidence.", target: "CANCELLED" },
        ],
        status: "open",
      };
      return {
        ...this.resultBase(handle, "blocked", "security_or_privilege_gate", "fake executor blocked on a human gate", evidence),
        humanGate: gate,
        recommendedNext: "human_gate",
      };
    }
    if (scripted === "implementation_failure") {
      return {
        ...this.resultBase(handle, "failed", "implementation_failure", "fake executor produced a diagnosed implementation failure", evidence),
        humanGate: null,
        recommendedNext: "rework",
      };
    }
    return {
      ...this.resultBase(handle, "succeeded", null, "fake executor completed successfully", evidence),
      humanGate: null,
      recommendedNext: "verify_focused",
    };
  }

  private makeCancelledResult(handle: AttemptHandle): ExecutorResult {
    return {
      ...this.resultBase(handle, "cancelled", "cancelled", "fake executor was cancelled", this.evidence(handle, "fake cancellation")),
      humanGate: null,
      recommendedNext: "fail",
    };
  }

  private resultBase(handle: AttemptHandle, outcome: ExecutorResult["outcome"], failureClass: ExecutorResult["failureClass"], summary: string, evidence: ValidationEvidence[]): Omit<ExecutorResult, "humanGate" | "recommendedNext"> {
    return {
      schemaVersion: CONTRACT_VERSIONS.executorResult,
      runId: handle.runId,
      taskId: handle.taskId,
      attemptId: handle.attemptId,
      executor: { adapter: "fake", adapterVersion: "phase1", provider: "synthetic", model: "fake" },
      outcome,
      failureClass,
      scopeClaim: "within_scope",
      summary,
      filesChanged: [],
      checks: [{ name: "fake scripted result", outcome: outcome === "succeeded" ? "passed" : "failed", evidenceClass: "simulated", evidenceRefs: [] }],
      evidence,
      invariantViolations: [],
      risks: [],
      warnings: [],
      artifacts: [],
      exit: outcome === "cancelled" ? { kind: "signal" } : { kind: "normal", code: 0 },
    };
  }

  private evidence(handle: AttemptHandle, summary: string): ValidationEvidence[] {
    return [{
      schemaVersion: CONTRACT_VERSIONS.validation,
      id: asValidationId(this.ids.next("validation")),
      kind: "result",
      classification: "simulated",
      summary: `${summary} for ${handle.attemptId}`,
    }];
  }
}
