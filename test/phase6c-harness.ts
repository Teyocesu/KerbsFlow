import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorAdapter } from "../src/adapter.js";
import { FileArtifactStore } from "../src/artifacts.js";
import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  asDecisionId,
  asGateId,
  type AdapterDescriptor,
  type AttemptHandle,
  type AttemptId,
  type ExecutorOutcome,
  type ExecutorResult,
  type ExecutionRequest,
  type NormalizedEvent,
  type ReconcileOutcome,
  type RunId,
  type RunState,
  type TaskId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { GitWorktreeManager } from "../src/git.js";
import { LocalApiServer } from "../src/local-api.js";
import { createPhase2PlanningDecision, type InitialPlanningInput, type PlanningMaster } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { Phase2Loop } from "../src/phase2.js";
import { RunCoordinator } from "../src/run-coordinator.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { ProcessSupervisor } from "../src/process.js";
import { VerificationSandbox } from "../src/verification-sandbox.js";
import { FocusedVerifier } from "../src/verifier.js";
import { createGitRepository } from "./phase2-helpers.js";

export type SyntheticFinish = "succeeded" | "success_without_change" | "blocked" | "cancelled";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export interface Phase6CStack {
  root: string;
  repository: { root: string; head: string };
  store: StateStore;
  artifacts: FileArtifactStore;
  core: KerbsFlowCore;
  phase2: Phase2Loop;
  coordinator: RunCoordinator;
  api: LocalApiServer;
  adapter: SyntheticCodexAdapter;
  planningMaster: PlanningMaster;
  planningInputs: { initial: InitialPlanningInput[]; rework: Parameters<PlanningMaster["planRework"]>[0][] };
  firstInitialPlanStarted: Deferred<InitialPlanningInput>;
  releaseFirstInitialPlan: Deferred<void>;
  restartControlPlane(): Promise<void>;
  close(): Promise<void>;
}

export class SyntheticCodexAdapter implements ExecutorAdapter {
  readonly started = deferred<AttemptHandle>();
  readonly requests: ExecutionRequest[] = [];
  cancelCalls = 0;
  private readonly waiters = new Map<string, Deferred<unknown>>();
  private readonly results = new Map<string, ExecutorResult>();

  constructor(
    private readonly extraGateTarget?: RunState,
    private readonly reworkOptionId = "rework",
    private readonly reworkProposalCount = 1,
  ) {}

  probe(): AdapterDescriptor {
    return {
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "codex",
      provider: "synthetic",
      adapterVersion: "phase6c-synthetic/1",
      capabilities: {
        eventTransport: "async_iterable",
        finalJsonSchema: true,
        modelSelection: true,
        reasoningEffort: ["medium"],
        agentSelection: false,
        filesystemEnforcement: "enforced",
        network: { providerControlPlane: "not_applicable", workload: "enforced" },
        cancellation: "simulated",
        resumableSession: false,
        authentication: { owner: "none", mode: "synthetic" },
        healthProbe: true,
      },
    };
  }

  start(request: ExecutionRequest): AttemptHandle {
    this.requests.push(request);
    const handle: AttemptHandle = {
      schemaVersion: CONTRACT_VERSIONS.attemptHandle,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      providerSessionId: `synthetic-${request.attemptId}`,
    };
    this.waiters.set(handle.attemptId, deferred<unknown>());
    return handle;
  }

  async *events(_handle: AttemptHandle): AsyncIterable<NormalizedEvent> {
    // The synthetic provider emits no progress events; terminal results remain explicit.
  }

  wait(handle: AttemptHandle): Promise<unknown> {
    this.started.resolve(handle);
    const waiter = this.waiters.get(handle.attemptId);
    if (waiter === undefined) throw new Error(`no synthetic wait registered for ${handle.attemptId}`);
    return waiter.promise;
  }

  cancel(handle: AttemptHandle, _reason: string) {
    this.cancelCalls += 1;
    const result = this.result(handle, "cancelled");
    this.results.set(handle.attemptId, result);
    this.waiters.get(handle.attemptId)?.resolve(result);
    return { outcome: "cancelled" as const, summary: "synthetic operation received one cancellation signal" };
  }

  async reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    const result = this.results.get(identity.attemptId);
    if (result === undefined) return { outcome: "unknown", summary: "synthetic provider has no terminal proof" };
    if (result.runId !== identity.runId || result.taskId !== identity.taskId || result.attemptId !== identity.attemptId) {
      return { outcome: "unknown", summary: "synthetic terminal proof identity did not match" };
    }
    return { outcome: "terminal", result, summary: "synthetic adapter retained matching terminal proof" };
  }

  finish(handle: AttemptHandle, outcome: SyntheticFinish, options: { writeResult?: boolean } = {}): ExecutorResult {
    const wroteResult = outcome === "succeeded" && options.writeResult !== false;
    if (wroteResult) {
      writeFileSync(join(this.requestFor(handle).workingDirectory, "result.txt"), "done\n", "utf8");
    }
    const result = this.result(handle, outcome === "success_without_change" ? "succeeded" : outcome, wroteResult);
    this.results.set(handle.attemptId, result);
    const waiter = this.waiters.get(handle.attemptId);
    if (waiter === undefined) throw new Error(`no synthetic wait registered for ${handle.attemptId}`);
    waiter.resolve(result);
    return result;
  }

  finishNext(outcome: SyntheticFinish, options?: { writeResult?: boolean }): ExecutorResult {
    const handle = this.requests.at(-1);
    if (handle === undefined) throw new Error("synthetic executor has not started");
    return this.finish({
      schemaVersion: CONTRACT_VERSIONS.attemptHandle,
      runId: handle.runId,
      taskId: handle.taskId,
      attemptId: handle.attemptId,
    }, outcome, options);
  }

  private requestFor(handle: AttemptHandle): ExecutionRequest {
    const request = this.requests.find((entry) => entry.attemptId === handle.attemptId);
    if (request === undefined) throw new Error(`synthetic request not found for ${handle.attemptId}`);
    return request;
  }

  private result(handle: AttemptHandle, outcome: ExecutorOutcome, wroteResult = false): ExecutorResult {
    const blocked = outcome === "blocked";
    const cancelled = outcome === "cancelled";
    return {
      schemaVersion: CONTRACT_VERSIONS.executorResult,
      runId: handle.runId,
      taskId: handle.taskId,
      attemptId: handle.attemptId,
      executor: {
        adapter: "codex",
        adapterVersion: "phase6c-synthetic/1",
        provider: "synthetic",
        model: this.requestFor(handle).model,
      },
      outcome,
      failureClass: blocked ? "security_or_privilege_gate" : cancelled ? "cancelled" : null,
      scopeClaim: "within_scope",
      summary: blocked ? "synthetic human decision required" : cancelled ? "synthetic operation cancelled" : "synthetic execution completed",
      filesChanged: wroteResult ? [{ path: "result.txt", change: "added" }] : [],
      checks: [],
      evidence: [],
      invariantViolations: [],
      risks: [],
      warnings: [],
      artifacts: [],
      humanGate: blocked ? {
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(`gate_${handle.attemptId}`),
        runId: handle.runId,
        taskId: handle.taskId,
        attemptId: handle.attemptId,
        reasonCode: "security_or_privilege_gate",
        summary: "Synthetic QA requires an explicit human decision.",
        evidenceRefs: [],
        options: [
          ...Array.from({ length: this.reworkProposalCount }, (_, index) => ({
            id: index === 0 ? this.reworkOptionId : `provider_rework_${index + 1}`,
            label: index === 0 ? "Create bounded rework" : `Duplicate rework ${index + 1}`,
            consequence: index === 0 ? "Return to the bounded rework path." : `Duplicate consequence ${index + 1}.`,
            target: "REWORK" as const,
          })),
          { id: "cancel", label: "Cancel the run", consequence: "Stop this run and preserve its evidence.", target: "CANCELLED" },
          ...(this.extraGateTarget === undefined ? [] : [{ id: "unsupported", label: "Unsupported path", consequence: "No continuation is registered for this target.", target: this.extraGateTarget }]),
        ],
        status: "open",
      } : null,
      recommendedNext: blocked ? "human_gate" : cancelled ? "fail" : "verify_focused",
      exit: cancelled ? { kind: "signal", signal: "SIGTERM" } : { kind: "normal", code: 0 },
    };
  }
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

export async function waitFor<T>(read: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

export function createPhase6CStack(options: { holdFirstInitialPlan?: boolean; phaseCheck?: boolean; maxImplementationAttempts?: 1 | 2; extraGateTarget?: RunState; reworkOptionId?: string; reworkProposalCount?: number } = {}): Phase6CStack {
  const repository = createGitRepository();
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-phase6c-controls-"));
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  const runtime = join(root, "runtime");
  const clock = new FixedClock("2026-09-28T12:00:00.000Z");
  const ids = new SequenceIdSource("phase6c_controls");
  const store = StateStore.open(join(runtime, "state.sqlite"), { clock, ids });
  const artifacts = new FileArtifactStore(join(runtime, "artifacts"), ids);
  const adapter = new SyntheticCodexAdapter(options.extraGateTarget, options.reworkOptionId, options.reworkProposalCount);
  const core = new KerbsFlowCore(store, adapter, artifacts, {
    clock,
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: { ...DEFAULT_PROJECT_POLICY, allowedAdapters: ["codex"] },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: options.maxImplementationAttempts === undefined
        ? DEFAULT_RUN_OVERRIDE
        : { ...DEFAULT_RUN_OVERRIDE, maxImplementationAttempts: options.maxImplementationAttempts },
    },
  });
  const planningInputs: Phase6CStack["planningInputs"] = { initial: [], rework: [] };
  const firstInitialPlanStarted = deferred<InitialPlanningInput>();
  const releaseFirstInitialPlan = deferred<void>();
  const planningMaster: PlanningMaster = {
    async planInitial(input) {
      planningInputs.initial.push(input);
      if (planningInputs.initial.length === 1) {
        firstInitialPlanStarted.resolve(input);
        if (options.holdFirstInitialPlan === true) await releaseFirstInitialPlan.promise;
      }
      return {
        decision: createPhase2PlanningDecision({
          decisionId: ids.next("decision"),
          runId: input.runId,
          taskId: input.taskId,
          objective: input.objective,
          acceptance: ["the synthetic result passes the configured independent check"],
          positiveScope: ["result.txt"],
          negativeScope: ["AGENTS.md", "docs", "test"],
          model: "synthetic-model",
          canonicalContext: `phase6c:${input.objective}`,
        }),
      };
    },
    async planRework(input) {
      planningInputs.rework.push(input);
      return {
        decision: {
          ...input.priorDecision,
          decisionId: asDecisionId(ids.next("decision")),
          action: { ...input.priorDecision.action, kind: "rework" },
        },
      };
    },
  };
  const makePhase2 = (currentCore: KerbsFlowCore, currentStore: StateStore): Phase2Loop => {
    const currentGit = new GitWorktreeManager(join(runtime, "owned"));
    return new Phase2Loop(currentCore, currentStore, currentGit, new FocusedVerifier(currentGit, new VerificationSandbox(new ProcessSupervisor()), ids), ids);
  };
  const phase2 = makePhase2(core, store);
  const profile = {
    launchProfileId: "phase6c-synthetic-profile",
    launchProfileHash: "6".repeat(64),
    canonicalRepositoryPath: realpathSync(repository.root),
    expectedBaseOid: repository.head,
    focusedCheck: { name: "synthetic result", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5_000, proof: { kind: "stdout_line" as const, expected: "KERBSFLOW_CHECK_PASSED" } },
    ...(options.phaseCheck === true ? { phaseCheck: { level: "phase" as const, commandId: "phase6c-synthetic-phase-check", name: "synthetic phase result", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5_000, proof: { kind: "stdout_line" as const, expected: "KERBSFLOW_CHECK_PASSED" } } } : {}),
    executionTimeoutMs: 120_000,
    planningMaster,
  };
  const makeCoordinator = (currentCore: KerbsFlowCore, currentStore: StateStore, currentPhase2: Phase2Loop): RunCoordinator =>
    new RunCoordinator(currentCore, currentStore, currentPhase2, profile, ids);
  const makeApi = (currentCore: KerbsFlowCore, currentStore: StateStore, currentArtifacts: FileArtifactStore, currentCoordinator: RunCoordinator): LocalApiServer =>
    new LocalApiServer({
      core: { readModel: currentCore.readModel.bind(currentCore), steer: currentCore.steer.bind(currentCore), configuration: currentCore.configuration },
      coordinator: currentCoordinator,
      store: currentStore,
      artifacts: currentArtifacts,
    }, { pollIntervalMs: 20 });
  const coordinator = makeCoordinator(core, store, phase2);
  const api = makeApi(core, store, artifacts, coordinator);
  let stack: Phase6CStack;
  stack = {
    root,
    repository,
    store,
    artifacts,
    core,
    phase2,
    coordinator,
    api,
    adapter,
    planningMaster,
    planningInputs,
    firstInitialPlanStarted,
    releaseFirstInitialPlan,
    async restartControlPlane() {
      await stack.api.close();
      stack.store.close();
      const nextStore = StateStore.open(join(runtime, "state.sqlite"), { clock, ids });
      const nextArtifacts = new FileArtifactStore(join(runtime, "artifacts"), ids);
      const nextCore = new KerbsFlowCore(nextStore, adapter, nextArtifacts, { clock, ids, configuration: core.configuration });
      const nextPhase2 = makePhase2(nextCore, nextStore);
      const nextCoordinator = makeCoordinator(nextCore, nextStore, nextPhase2);
      stack.store = nextStore;
      stack.artifacts = nextArtifacts;
      stack.core = nextCore;
      stack.phase2 = nextPhase2;
      stack.coordinator = nextCoordinator;
      stack.api = makeApi(nextCore, nextStore, nextArtifacts, nextCoordinator);
    },
    async close() {
      await stack.api.close();
      stack.store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    },
  };
  return stack;
}
