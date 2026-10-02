import { createHash } from "node:crypto";
import { dirname } from "node:path";

import {
  AttemptHandle,
  AttemptId,
  AttemptLifecycle,
  Command,
  CommandId,
  CommandResult,
  CONTRACT_VERSIONS,
  ContractValidationError,
  ExecutorResult,
  FailureClassification,
  HumanGate,
  GateId,
  JsonValue,
  ReviewDecision,
  ReconcileOutcome,
  ReviewId,
  RunId,
  RunState,
  TaskId,
  ValidationBundle,
  ValidationId,
  asAttemptId,
  asCommandId,
  asGateId,
  asInstructionId,
  asReviewId,
  asRunId,
  asTaskId,
  asValidationId,
  isTerminalState,
  parseAdapterDescriptor,
  parseExecutorResult,
  parseExecutionRequest,
  parseHumanGate,
  parseJsonValue,
  parseNormalizedEvent,
  parsePlanningDecision,
  parseRecoveryDecision,
  parseReviewDecision,
  parseSteerText,
  parseValidationBundle,
  parseCommand,
  canonicalJson,
} from "./contracts.js";
import type { ExecutorAdapter } from "./adapter.js";
import type { ArtifactStore } from "./artifacts.js";
import { KerbsFlowError, NotFoundError } from "./errors.js";
import {
  CommandMutation,
  CommandMutationContext,
  ReadModel,
  RunLaunchBinding,
  SqlTransaction,
  StoredRun,
  StateStore,
  StoredAttempt,
  StoredGate,
  StoredTask,
} from "./persistence.js";
import { Clock, IdSource, RandomIdSource } from "./runtime.js";
import { assertLegalTransition, assertResumeTarget, choosePauseContract, isLegalTransition } from "./state-machine.js";
import { detectAntiGreenwashing } from "./anti-greenwashing.js";
import { decideTrustedReview } from "./phase3.js";
import { hashCanonicalDocuments } from "./canonical.js";
import { GitWorktreeManager, type WorktreeRecord } from "./git.js";
import { bindingFor, checkIntentHash } from "./verifier.js";
import {
  PHASE4_ROUTING_POLICY,
  assertAttemptRoutingBinding,
  assertAttemptRoutingProvenance,
  assertRoutingDecision,
  type AttemptRoutingProvenance,
  type RoutingDecision,
} from "./routing.js";
import {
  ConfigLayers,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  EffectiveConfiguration,
  mergeConfiguration,
} from "./contracts.js";
import { containsLikelySecret, SENSITIVE_RESULT_REJECTION } from "./secrets.js";
import {
  assertReworkDecisionBounds,
  parsePlanningSteerObservation,
  type PlanningSteerObservation,
} from "./planning.js";

import { assertRecoverySettlementAuthority, type RecoverySettlementAuthority } from "./run-coordinator.js";

export interface CoreOptions {
  store: StateStore;
  adapter: ExecutorAdapter;
  artifacts: ArtifactStore;
  clock?: Clock;
  ids?: IdSource;
  configuration?: ConfigLayers;
}

export interface FakeRunResult {
  begin: CommandResult;
  completion: CommandResult;
}

export class KerbsFlowCore {
  readonly configuration: EffectiveConfiguration;

  private readonly ids: IdSource;
  private readonly liveHandles = new Map<string, AttemptHandle>();

  constructor(
    private readonly store: StateStore,
    private readonly adapter: ExecutorAdapter,
    private readonly artifacts: ArtifactStore,
    options: Omit<CoreOptions, "store" | "adapter" | "artifacts"> = {},
  ) {
    this.ids = options.ids ?? new RandomIdSource();
    this.configuration = mergeConfiguration(options.configuration ?? {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: DEFAULT_PROJECT_POLICY,
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    });
  }

  prepareWorktreeCleanup(runId: RunId, manager: GitWorktreeManager) {
    const authority = this.store.issueWorktreeCleanupAuthority(runId);
    const stored = this.store.getWorktree(runId)!;
    const record: WorktreeRecord = {
      schemaVersion: "kerbsflow.worktree/v1", runKey: runId,
      repositoryPath: stored.repositoryPath, gitCommonDirectory: stored.gitCommonDirectory,
      worktreeGitDirectory: stored.worktreeGitDirectory, baseOid: stored.baseOid,
      branch: stored.branch, path: stored.worktreePath, markerPath: stored.markerPath,
      createdAt: stored.createdAt,
    };
    return manager.prepareCleanup(record, authority);
  }

  startRun(runId: RunId, objective: string, idempotencyKey: string, commandId?: CommandId): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion: 0,
      kind: "start",
      objective,
    });
    if (command.kind !== "start") {
      throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "start command did not parse as start");
    }
    return this.store.createRun(command);
  }

  startRunWithLaunchBinding(runId: RunId, objective: string, idempotencyKey: string, binding: RunLaunchBinding, commandId?: CommandId): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion: 0,
      kind: "start",
      objective,
    });
    if (command.kind !== "start") {
      throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "coordinated start command did not parse as start");
    }
    return this.store.createRunWithLaunchBinding(command, binding);
  }

  completeIntake(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    return this.transition(runId, expectedStateVersion, idempotencyKey, "PLAN", "intake_validated", "core");
  }

  gateIntake(runId: RunId, expectedStateVersion: number, idempotencyKey: string, reasonCode: string, summary: string): CommandResult {
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "HUMAN_GATE", "core", reasonCode, { summary });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "INTAKE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `intake gate requires INTAKE, found ${run.state}`);
      }
      const gate = parseHumanGate({
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(nextId("gate")),
        runId,
        reasonCode,
        summary,
        evidenceRefs: [],
        options: [
          { id: "cancel", label: "Cancel this run", consequence: "Preserve the checkout unchanged and stop this run.", target: "CANCELLED" },
          { id: "fail", label: "Fail this run", consequence: "Preserve evidence; resolve the checkout ambiguity manually before starting another run.", target: "FAILED" },
        ],
        status: "open",
      });
      this.insertGate(tx, gate, now);
      return {
        transition: { to: "HUMAN_GATE", actor: "core", reasonCode, gateId: gate.gateId, payload: { summary } },
        runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
        details: { gateId: gate.gateId, reasonCode },
      } satisfies CommandMutation;
    });
  }

  failIntake(runId: RunId, expectedStateVersion: number, idempotencyKey: string, reasonCode: string, summary: string): CommandResult {
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "FAILED", "core", reasonCode, { summary });
    return this.store.executeCommand(command, ({ run }) => {
      if (run.state !== "INTAKE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `intake failure requires INTAKE, found ${run.state}`);
      }
      return {
        transition: { to: "FAILED", actor: "core", reasonCode, payload: { summary } },
        runPatch: { recoveryRequired: false, recoveryReason: null },
        details: { reasonCode },
      } satisfies CommandMutation;
    });
  }

  failPlanWorktreeSetup(runId: RunId, expectedStateVersion: number, idempotencyKey: string, reasonCode: string): CommandResult {
    const boundedReasonCode = reasonCode.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 120) || "worktree_setup_failed";
    const summary = `Worktree setup failed before its durable creation intent was recorded (${boundedReasonCode}). No Git worktree was created.`.slice(0, 1000);
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "FAILED", "core", boundedReasonCode, { summary });
    return this.store.executeCommand(command, ({ run }) => {
      if (run.state !== "PLAN") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `worktree setup failure requires PLAN, found ${run.state}`);
      }
      return {
        transition: { to: "FAILED", actor: "core", reasonCode: boundedReasonCode, payload: { summary } },
        runPatch: { recoveryRequired: false, recoveryReason: null },
        details: { reasonCode: boundedReasonCode },
      } satisfies CommandMutation;
    });
  }

  failInitialPlanning(runId: RunId, expectedStateVersion: number, idempotencyKey: string, failure: "invocation" | "internal" = "invocation"): CommandResult {
    const reasonCode = failure === "internal" ? "initial_planning_internal_error" : "initial_planning_failed";
    const summary = failure === "internal"
      ? "Initial planning stopped because of an internal error before a decision was accepted. The owned worktree is retained; no executor was started."
      : "Initial planning failed before a decision was accepted. The owned worktree is retained; no executor was started.";
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "FAILED", "core", reasonCode, { summary });
    return this.store.executeCommand(command, ({ run }) => {
      if (run.state !== "PLAN" || run.currentTaskId !== null || run.activeAttemptId !== null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "initial planning failure requires PLAN without an accepted task or active attempt");
      }
      return {
        transition: { to: "FAILED", actor: "core", reasonCode, payload: { summary } },
        runPatch: { recoveryRequired: false, recoveryReason: null },
        details: { reasonCode },
      } satisfies CommandMutation;
    });
  }

  gateInitialPlanningTrustFailure(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const reasonCode = "initial_planning_trust_violation";
    const summary = "Initial planning encountered a canonical, security, or policy violation. No decision was accepted or executor started; the owned worktree is retained for human review.";
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "HUMAN_GATE", "core", reasonCode, { summary });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "PLAN" || run.currentTaskId !== null || run.activeAttemptId !== null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "initial planning trust failure requires PLAN without an accepted task or active attempt");
      }
      const gate = parseHumanGate({
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(nextId("gate")),
        runId,
        reasonCode,
        summary,
        evidenceRefs: [],
        options: [
          { id: "fail", label: "Fail and preserve evidence", consequence: "Stop this run and retain the owned worktree for manual review.", target: "FAILED" },
          { id: "cancel", label: "Cancel and preserve evidence", consequence: "Cancel this run and retain the owned worktree for manual review.", target: "CANCELLED" },
        ],
        status: "open",
      });
      this.insertGate(tx, gate, now);
      return {
        transition: { to: "HUMAN_GATE", actor: "core", reasonCode, gateId: gate.gateId, payload: { summary } },
        runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
        details: { gateId: gate.gateId, reasonCode },
      } satisfies CommandMutation;
    });
  }

  gatePlanWorktreeCreationUncertain(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const reasonCode = "worktree_creation_uncertain";
    const summary = "Worktree creation did not reach a durable completed record. The intent marker and any partial Git state are preserved for review; no automatic retry or cleanup will occur.";
    const safeSummary = summary.slice(0, 1000);
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "HUMAN_GATE", "core", reasonCode, { summary: safeSummary });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "PLAN") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `uncertain worktree creation gate requires PLAN, found ${run.state}`);
      }
      const gate = parseHumanGate({
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(nextId("gate")),
        runId,
        reasonCode,
        summary: safeSummary,
        evidenceRefs: [],
        options: [
          { id: "fail", label: "Fail and preserve evidence", consequence: "Resolve the preserved intent marker and any partial Git state manually before starting another run.", target: "FAILED" },
          { id: "cancel", label: "Cancel and preserve evidence", consequence: "Stop this run while keeping the intent marker and any partial Git state for manual review.", target: "CANCELLED" },
        ],
        status: "open",
      });
      this.insertGate(tx, gate, now);
      return {
        transition: { to: "HUMAN_GATE", actor: "core", reasonCode, gateId: gate.gateId, payload: { summary: safeSummary } },
        runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
        details: { gateId: gate.gateId, reasonCode },
      } satisfies CommandMutation;
    });
  }

  disposeDriveFailure(runId: RunId, expectedStateVersion: number, idempotencyKey: string, category: "failure" | "trust" | "unknown"): CommandResult {
    const reasonCode = category === "trust" ? "drive_trust_violation" : category === "unknown" ? "drive_failure_unclassified" : "drive_operation_failed";
    const summary = "The owned workflow stopped before its next durable boundary. Preserve the worktree and artifacts; no automatic retry or cleanup will occur.";
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "recovery", { category });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (isTerminalState(run.state) || run.state === "HUMAN_GATE" || run.state === "RECOVERY"
        || run.state === "NEXT_PHASE" || run.state === "HUMAN_RELEASE_GATE") {
        return { details: { reasonCode, existingDisposition: run.state } } satisfies CommandMutation;
      }
      const attempt = run.activeAttemptId === null ? undefined : this.attemptInTransaction(tx, run.activeAttemptId);
      const succeeded = run.state === "VERIFY_FOCUSED" && attempt?.lifecycle === "SUCCEEDED"
        && this.validatePersistedExecutorResultForRecovery(runId, run.currentTaskId, run.activeAttemptId, attempt).outcome === "succeeded";
      const uncertain = attempt !== undefined && !isTerminalAttempt(attempt.lifecycle);
      if (uncertain || run.state === "EXECUTE" || (run.state === "VERIFY_FOCUSED" && !succeeded)) {
        if (!isLegalTransition(run.state, "RECOVERY")) {
          throw new KerbsFlowError("DRIVE_DISPOSITION_UNSAFE", "an uncertain attempt has no legal recovery transition at this boundary");
        }
        if (run.currentTaskId !== null) tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "recovery_required", now, run.currentTaskId);
        return {
          transition: { to: "RECOVERY", actor: "core", reasonCode, taskId: run.currentTaskId, attemptId: run.activeAttemptId, payload: { summary } },
          runPatch: { recoveryRequired: true, recoveryReason: summary },
          details: { reasonCode },
        } satisfies CommandMutation;
      }
      const target = category === "failure" && isLegalTransition(run.state, "FAILED") ? "FAILED" : "HUMAN_GATE";
      assertLegalTransition(run.state, target);
      let gate: HumanGate | undefined;
      if (target === "HUMAN_GATE") {
        const artifact = succeeded ? tx.get("SELECT artifact_id FROM artifacts WHERE run_id = ? AND attempt_id = ? AND kind = ?", runId, run.activeAttemptId!, "executor-result") : undefined;
        gate = parseHumanGate({
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId(nextId("gate")), runId,
          ...(run.currentTaskId === null ? {} : { taskId: run.currentTaskId }),
          ...(run.activeAttemptId === null ? {} : { attemptId: run.activeAttemptId }),
          reasonCode, summary, evidenceRefs: artifact === undefined ? [] : [String(artifact.artifact_id)],
          options: [
            { id: "fail", label: "Fail and preserve evidence", consequence: "Stop this run and retain its worktree and artifacts for manual review.", target: "FAILED" },
            { id: "cancel", label: "Cancel and preserve evidence", consequence: "Cancel this run and retain its worktree and artifacts for manual review.", target: "CANCELLED" },
          ],
          status: "open",
        });
        this.insertGate(tx, gate, now);
      }
      if (run.currentTaskId !== null) tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", target === "FAILED" ? "failed" : "blocked", now, run.currentTaskId);
      return {
        transition: { to: target, actor: "core", reasonCode, taskId: run.currentTaskId, attemptId: run.activeAttemptId, gateId: gate?.gateId ?? null, payload: { summary } },
        runPatch: { currentGateId: gate?.gateId ?? null, recoveryRequired: false, recoveryReason: null },
        details: { reasonCode, ...(gate === undefined ? {} : { gateId: gate.gateId }) },
      } satisfies CommandMutation;
    });
  }

  steer(runId: RunId, expectedStateVersion: number, idempotencyKey: string, text: string, commandId?: CommandId): CommandResult {
    const parsedText = parseSteerText(text, "text");
    if (containsLikelySecret(parsedText)) {
      throw new KerbsFlowError("STEER_SECRET_REJECTED", SENSITIVE_RESULT_REJECTION);
    }
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "steer",
      text: parsedText,
    });
    if (command.kind !== "steer") {
      throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "steer command did not parse as steer");
    }
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (isTerminalState(run.state)) {
        throw new KerbsFlowError("STEER_TERMINAL", `cannot steer terminal run at ${run.state}`);
      }
      if (containsLikelySecret(command.text)) {
        throw new KerbsFlowError("STEER_SECRET_REJECTED", SENSITIVE_RESULT_REJECTION);
      }
      const pending = tx.get("SELECT instruction_id FROM steer_instructions WHERE run_id = ? AND consumed_at IS NULL", runId) as Record<string, unknown> | undefined;
      if (pending !== undefined) {
        throw new KerbsFlowError("STEER_PENDING_EXISTS", `run ${runId} already has a pending steer instruction`);
      }
      const instructionId = asInstructionId(nextId("instruction"));
      tx.run(
        "INSERT INTO steer_instructions (instruction_id, run_id, command_id, text, actor, created_at, consumed_at, planning_command_id, planning_decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        instructionId,
        runId,
        command.commandId,
        command.text,
        "human",
        now,
        null,
        null,
        null,
      );
      return {
        details: { instructionId, pending: true },
      } satisfies CommandMutation;
    });
  }

  plan(runId: RunId, expectedStateVersion: number, idempotencyKey: string, value: unknown, observedSteer?: unknown): CommandResult {
    const decision = parsePlanningDecision(value);
    const observation = parsePlanningSteerObservation(observedSteer);
    if (decision.runId !== runId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "planning decision runId does not match the command run");
    }
    if (!this.configuration.projectPolicy.allowedAdapters.includes(decision.route.adapter)) {
      throw new KerbsFlowError("ROUTE_NOT_ALLOWED", `adapter ${decision.route.adapter} is not enabled by Phase 1 project policy`);
    }
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "READY", "planner", "planning_decision_accepted", { decision: parseJsonValue(decision, "planningDecision") });
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "PLAN") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `planning requires PLAN, found ${run.state}`);
      }
      this.consumeObservedSteer(tx, runId, observation, command.commandId, decision.decisionId, now);
      const existing = tx.get("SELECT task_id FROM tasks WHERE task_id = ?", decision.taskId) as Record<string, unknown> | undefined;
      if (existing === undefined) {
        tx.run(
          "INSERT INTO tasks (task_id, run_id, status, decision_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          decision.taskId,
          runId,
          "ready",
          JSON.stringify(decision),
          now,
          now,
        );
      } else {
        const existingRun = tx.get("SELECT run_id FROM tasks WHERE task_id = ?", decision.taskId) as Record<string, unknown> | undefined;
        if (existingRun?.run_id !== runId) {
          throw new KerbsFlowError("TASK_SCOPE_MISMATCH", `task ${decision.taskId} belongs to another run`);
        }
        tx.run("UPDATE tasks SET status = ?, decision_json = ?, updated_at = ? WHERE task_id = ?", "ready", JSON.stringify(decision), now, decision.taskId);
      }
      return {
        transition: {
          to: "READY",
          actor: "planner",
          reasonCode: "planning_decision_accepted",
          taskId: decision.taskId,
          payload: parseJsonValue(decision as unknown, "planningDecision"),
        },
        runPatch: { currentTaskId: decision.taskId, recoveryRequired: false, recoveryReason: null },
        details: { taskId: decision.taskId },
      } satisfies CommandMutation;
    });
  }

  prepareExecution(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "begin_attempt", { phase: "prepare" });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "READY") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `execution preparation requires READY, found ${run.state}`);
      }
      if (run.currentTaskId === null) {
        throw new KerbsFlowError("TASK_REQUIRED", "READY requires a current planned task");
      }
      const active = tx.get("SELECT attempt_id FROM attempts WHERE lifecycle IN ('PREPARED', 'RUNNING', 'UNKNOWN') LIMIT 1") as Record<string, unknown> | undefined;
      if (active !== undefined) {
        throw new KerbsFlowError("ACTIVE_EXECUTOR_EXISTS", `attempt ${String(active.attempt_id)} is already active`);
      }
      const task = this.taskInTransaction(tx, run.currentTaskId);
      this.adapter.select?.(task.decision.route.adapter);
      const descriptor = parseAdapterDescriptor(this.adapter.probe());
      if (descriptor.adapter !== task.decision.route.adapter) {
        throw new KerbsFlowError("ROUTE_ADAPTER_MISMATCH", `planned adapter ${task.decision.route.adapter} does not match active adapter ${descriptor.adapter}`);
      }
      const attemptId = asAttemptId(nextId("attempt"));
      tx.run(
        "INSERT INTO attempts (attempt_id, run_id, task_id, lifecycle, adapter_descriptor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        attemptId,
        runId,
        task.taskId,
        "PREPARED",
        JSON.stringify(descriptor),
        now,
        now,
      );
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "in_progress", now, task.taskId);
      return {
        transition: {
          to: "EXECUTE",
          actor: "core",
          reasonCode: "attempt_prepared",
          taskId: task.taskId,
          attemptId,
          payload: { attemptId },
        },
        runPatch: { activeAttemptId: attemptId, recoveryRequired: false, recoveryReason: null },
        details: { attemptId },
      } satisfies CommandMutation;
    });
  }

  async beginFakeAttempt(runId: RunId, expectedStateVersion: number, idempotencyKey: string): Promise<CommandResult> {
    return this.beginAttempt(runId, expectedStateVersion, idempotencyKey, "<headless-fake-worktree>");
  }

  async beginAttempt(
    runId: RunId,
    expectedStateVersion: number,
    idempotencyKey: string,
    workingDirectory: string,
    options: { prompt?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    if (attempt.lifecycle !== "PREPARED" && attempt.lifecycle !== "RUNNING") {
      throw new KerbsFlowError("ATTEMPT_NOT_PREPARED", `attempt ${attempt.attemptId} is ${attempt.lifecycle}`);
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "begin_attempt", { attemptId: attempt.attemptId });
    const result = this.store.executeCommand(command, ({ tx, run }) => {
      if (run.state !== "EXECUTE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `execution requires EXECUTE, found ${run.state}`);
      }
      const current = this.attemptInTransaction(tx, attempt.attemptId);
      this.assertPhase4DispatchAuthority(tx, this.taskInTransaction(tx, current.taskId), current);
      if (current.lifecycle === "RUNNING") {
        return { details: { attemptId: attempt.attemptId, alreadyRunning: true } } satisfies CommandMutation;
      }
      if (current.lifecycle !== "PREPARED") {
        throw new KerbsFlowError("ATTEMPT_NOT_PREPARED", `attempt ${current.attemptId} is ${current.lifecycle}`);
      }
      return { details: { attemptId: current.attemptId, dispatchClaimed: true } } satisfies CommandMutation;
    });
    if (!result.replayed && !this.liveHandles.has(attempt.attemptId)) {
      const task = this.requiredTask(model.run.currentTaskId);
      const basePrompt = options.prompt ?? task.decision.action.summary;
      const promptSummary = `${basePrompt}\nExpected result identity:\n- runId: ${runId}\n- taskId: ${task.taskId}\n- attemptId: ${attempt.attemptId}`;
      const request = {
        schemaVersion: CONTRACT_VERSIONS.executionRequest,
        runId,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        role: "implementation" as const,
        workingDirectory,
        promptSummary,
        model: task.decision.route.model,
        ...(task.decision.route.reasoning === undefined ? {} : { reasoning: task.decision.route.reasoning }),
        permissionPolicy: { filesystem: "worktree_only" as const, network: "denied" as const },
        timeoutMs: options.timeoutMs ?? 1000,
        expectedResultSchema: CONTRACT_VERSIONS.executorResult,
      };
      const handle = this.adapter.start(parseExecutionRequest(request));
      this.liveHandles.set(attempt.attemptId, handle);
      this.persistAttemptHandle(runId, result.stateVersion, `${idempotencyKey}:identity`, attempt.attemptId, handle);
    }
    return result;
  }

  recoveryCandidateFingerprint(runId: RunId): string {
    const stored = this.store.getWorktree(runId);
    if (stored === undefined) throw new KerbsFlowError("WORKTREE_RECORD_REQUIRED", "recovery requires the owned candidate");
    const worktree: WorktreeRecord = { schemaVersion: "kerbsflow.worktree/v1", runKey: runId, repositoryPath: stored.repositoryPath, gitCommonDirectory: stored.gitCommonDirectory, worktreeGitDirectory: stored.worktreeGitDirectory, baseOid: stored.baseOid, branch: stored.branch, path: stored.worktreePath, markerPath: stored.markerPath, createdAt: stored.createdAt };
    return new GitWorktreeManager(dirname(dirname(stored.markerPath))).inspect(worktree).candidateFingerprint;
  }

  async inspectRecoveryOutcome(runId: RunId): Promise<ReconcileOutcome> {
    const run = this.requiredModel(runId).run;
    const attempt = this.requiredAttempt(run.activeAttemptId);
    return this.adapter.reconcile({ runId, taskId: attempt.taskId, attemptId: attempt.attemptId });
  }

  async settleRecoveredAttempt(authority: RecoverySettlementAuthority): Promise<CommandResult> {
    assertRecoverySettlementAuthority(authority);
    const attempt = this.requiredAttempt(authority.attemptId);
    if (attempt.runId !== authority.runId || attempt.taskId !== authority.taskId || attempt.providerIdentityJson !== authority.providerIdentityJson || attempt.adapterDescriptorJson !== authority.adapterDescriptorJson || this.recoveryCandidateFingerprint(authority.runId) !== authority.candidateFingerprint) throw new KerbsFlowError("RECOVERY_SETTLEMENT_STALE", "terminal evidence does not match persisted attempt, provider handle, and candidate");
    const descriptor = parseAdapterDescriptor(JSON.parse(authority.adapterDescriptorJson));
    if (authority.result.executor.adapter !== descriptor.adapter) throw new KerbsFlowError("RECOVERY_PROVIDER_MISMATCH", "terminal result differs from the persisted provider boundary");
    if (authority.result.runId !== authority.runId || authority.result.taskId !== authority.taskId || authority.result.attemptId !== authority.attemptId) throw new KerbsFlowError("RESULT_SCOPE_MISMATCH", "recovery terminal result belongs to a different attempt");
    return this.completeAttempt(authority.runId, authority.expectedStateVersion, authority.idempotencyKey, authority.result, authority);
  }

  async completeFakeAttempt(runId: RunId, expectedStateVersion: number, idempotencyKey: string, suppliedResult?: unknown): Promise<CommandResult> {
    return this.completeAttempt(runId, expectedStateVersion, idempotencyKey, suppliedResult);
  }

  async completeAttempt(runId: RunId, expectedStateVersion: number, idempotencyKey: string, suppliedResult?: unknown, recovery?: RecoverySettlementAuthority): Promise<CommandResult> {
    if (recovery !== undefined) assertRecoverySettlementAuthority(recovery);
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    let rawResult = suppliedResult;
    if (rawResult === undefined) {
      const handle = this.liveHandles.get(attempt.attemptId);
      if (handle === undefined) {
        throw new KerbsFlowError("ATTEMPT_HANDLE_MISSING", `no live executor handle exists for ${attempt.attemptId}; recovery must decide without replay`);
      }
      for await (const event of this.adapter.events(handle)) {
        parseNormalizedEvent(event);
      }
      this.persistAttemptHandle(runId, expectedStateVersion, `${idempotencyKey}:session-identity`, attempt.attemptId, handle);
      rawResult = await this.adapter.wait(handle);
    }
    let rawJson: JsonValue;
    try {
      rawJson = parseJsonValue(rawResult, "executorResult");
    } catch {
      rawJson = { schemaVersion: "kerbsflow.executor-result/invalid", error: "result was not JSON data" };
    }
    if (containsLikelySecret(rawJson)) rawJson = { schemaVersion: "kerbsflow.executor-result/invalid", error: "likely credential material rejected before persistence" };
    let parsed: ExecutorResult | undefined;
    let malformedReason: string | undefined;
    try {
      const candidate = parseExecutorResult(rawJson);
      if (candidate.runId !== runId || candidate.taskId !== attempt.taskId || candidate.attemptId !== attempt.attemptId) {
        throw new KerbsFlowError("RESULT_SCOPE_MISMATCH", "executor result IDs do not match the active attempt");
      }
      parsed = candidate;
    } catch (error) {
      malformedReason = error instanceof Error ? error.message : "malformed executor result";
    }
    if (parsed?.outcome === "blocked") {
      if (parsed.humanGate === null) {
        throw new KerbsFlowError("HUMAN_GATE_REQUIRED", "blocked executor result must contain a human gate");
      }
      this.assertExecutorGate(parsed.humanGate, runId, attempt.taskId, attempt.attemptId);
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "complete_attempt", {
      attemptId: attempt.attemptId,
      result: rawJson,
      ...(recovery === undefined ? {} : { recoveryBinding: { providerIdentityJson: recovery.providerIdentityJson, adapterDescriptorJson: recovery.adapterDescriptorJson, candidateFingerprint: recovery.candidateFingerprint } }),
    }, recovery?.commandId);
    const result = this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "EXECUTE" && !(run.state === "RECOVERY" && recovery !== undefined && run.activeAttemptId === recovery.attemptId && run.currentTaskId === recovery.taskId)) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `attempt completion requires EXECUTE, found ${run.state}`);
      }
      const current = this.attemptInTransaction(tx, attempt.attemptId);
      if (current.lifecycle !== "RUNNING" && current.lifecycle !== "PREPARED") {
        throw new KerbsFlowError("ATTEMPT_NOT_ACTIVE", `attempt ${current.attemptId} is ${current.lifecycle}`);
      }
      const cancellation = tx.get("SELECT status FROM cancellation_intents WHERE attempt_id = ?", current.attemptId) as Record<string, unknown> | undefined;
      if (cancellation !== undefined) {
        throw new KerbsFlowError("ATTEMPT_CANCELLATION_PENDING", `attempt ${current.attemptId} has durable cancellation intent; normal result ingestion is blocked`);
      }
      if (recovery !== undefined && (current.providerIdentityJson !== recovery.providerIdentityJson || current.adapterDescriptorJson !== recovery.adapterDescriptorJson || this.recoveryCandidateFingerprint(runId) !== recovery.candidateFingerprint)) throw new KerbsFlowError("RECOVERY_SETTLEMENT_STALE", "recovery identity changed before commit");
      const artifact = this.artifacts.put(runId, "executor-result", JSON.stringify(rawJson), attempt.attemptId);
      const persistedResult = parsed === undefined ? undefined : { ...parsed, artifacts: [...parsed.artifacts, artifact.artifactId] };
      this.insertArtifact(tx, artifact, now);
      if (persistedResult === undefined) {
        const storedMalformed = { schemaVersion: "kerbsflow.executor-result/invalid", failureClass: "executor_error", summary: malformedReason ?? "malformed executor result", raw: rawJson };
        tx.run("UPDATE attempts SET lifecycle = ?, outcome_json = ?, failure_class = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", "UNKNOWN", JSON.stringify(storedMalformed), "executor_error", now, now, current.attemptId);
        tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "recovery_required", now, current.taskId);
        return {
          transition: {
            to: "RECOVERY",
            actor: "adapter",
            reasonCode: "malformed_executor_result",
            taskId: current.taskId,
            attemptId: current.attemptId,
            payload: { failureClass: "executor_error", diagnostic: malformedReason ?? "malformed executor result" },
          },
          runPatch: { recoveryRequired: true, recoveryReason: malformedReason ?? "malformed executor result" },
          details: { attemptId: current.attemptId, malformed: true, failureClass: "executor_error" },
        } satisfies CommandMutation;
      }
      const lifecycle = outcomeToAttemptLifecycle(persistedResult.outcome);
      tx.run("UPDATE attempts SET lifecycle = ?, outcome_json = ?, failure_class = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", lifecycle, JSON.stringify(persistedResult), persistedResult.failureClass, now, now, current.attemptId);
      if (recovery !== undefined && persistedResult.outcome === "failed") return {
        transition: { to: "FAILED", actor: "recovery", reasonCode: "recovered_terminal_failure_no_owned_retry", taskId: current.taskId, attemptId: current.attemptId, payload: { failureClass: persistedResult.failureClass } },
        runPatch: { recoveryRequired: false, recoveryReason: null }, details: { attemptId: current.attemptId, outcome: "failed" },
      } satisfies CommandMutation;
      if (persistedResult.outcome === "blocked") {
        if (persistedResult.humanGate === null) {
          throw new KerbsFlowError("HUMAN_GATE_REQUIRED", "blocked executor result must contain a human gate");
        }
        const proposed = this.assertExecutorGate(persistedResult.humanGate, runId, current.taskId, current.attemptId);
        const gate: HumanGate = { ...proposed, evidenceRefs: [artifact.artifactId], evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(`validation_gate_${proposed.gateId}`), kind: "other", classification: "not_tested", summary: "Core-owned executor result; claims are not independently validated", artifactRef: artifact.artifactId }, ...(proposed.evidence ?? []).map(({ artifactRef: _ref, ...e }) => e)] };
        this.insertGate(tx, gate, now);
        tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "blocked", now, current.taskId);
        return {
          transition: {
            to: "HUMAN_GATE",
            actor: "adapter",
            reasonCode: "executor_blocked",
            taskId: current.taskId,
            attemptId: current.attemptId,
            gateId: gate.gateId,
            payload: { outcome: persistedResult.outcome, failureClass: persistedResult.failureClass },
          },
          runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
          details: { attemptId: current.attemptId, outcome: persistedResult.outcome, gateId: gate.gateId },
        } satisfies CommandMutation;
      }
      if (persistedResult.outcome === "cancelled") {
        tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "cancelled", now, current.taskId);
        return {
          transition: {
            to: recovery === undefined ? "RECOVERY" : "CANCELLED",
            actor: recovery === undefined ? "adapter" : "recovery",
            reasonCode: "adapter_cancelled",
            taskId: current.taskId,
            attemptId: current.attemptId,
            payload: { outcome: persistedResult.outcome },
          },
          runPatch: { recoveryRequired: recovery === undefined, recoveryReason: recovery === undefined ? "adapter cancellation requires reconciliation" : null },
          details: { attemptId: current.attemptId, outcome: persistedResult.outcome },
        } satisfies CommandMutation;
      }
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "verification_pending", now, current.taskId);
      return {
        transition: {
          to: "VERIFY_FOCUSED",
          actor: "adapter",
          reasonCode: "attempt_terminal",
          taskId: current.taskId,
          attemptId: current.attemptId,
          payload: { outcome: persistedResult.outcome, failureClass: persistedResult.failureClass },
        },
        runPatch: { currentGateId: null, recoveryRequired: false, recoveryReason: null },
        details: { attemptId: current.attemptId, outcome: persistedResult.outcome, failureClass: persistedResult.failureClass },
      } satisfies CommandMutation;
    });
    this.liveHandles.delete(attempt.attemptId);
    return result;
  }

  recordFocusedValidation(runId: RunId, expectedStateVersion: number, idempotencyKey: string, value: unknown): CommandResult {
    const bundle = parseValidationBundle(value);
    if (bundle.runId !== runId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "validation runId does not match the command run");
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "validation", { bundle: parseJsonValue(bundle, "validation") });
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "VERIFY_FOCUSED") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `focused validation requires VERIFY_FOCUSED, found ${run.state}`);
      }
      if (bundle.level !== "focused") {
        throw new KerbsFlowError("VALIDATION_LEVEL_MISMATCH", "VERIFY_FOCUSED accepts only focused validation evidence");
      }
      if (run.currentTaskId === null || bundle.taskId !== run.currentTaskId) {
        throw new KerbsFlowError("TASK_SCOPE_MISMATCH", "validation task is not the current task");
      }
      if (run.activeAttemptId === null || bundle.attemptId === undefined || bundle.attemptId !== run.activeAttemptId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "focused validation must identify the current active attempt");
      }
      const attempt = this.attemptInTransaction(tx, run.activeAttemptId);
      if (attempt.runId !== runId || attempt.taskId !== run.currentTaskId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "active attempt does not belong to the current run and task");
      }
      const persisted = this.store.getValidation(bundle.validationId);
      if (persisted === undefined || canonicalJson(persisted.bundle) !== canonicalJson(bundle)) throw new KerbsFlowError("VALIDATION_AUTHORITY_REQUIRED", "focused validation requires immutable persisted independent authority");
      this.assertFocusedAuthority(bundle);
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "review_pending", now, bundle.taskId);
      return {
        transition: {
          to: "REVIEW",
          actor: "verifier",
          reasonCode: "focused_validation_persisted",
          taskId: bundle.taskId,
          attemptId: bundle.attemptId ?? run.activeAttemptId,
          payload: { validationId: bundle.validationId, outcome: bundle.outcome },
        },
        runPatch: { recoveryRequired: false, recoveryReason: null },
        details: { validationId: bundle.validationId, outcome: bundle.outcome },
      } satisfies CommandMutation;
    });
  }

  review(runId: RunId, expectedStateVersion: number, idempotencyKey: string, value: unknown): CommandResult {
    const decision = parseReviewDecision(value);
    if (decision.runId !== runId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "review runId does not match the command run");
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "review", { decision: parseJsonValue(decision, "reviewDecision") });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "REVIEW") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `review requires REVIEW, found ${run.state}`);
      }
      if (run.currentTaskId === null || decision.taskId !== run.currentTaskId) {
        throw new KerbsFlowError("TASK_SCOPE_MISMATCH", "review task is not the current task");
      }
      if (run.activeAttemptId === null) {
        throw new KerbsFlowError("ATTEMPT_REQUIRED", "review requires a current active implementation attempt");
      }
      const attempt = this.attemptInTransaction(tx, run.activeAttemptId);
      if (attempt.runId !== runId || attempt.taskId !== decision.taskId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "review attempt does not belong to the current run and task");
      }
      const validation = this.focusedValidationInTransaction(tx, runId, decision.taskId, run.activeAttemptId);
      if (validation === undefined) {
        throw new KerbsFlowError("VALIDATION_REQUIRED", "review requires persisted independent validation evidence");
      }
      if ((decision.outcome === "next_phase" || decision.outcome === "final_verify" || decision.outcome === "verify_phase") && validation.outcome !== "passed") {
        throw new KerbsFlowError("VALIDATION_NOT_PASSED", `review outcome ${decision.outcome} requires passed validation evidence`);
      }
      const attemptCount = numberFromCount(tx.get("SELECT COUNT(*) AS count FROM attempts WHERE task_id = ? AND lifecycle != 'CANCELLED'", decision.taskId));
      if (decision.outcome === "rework" && attemptCount >= this.configuration.effectiveMaxImplementationAttempts) {
        throw new KerbsFlowError("RETRY_BUDGET_EXCEEDED", `task ${decision.taskId} has exhausted its bounded implementation attempts`);
      }
      tx.run("INSERT INTO reviews (review_id, run_id, task_id, outcome, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", decision.reviewId, runId, decision.taskId, decision.outcome, JSON.stringify(decision), now);
      const target = reviewTarget(decision.outcome);
      let gate: HumanGate | undefined;
      if (decision.outcome === "human_gate") {
        gate = {
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId(nextId("gate")),
          runId,
          taskId: decision.taskId,
          evidenceRefs: decision.evidenceRefs,
          reasonCode: decision.reasonCode,
          summary: decision.summary,
          options: [
            { id: "fail", label: "Fail the run", consequence: "Stop automatic continuation and preserve evidence.", target: "FAILED" },
            { id: "cancel", label: "Cancel this run", consequence: "Stop this run without accepting the review outcome; preserve evidence for a new run.", target: "CANCELLED" },
          ],
          ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
          ...(decision.failureClass === undefined || (decision.evidenceRefs.length === 0 && (decision.evidence?.length ?? 0) === 0) ? {} : { recommendation: `Investigate ${decision.failureClass} before continuing.` }),
          status: "open",
        };
        this.insertGate(tx, gate, now);
      }
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", taskStatusForReview(decision.outcome), now, decision.taskId);
      return {
        transition: {
          to: target,
          actor: "verifier",
          reasonCode: decision.reasonCode,
          taskId: decision.taskId,
          gateId: gate?.gateId ?? null,
          payload: { reviewId: decision.reviewId, outcome: decision.outcome, ...(decision.failureClass === undefined ? {} : { failureClass: decision.failureClass }) },
        },
        runPatch: { currentGateId: gate?.gateId ?? null, recoveryRequired: false, recoveryReason: null },
        details: { reviewId: decision.reviewId, outcome: decision.outcome, ...(gate === undefined ? {} : { gateId: gate.gateId }) },
      } satisfies CommandMutation;
    });
  }

  completeTrustedPhaseValidation(
    runId: RunId,
    expectedStateVersion: number,
    idempotencyKey: string,
    input: {
      validationId: ValidationId;
      semanticReviewId?: ReviewId;
    },
  ): CommandResult {
    const persistedValidation = this.store.getValidation(input.validationId);
    const authority = this.store.getPhaseValidationAuthority(input.validationId);
    if (persistedValidation === undefined || authority === undefined) {
      throw new KerbsFlowError("PHASE_VALIDATION_UNPERSISTED", "trusted phase closure requires a previously persisted authoritative phase validation");
    }
    const validation = persistedValidation.bundle;
    const declaration = this.store.getValidationIntent(runId, "phase");
    if (authority.declaration == null || declaration === undefined || checkIntentHash(declaration) !== authority.commandHash || checkIntentHash(authority.declaration) !== authority.commandHash || declaration.commandId !== authority.commandId) throw new KerbsFlowError("CHECK_INTENT_MISMATCH", "phase evidence has no matching trusted declaration");
    const storedWorktree = this.store.getWorktree(runId);
    if (storedWorktree === undefined) {
      throw new KerbsFlowError("WORKTREE_RECORD_REQUIRED", "trusted phase closure requires the persisted owned worktree");
    }
    const worktree: WorktreeRecord = {
      schemaVersion: "kerbsflow.worktree/v1",
      runKey: runId,
      repositoryPath: storedWorktree.repositoryPath,
      gitCommonDirectory: storedWorktree.gitCommonDirectory,
      worktreeGitDirectory: storedWorktree.worktreeGitDirectory,
      baseOid: storedWorktree.baseOid,
      branch: storedWorktree.branch,
      path: storedWorktree.worktreePath,
      markerPath: storedWorktree.markerPath,
      createdAt: storedWorktree.createdAt,
    };
    const inspection = new GitWorktreeManager(dirname(dirname(storedWorktree.markerPath))).inspect(worktree);
    const currentBinding = bindingFor(worktree, inspection);
    if (canonicalJson(currentBinding) !== canonicalJson({
      worktreePath: authority.worktreePath,
      worktreeGitDirectory: authority.worktreeGitDirectory,
      baseOid: authority.baseOid,
      diffHash: authority.diffHash,
      changedPathsHash: authority.changedPathsHash,
      changedPaths: authority.changedPaths,
      candidateFingerprint: authority.candidateFingerprint,
      headOid: authority.headOid,
    })) {
      throw new KerbsFlowError("PHASE_VALIDATION_STALE", "owned worktree diff or changed-path evidence changed after phase validation");
    }
    const persistedReview = input.semanticReviewId === undefined ? undefined : this.store.getSemanticReviewAttempt(input.semanticReviewId);
    const semanticReview = persistedReview?.result ?? undefined;
    if (input.semanticReviewId !== undefined) {
      if (persistedReview?.lifecycle !== "SUCCEEDED" || semanticReview === undefined) {
        throw new KerbsFlowError("REVIEW_EVIDENCE_UNPERSISTED", "trusted phase closure requires the exact persisted terminal semantic review result");
      }
      const reviewedTask = this.store.getTask(persistedReview.taskId);
      if (
        persistedReview.request.diffHash !== authority.diffHash
        || !persistedReview.request.validationIds.includes(validation.validationId)
        || reviewedTask?.decision.canonicalContextHash !== persistedReview.request.canonicalContextHash
      ) {
        throw new KerbsFlowError("REVIEW_EVIDENCE_STALE", "semantic review evidence does not match the canonical context, diff, and validation used for phase closure");
      }
    }
    const antiGreenwashing = detectAntiGreenwashing(inspection.diff, inspection.changedPaths);
    const canonicalSnapshot = this.store.getCanonicalSnapshot(runId);
    let canonicalIntentCurrent = false;
    if (canonicalSnapshot !== undefined) {
      try {
        const observedCanonicalHashes = hashCanonicalDocuments(canonicalSnapshot.repositoryPath);
        canonicalIntentCurrent = canonicalJson(canonicalSnapshot.hashes) === canonicalJson(observedCanonicalHashes);
      } catch {
        canonicalIntentCurrent = false;
      }
    }
    const trusted = decideTrustedReview({
      requiredLevel: "phase",
      validation,
      antiGreenwashing,
      ...(semanticReview === undefined ? {} : { semanticReview }),
      canonicalIntentCurrent,
      phaseCloseRequested: true,
    });
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "phase", {
      validationId: validation.validationId,
      diffHash: authority.diffHash,
      ...(semanticReview === undefined ? {} : { semanticReviewId: semanticReview.reviewAttemptId }),
    });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "VERIFY_PHASE" || run.currentTaskId === null || run.activeAttemptId === null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "trusted phase validation requires VERIFY_PHASE with a current task and attempt");
      }
      if (validation.runId !== runId || validation.taskId !== run.currentTaskId || validation.attemptId !== run.activeAttemptId) {
        throw new KerbsFlowError("VALIDATION_SCOPE_MISMATCH", "phase validation is stale or belongs to another run/task/attempt");
      }
      if (semanticReview !== undefined && (semanticReview.runId !== runId || semanticReview.taskId !== run.currentTaskId || semanticReview.attemptId !== run.activeAttemptId)) {
        throw new KerbsFlowError("REVIEW_SCOPE_MISMATCH", "semantic review is stale or belongs to another run/task/attempt");
      }
      const reviewId = asReviewId(nextId("review"));
      const reviewDecision: ReviewDecision = {
        schemaVersion: CONTRACT_VERSIONS.reviewDecision,
        reviewId,
        runId,
        taskId: validation.taskId,
        outcome: trusted.outcome,
        ...(trusted.failureClass === undefined ? {} : { failureClass: trusted.failureClass }),
        summary: trusted.reasonCode,
        evidenceRefs: trusted.evidence.flatMap((evidence) => evidence.artifactRef === undefined ? [] : [evidence.artifactRef]),
        evidence: trusted.evidence,
        reasonCode: trusted.reasonCode,
      };
      tx.run("INSERT INTO reviews (review_id, run_id, task_id, outcome, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", reviewId, runId, validation.taskId, trusted.outcome, JSON.stringify(reviewDecision), now);
      let gate: HumanGate | undefined;
      if (trusted.outcome === "human_gate") {
        gate = {
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId(nextId("gate")),
          runId,
          taskId: validation.taskId,
          attemptId: validation.attemptId,
          reasonCode: trusted.reasonCode,
          summary: "trusted phase closure cannot continue automatically",
          evidenceRefs: reviewDecision.evidenceRefs,
          evidence: trusted.evidence,
          options: [
            { id: "fail", label: "Fail conservatively", consequence: "Stop automatic continuation and preserve all evidence.", target: "FAILED" },
            { id: "cancel", label: "Cancel this run", consequence: "Stop without closing the phase; preserve the validation evidence.", target: "CANCELLED" },
          ],
          ...(trusted.evidence.length === 0 ? {} : { recommendation: "Resolve the cited evidence gap before continuing." }),
          status: "open",
        };
        this.insertGate(tx, gate, now);
      }
      const target = trusted.outcome === "next_phase" ? "NEXT_PHASE" : trusted.outcome === "rework" ? "REWORK" : trusted.outcome === "human_gate" ? "HUMAN_GATE" : "VERIFY_PHASE";
      if (target === "VERIFY_PHASE") {
        throw new KerbsFlowError("PHASE_VALIDATION_INCOMPLETE", "trusted phase validation did not reach a closure decision");
      }
      return {
        transition: {
          to: target,
          actor: "verifier",
          reasonCode: trusted.reasonCode,
          taskId: validation.taskId,
          attemptId: validation.attemptId,
          gateId: gate?.gateId ?? null,
          payload: { validationId: validation.validationId, reviewId },
        },
        runPatch: { currentGateId: gate?.gateId ?? null, recoveryRequired: false, recoveryReason: null },
        details: { validationId: validation.validationId, reviewId, outcome: trusted.outcome },
      } satisfies CommandMutation;
    });
  }

  completeTrustedFullValidation(runId: RunId, expectedStateVersion: number, idempotencyKey: string, validationId: ValidationId): CommandResult {
    const persisted = this.store.getValidation(validationId);
    const authority = this.store.getPhaseValidationAuthority(validationId);
    const declaration = this.store.getValidationIntent(runId, "full");
    if (persisted === undefined || authority === undefined || persisted.bundle.level !== "full" || persisted.bundle.runId !== runId || authority.declaration == null || authority.declaration.level !== "full" || declaration === undefined || checkIntentHash(declaration) !== authority.commandHash || checkIntentHash(authority.declaration) !== authority.commandHash || declaration.commandId !== authority.commandId) throw new KerbsFlowError("FULL_VALIDATION_AUTHORITY_REQUIRED", "full completion requires matching persisted full declaration and verifier authority");
    const binding = this.currentCandidateBinding(runId);
    if (binding.candidateFingerprint !== authority.candidateFingerprint || binding.headOid !== authority.headOid || binding.diffHash !== authority.diffHash || binding.baseOid !== authority.baseOid || binding.worktreePath !== authority.worktreePath || binding.worktreeGitDirectory !== authority.worktreeGitDirectory) throw new KerbsFlowError("FULL_VALIDATION_STALE", "full evidence belongs to a changed candidate");
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "validation", { validationId, level: "full", candidateFingerprint: authority.candidateFingerprint });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      const validation = persisted.bundle;
      if (run.state !== "FINAL_VERIFY" || validation.taskId !== run.currentTaskId || validation.attemptId !== run.activeAttemptId) throw new KerbsFlowError("VALIDATION_SCOPE_MISMATCH", "full evidence differs from current FINAL_VERIFY context");
      if (validation.outcome !== "passed" || validation.checks.length === 0 || validation.checks.some(check => check.outcome !== "passed") || !validation.evidence.some(e => e.kind === "command" && e.classification === "automatically_tested")) return { transition: { to: "FAILED", actor: "verifier", reasonCode: "full_validation_failed", taskId: validation.taskId, attemptId: validation.attemptId, payload: { validationId } }, details: { validationId, outcome: "failed" } } satisfies CommandMutation;
      const phaseRows = tx.all("SELECT validation_id, level, outcome, bundle_json FROM validations WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND level = 'phase' ORDER BY created_at DESC LIMIT 20", runId, validation.taskId, validation.attemptId!);
      const acceptedPhaseIds = new Set(tx.all("SELECT payload_json FROM transitions WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND from_state = 'VERIFY_PHASE' AND to_state = 'NEXT_PHASE' AND reason_code = 'trusted_phase_close'", runId, validation.taskId, validation.attemptId!).map(row => (JSON.parse(String(row.payload_json)) as { validationId?: string }).validationId));
      const matchingPhase = phaseRows.filter(row => {
        const phaseAuthority = this.store.getPhaseValidationAuthority(asValidationId(String(row.validation_id)));
        return row.outcome === "passed" && acceptedPhaseIds.has(String(row.validation_id)) && phaseAuthority?.candidateFingerprint === authority.candidateFingerprint;
      });
      if (matchingPhase.length === 0) throw new KerbsFlowError("RELEASE_PHASE_EVIDENCE_REQUIRED", "release gate requires accepted phase evidence");
      const reviews = tx.all("SELECT review_id, outcome FROM reviews WHERE run_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 20", runId, validation.taskId);
      const descriptor = this.store.getAttempt(validation.attemptId!)?.adapterDescriptorJson;
      const adapter = descriptor === null || descriptor === undefined ? null : parseAdapterDescriptor(JSON.parse(descriptor));
      const bundle = {
        schemaVersion: "kerbsflow.release-bundle/v1", runId, taskId: validation.taskId, attemptId: validation.attemptId,
        candidate: { headOid: authority.headOid, baseOid: authority.baseOid, fingerprint: authority.candidateFingerprint, diffHash: authority.diffHash, changedPathsHash: authority.changedPathsHash },
        fullValidation: { validationId, commandId: authority.commandId, declarationHash: authority.commandHash, positiveProof: "matched", classification: "automatically_tested", evidence: validation.evidence.map(e => ({ id: e.id, kind: e.kind, classification: e.classification, summary: e.kind === "command" ? "Trusted full check executed with matching positive proof" : "Independent full-validation evidence; consult the validation record" })) },
        phaseValidations: matchingPhase.map(row => ({ validationId: String(row.validation_id), outcome: String(row.outcome), classification: "automatically_tested" })),
        reviews: reviews.map(row => ({ reviewId: String(row.review_id), outcome: String(row.outcome), classification: "not_tested", summary: "Persisted review decision; acceptance-specific review proof is not inferred" })),
        acceptanceEvidence: Array.from({ length: 15 }, (_, index) => ({ acceptanceId: `AC${index + 1}`, classification: "not_tested", summary: "No acceptance-specific evidence was declared; full check success does not independently prove this acceptance criterion", references: [] })),
        facts: { runtime: process.version, platform: process.platform, officialSupport: "macOS only; Linux unsupported preview; Windows unsupported", license: "Apache-2.0", copyright: "Teyocesu 2026", adapter: adapter?.adapter ?? "unknown", adapterVersion: adapter?.adapterVersion ?? "unknown" },
        limitations: ["Human readiness decision only; no commit, push, merge, tag, release, publish, deployment or production action", ...(adapter?.adapter === "opencode" ? ["OpenCode workload isolation is tool_policy_only; no OS enforcement claim"] : []), "Acceptance-specific missing evidence remains not_tested"],
      };
      const json = JSON.stringify(bundle);
      if (Buffer.byteLength(json) > 128 * 1024 || containsLikelySecret(json)) throw new KerbsFlowError("RELEASE_BUNDLE_UNSAFE", "release bundle exceeds its bound or contains sensitive material");
      const artifact = this.artifacts.put(runId, "release-readiness", json, validation.attemptId);
      this.insertArtifact(tx, artifact, now);
      const gateId = asGateId(nextId("gate"));
      const gate: HumanGate = { schemaVersion: CONTRACT_VERSIONS.humanGate, gateId, runId, taskId: validation.taskId, ...(validation.attemptId === undefined ? {} : { attemptId: validation.attemptId }), reasonCode: "release_readiness_decision", summary: `Candidate ${authority.headOid}; fingerprint ${authority.candidateFingerprint}; full ${validationId} passed. AC1–AC15 acceptance-specific support is not_tested. Human readiness decision has no remote side effect.`, evidenceRefs: [artifact.artifactId], evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(nextId("validation")), kind: "command", classification: "automatically_tested", summary: `Trusted full check ${declaration.commandId} passed for the exact candidate`, artifactRef: artifact.artifactId }, { schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(nextId("validation")), kind: "other", classification: "not_tested", summary: "AC1–AC15 acceptance-specific support missing; inspect the immutable bundle and known limitations" }], options: [{ id: "accept_readiness", label: "Accept release readiness", consequence: "Record the human readiness decision as DONE. No release action occurs.", target: "DONE" }, { id: "request_corrections", label: "Request corrections", consequence: "Persist a corrections request for a separately approved remediation run; this gate remains open.", target: "HUMAN_RELEASE_GATE" }, { id: "cancel_readiness", label: "Cancel readiness", consequence: "Cancel this readiness run and preserve the evidence.", target: "CANCELLED" }], status: "open" };
      this.insertGate(tx, gate, now);
      tx.run("INSERT INTO release_bundles (gate_id, run_id, full_validation_id, candidate_fingerprint, head_oid, bundle_json, bundle_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", gateId, runId, validationId, authority.candidateFingerprint, authority.headOid, json, createHash("sha256").update(json).digest("hex"), now);
      return { transition: { to: "HUMAN_RELEASE_GATE", actor: "verifier", reasonCode: "full_validation_accepted", taskId: validation.taskId, attemptId: validation.attemptId, gateId, payload: { validationId, candidateFingerprint: authority.candidateFingerprint } }, runPatch: { currentGateId: gateId }, details: { gateId, validationId } } satisfies CommandMutation;
    });
  }

  private currentCandidateBinding(runId: RunId) {
    const stored = this.store.getWorktree(runId);
    if (stored === undefined) throw new KerbsFlowError("WORKTREE_RECORD_REQUIRED", "validation requires persisted worktree ownership");
    const worktree: WorktreeRecord = { schemaVersion: "kerbsflow.worktree/v1", runKey: runId, repositoryPath: stored.repositoryPath, gitCommonDirectory: stored.gitCommonDirectory, worktreeGitDirectory: stored.worktreeGitDirectory, baseOid: stored.baseOid, branch: stored.branch, path: stored.worktreePath, markerPath: stored.markerPath, createdAt: stored.createdAt };
    return bindingFor(worktree, new GitWorktreeManager(dirname(dirname(stored.markerPath))).inspect(worktree));
  }

  resolveReleaseGate(runId: RunId, expectedStateVersion: number, idempotencyKey: string, gateId: GateId, optionId: string, note?: string, commandId?: CommandId): CommandResult {
    if (note !== undefined && (Buffer.byteLength(note) > 2048 || containsLikelySecret(note))) throw new KerbsFlowError("RELEASE_NOTE_INVALID", "human note must be bounded and contain no likely credential");
    if (!["accept_readiness", "request_corrections", "cancel_readiness"].includes(optionId)) throw new KerbsFlowError("GATE_OPTION_INVALID", "release gate supports only readiness, corrections, or cancellation");
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "gate_resolution", { gateId, optionId, ...(note === undefined ? {} : { note }) }, commandId);
    const replay = this.store.replayCommand(command);
    if (replay !== undefined) return replay;
    const bundle = this.store.getReleaseBundle(gateId);
    if (bundle === undefined) throw new KerbsFlowError("RELEASE_BUNDLE_REQUIRED", "release gate has no trusted immutable evidence bundle");
    if (optionId === "accept_readiness" && this.currentCandidateBinding(runId).candidateFingerprint !== bundle.candidateFingerprint) throw new KerbsFlowError("RELEASE_CANDIDATE_STALE", "candidate changed after release bundle creation");
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "HUMAN_RELEASE_GATE" || run.currentGateId !== gateId) throw new KerbsFlowError("GATE_SCOPE_MISMATCH", "exact release gate is not open at this state version");
      const stored = this.gateInTransaction(tx, gateId);
      if (stored.runId !== runId || stored.status !== "open" || !stored.gate.options.some(option => option.id === optionId)) throw new KerbsFlowError("GATE_OPTION_INVALID", "release option differs from immutable offered options");
      if (optionId === "request_corrections") {
        if (tx.get("SELECT gate_id FROM release_corrections WHERE gate_id = ?", gateId) !== undefined) throw new KerbsFlowError("RELEASE_CORRECTIONS_CONFLICT", "corrections request already persisted for this exact bundle");
        tx.run("INSERT INTO release_corrections (gate_id, run_id, command_id, actor, note, created_at) VALUES (?, ?, ?, 'human', ?, ?)", gateId, runId, command.commandId, note ?? "", now);
        return { details: { gateId, optionId, disposition: "corrections_requested_for_separately_approved_run" } } satisfies CommandMutation;
      }
      const target = optionId === "accept_readiness" ? "DONE" : "CANCELLED";
      const gate: HumanGate = { ...stored.gate, status: target === "DONE" ? "resolved" : "rejected", resolution: { optionId, actor: "human", resolvedAt: now, ...(note === undefined ? {} : { note }) } };
      tx.run("UPDATE human_gates SET status = ?, gate_json = ?, resolved_at = ? WHERE gate_id = ?", gate.status, JSON.stringify(gate), now, gateId);
      return { transition: { to: target, actor: "human", reasonCode: "human_release_readiness_decision", gateId, payload: { optionId, bundleHash: bundle.bundleHash } }, runPatch: { currentGateId: null }, details: { gateId, optionId, target, remoteAction: false } } satisfies CommandMutation;
    });
  }

  gateMissingPhaseValidation(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "phase", { reasonCode: "phase_validation_plan_missing" });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "VERIFY_PHASE" || run.currentTaskId === null || run.activeAttemptId === null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "missing phase validation can only gate a current VERIFY_PHASE attempt");
      }
      const gate: HumanGate = {
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(nextId("gate")),
        runId,
        taskId: run.currentTaskId,
        attemptId: run.activeAttemptId,
        reasonCode: "phase_validation_plan_missing",
        summary: "an explicit phase-level validation command is required before phase closure",
        evidenceRefs: [],
        options: [
          { id: "fail", label: "Fail conservatively", consequence: "Phase closure cannot proceed without the trusted phase validation profile; preserve evidence and stop this run.", target: "FAILED" },
          { id: "cancel", label: "Cancel this run", consequence: "Stop without closing the phase; start a new run only after the host launch profile includes the required phase validation.", target: "CANCELLED" },
        ],
        status: "open",
      };
      this.insertGate(tx, gate, now);
      return {
        transition: { to: "HUMAN_GATE", actor: "verifier", reasonCode: gate.reasonCode, taskId: run.currentTaskId, attemptId: run.activeAttemptId, gateId: gate.gateId },
        runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
        details: { gateId: gate.gateId, reasonCode: gate.reasonCode },
      } satisfies CommandMutation;
    });
  }

  gateVerificationSandboxUnavailable(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "validation", { reasonCode: "verification_sandbox_unavailable" });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if ((run.state !== "VERIFY_FOCUSED" && run.state !== "VERIFY_PHASE" && run.state !== "FINAL_VERIFY") || run.currentTaskId === null || run.activeAttemptId === null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "sandbox availability gate requires a current verification attempt");
      }
      const gate: HumanGate = {
        schemaVersion: CONTRACT_VERSIONS.humanGate,
        gateId: asGateId(nextId("gate")), runId, taskId: run.currentTaskId,
        attemptId: run.activeAttemptId, reasonCode: "verification_sandbox_unavailable",
        summary: "required filesystem and workload-network verification isolation is unavailable or unproven",
        evidenceRefs: [],
        options: [
          { id: "fail", label: "Fail conservatively", consequence: "Stop because required verification isolation is unavailable; retain the worktree and evidence.", target: "FAILED" },
          { id: "cancel", label: "Cancel this run", consequence: "Stop without accepting unverified work; start a new run after the host restores verification isolation.", target: "CANCELLED" },
        ], status: "open",
      };
      this.insertGate(tx, gate, now);
      return {
        transition: { to: "HUMAN_GATE", actor: "verifier", reasonCode: gate.reasonCode, taskId: run.currentTaskId, attemptId: run.activeAttemptId, gateId: gate.gateId },
        runPatch: { currentGateId: gate.gateId, recoveryRequired: false, recoveryReason: null },
        details: { gateId: gate.gateId, reasonCode: gate.reasonCode },
      } satisfies CommandMutation;
    });
  }

  applyPhaseFailurePolicy(runId: RunId, expectedStateVersion: number, idempotencyKey: string, fingerprint: string): CommandResult {
    const model = this.store.readModel(runId);
    if (model?.run.currentTaskId === null || model?.run.activeAttemptId === null || model?.run.currentTaskId === undefined || model.run.activeAttemptId === undefined) {
      throw new KerbsFlowError("FAILURE_POLICY_SCOPE_MISMATCH", "phase failure policy requires a current task and attempt");
    }
    const policy = this.store.getFailureOccurrenceForAttempt(runId, model.run.currentTaskId, model.run.activeAttemptId, fingerprint);
    if (policy === undefined || policy.attemptId === null) {
      throw new KerbsFlowError("FAILURE_POLICY_REQUIRED", "phase failure transition requires the persisted policy decision for the current attempt");
    }
    const attemptId = policy.attemptId;
    const target = policy.resultingAction === "retry_same_route" || policy.resultingAction === "rework" || policy.resultingAction === "escalate"
      ? "REWORK"
      : policy.resultingAction === "failed" ? "FAILED" : "HUMAN_GATE";
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "phase", { fingerprint, action: policy.resultingAction });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if ((run.state !== "VERIFY_PHASE" && !(run.state === "REWORK" && (target === "HUMAN_GATE" || target === "FAILED")))
        || run.currentTaskId !== policy.taskId || run.activeAttemptId !== attemptId) {
        throw new KerbsFlowError("FAILURE_POLICY_SCOPE_MISMATCH", "persisted phase failure policy is stale for the current run/task/attempt");
      }
      const reviewId = asReviewId(nextId("review"));
      const reasonCode = policy.escalationReason ?? policy.resultingAction;
      const decision: ReviewDecision = {
        schemaVersion: CONTRACT_VERSIONS.reviewDecision,
        reviewId,
        runId,
        taskId: policy.taskId,
        outcome: target === "REWORK" ? "rework" : target === "FAILED" ? "failed" : "human_gate",
        failureClass: policy.failureClass as FailureClassification,
        summary: `phase failure policy selected ${policy.resultingAction}`,
        evidenceRefs: [],
        reasonCode,
      };
      tx.run("INSERT INTO reviews (review_id, run_id, task_id, outcome, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", reviewId, runId, policy.taskId, decision.outcome, JSON.stringify(decision), now);
      let gate: HumanGate | undefined;
      if (target === "HUMAN_GATE") {
        const createdGate: HumanGate = {
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId(nextId("gate")),
          runId,
          taskId: policy.taskId,
          attemptId,
          reasonCode,
          summary: "phase failure policy requires human review",
          evidenceRefs: [],
          options: [
            { id: "fail", label: "Fail", consequence: "Stop and preserve the phase failure evidence.", target: "FAILED" },
            { id: "cancel", label: "Cancel this run", consequence: "Stop without accepting the failed phase; preserve evidence for a new run.", target: "CANCELLED" },
          ],
          status: "open",
        };
        gate = createdGate;
        this.insertGate(tx, createdGate, now);
      }
      return {
        transition: { to: target, actor: "verifier", reasonCode, taskId: policy.taskId, attemptId, gateId: gate?.gateId ?? null, payload: { fingerprint, action: policy.resultingAction, reviewId } },
        runPatch: { currentGateId: gate?.gateId ?? null, recoveryRequired: false, recoveryReason: null },
        details: { action: policy.resultingAction, reviewId, ...(gate === undefined ? {} : { gateId: gate.gateId }) },
      } satisfies CommandMutation;
    });
  }

  completePhase(runId: RunId, expectedStateVersion: number, idempotencyKey: string, target: "PLAN" | "FINAL_VERIFY"): CommandResult {
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "phase", { target });
    return this.store.executeCommand(command, ({ run }) => {
      if (run.state !== "NEXT_PHASE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `phase completion requires NEXT_PHASE, found ${run.state}`);
      }
      return {
        transition: {
          to: target,
          actor: "core",
          reasonCode: target === "PLAN" ? "phase_complete_next_phase" : "phase_complete_final_ready",
          payload: { target },
        },
        runPatch: { currentTaskId: target === "PLAN" ? null : run.currentTaskId, recoveryRequired: false, recoveryReason: null },
        details: { target },
      } satisfies CommandMutation;
    });
  }

  reworkToReady(runId: RunId, expectedStateVersion: number, idempotencyKey: string, routeDecision?: unknown, observedSteer?: unknown): CommandResult {
    const corrected = routeDecision === undefined ? undefined : parsePlanningDecision(routeDecision);
    const observation = parsePlanningSteerObservation(observedSteer);
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "READY", "core", "rework_action_ready", { target: "READY", ...(corrected === undefined ? {} : { route: corrected.route }) });
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "REWORK" || run.currentTaskId === null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "rework readiness requires REWORK with a current task");
      }
      const task = this.taskInTransaction(tx, run.currentTaskId);
      const finalDecision = corrected ?? task.decision;
      if (finalDecision.runId !== runId || finalDecision.taskId !== task.taskId) {
        throw new KerbsFlowError("REWORK_SCOPE_MISMATCH", "rework decision does not match the persisted run and task");
      }
      assertReworkDecisionBounds(task.decision, finalDecision, this.configuration.projectPolicy.allowedAdapters);
      this.consumeObservedSteer(tx, runId, observation, command.commandId, finalDecision.decisionId, now);
      tx.run("UPDATE tasks SET status = ?, decision_json = ?, updated_at = ? WHERE task_id = ?", "ready", JSON.stringify(finalDecision), now, run.currentTaskId);
      return {
        transition: { to: "READY", actor: "core", reasonCode: "rework_action_ready", taskId: run.currentTaskId, payload: { target: "READY" } },
        runPatch: { recoveryRequired: false, recoveryReason: null },
      } satisfies CommandMutation;
    });
  }

  resolveGate(runId: RunId, expectedStateVersion: number, idempotencyKey: string, optionId: string, note?: string, commandId?: CommandId): CommandResult {
    const payload: Record<string, JsonValue> = { optionId };
    if (note !== undefined) {
      payload.note = note;
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "gate_resolution", payload, commandId);
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "HUMAN_GATE" || run.currentGateId === null) {
        throw new KerbsFlowError("GATE_NOT_OPEN", "gate resolution requires an open HUMAN_GATE");
      }
      const storedGate = this.gateInTransaction(tx, run.currentGateId);
      if (storedGate.gate.status !== "open") {
        throw new KerbsFlowError("GATE_NOT_OPEN", `gate ${storedGate.gateId} is already ${storedGate.gate.status}`);
      }
      const option = storedGate.gate.options.find((candidate) => candidate.id === optionId);
      if (option === undefined) {
        throw new KerbsFlowError("GATE_OPTION_INVALID", `option ${optionId} was not offered by the persisted gate`);
      }
      assertLegalTransition("HUMAN_GATE", option.target);
      const resolvedGate: HumanGate = {
        ...storedGate.gate,
        status: option.target === "CANCELLED" ? "rejected" : "resolved",
        resolution: {
          optionId,
          actor: "human",
          resolvedAt: now,
          ...(note === undefined ? {} : { note }),
        },
      };
      tx.run("UPDATE human_gates SET status = ?, gate_json = ?, resolved_at = ? WHERE gate_id = ?", resolvedGate.status, JSON.stringify(resolvedGate), now, storedGate.gateId);
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", option.target === "REWORK" ? "rework" : option.target === "CANCELLED" ? "cancelled" : "gate_resolved", now, storedGate.taskId ?? run.currentTaskId);
      return {
        transition: {
          to: option.target,
          actor: "human",
          reasonCode: "human_gate_resolved",
          taskId: storedGate.taskId,
          attemptId: storedGate.attemptId,
          gateId: storedGate.gateId,
          payload: { optionId },
        },
        runPatch: { currentGateId: null, recoveryRequired: false, recoveryReason: null },
        details: { gateId: storedGate.gateId, optionId, target: option.target },
      } satisfies CommandMutation;
    });
  }

  resolveGateScoped(runId: RunId, expectedStateVersion: number, idempotencyKey: string, gateId: ReturnType<typeof asGateId>, optionId: string, note?: string, commandId?: CommandId): CommandResult {
    const model = this.requiredModel(runId);
    const gate = this.store.getGate(gateId);
    const currentMatches = model.run.currentGateId === gateId;
    const replayCandidate = model.run.currentGateId === null && gate?.runId === runId && gate.status !== "open";
    if (!currentMatches && !replayCandidate) {
      throw new KerbsFlowError("GATE_SCOPE_MISMATCH", `gate scope mismatch: ${gateId} is not the current gate for run ${runId} at state version ${expectedStateVersion}`);
    }
    return this.resolveGate(runId, expectedStateVersion, idempotencyKey, optionId, note, commandId);
  }

  pause(runId: RunId, expectedStateVersion: number, idempotencyKey: string, commandId?: CommandId): CommandResult {
    return this.pauseAfterQuiescence(runId, expectedStateVersion, expectedStateVersion, idempotencyKey, commandId, false);
  }

  pauseAfterQuiescence(
    runId: RunId,
    requestStateVersion: number,
    observedStateVersion: number,
    idempotencyKey: string,
    commandId?: CommandId,
    requireQuiescent = true,
  ): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion: requestStateVersion,
      kind: "pause",
    });
    return this.store.executeCommandAtObservedVersion(command, observedStateVersion, ({ tx, run }) => {
      const uncertain = run.activeAttemptId !== null && this.activeAttemptInTransaction(tx, run.activeAttemptId);
      if (requireQuiescent && uncertain) {
        throw new KerbsFlowError("PAUSE_REQUIRES_QUIESCENT_RUN", "coordinated pause cannot commit while an executor attempt is active or ambiguous");
      }
      const chosen = choosePauseContract(run.state, uncertain);
      const pauseContract = {
        schemaVersion: CONTRACT_VERSIONS.pause,
        originState: run.state as Exclude<RunState, "IDLE" | "PAUSED" | "FAILED" | "CANCELLED" | "DONE">,
        durableBoundary: chosen.durableBoundary,
        resumeTarget: chosen.resumeTarget as Exclude<RunState, "IDLE" | "PAUSED" | "FAILED" | "CANCELLED" | "DONE">,
      };
      return {
        transition: {
          to: "PAUSED",
          actor: "human",
          reasonCode: "pause_requested",
          payload: pauseContract,
        },
        runPatch: { pauseContract, recoveryRequired: chosen.resumeTarget === "RECOVERY", recoveryReason: chosen.resumeTarget === "RECOVERY" ? "pause preserved uncertain activity for recovery" : null },
        details: { resumeTarget: chosen.resumeTarget },
      } satisfies CommandMutation;
    });
  }

  resume(runId: RunId, expectedStateVersion: number, idempotencyKey: string, commandId?: CommandId): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "resume",
    });
    return this.store.executeCommand(command, ({ run }) => {
      if (run.state !== "PAUSED" || run.pauseContract === null) {
        throw new KerbsFlowError("RESUME_NOT_PAUSED", "resume requires a persisted PAUSED contract");
      }
      assertResumeTarget(run.pauseContract.resumeTarget);
      if (run.recoveryRequired && run.pauseContract.resumeTarget !== "RECOVERY") {
        throw new KerbsFlowError("RESUME_REQUIRES_RECOVERY", "the persisted run has uncertain activity and cannot resume a non-RECOVERY target");
      }
      return {
        transition: {
          to: run.pauseContract.resumeTarget,
          actor: "human",
          reasonCode: "resume_persisted_target",
          payload: { resumeTarget: run.pauseContract.resumeTarget },
        },
        runPatch: { pauseContract: null, recoveryRequired: run.pauseContract.resumeTarget === "RECOVERY", recoveryReason: run.pauseContract.resumeTarget === "RECOVERY" ? "resume requires recovery reconciliation" : null },
        details: { resumeTarget: run.pauseContract.resumeTarget },
      } satisfies CommandMutation;
    });
  }

  cancel(runId: RunId, expectedStateVersion: number, idempotencyKey: string, reason: string, commandId?: CommandId): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "cancel",
      reason,
    });
    const current = this.store.getRun(runId);
    if (current?.stateVersion === expectedStateVersion && current.activeAttemptId !== null) {
      const activeAttempt = this.store.getAttempt(current.activeAttemptId);
      const nonterminal = activeAttempt !== undefined && (activeAttempt.lifecycle === "PREPARED" || activeAttempt.lifecycle === "RUNNING" || activeAttempt.lifecycle === "UNKNOWN");
      if (nonterminal && activeAttempt.adapterDescriptorJson !== null) {
        const descriptor = parseAdapterDescriptor(JSON.parse(activeAttempt.adapterDescriptorJson));
        if (descriptor.adapter !== "fake") {
          throw new KerbsFlowError("REAL_CANCEL_REQUIRES_DURABLE_INTENT", "real adapter cancellation must use requestRealCancellation before any external signal");
        }
      }
      const handle = nonterminal ? this.liveHandles.get(current.activeAttemptId) : undefined;
      if (handle !== undefined) {
        this.adapter.cancel(handle, reason);
      }
    }
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state === "IDLE" || run.state === "FAILED" || run.state === "CANCELLED" || run.state === "DONE") {
        throw new KerbsFlowError("CANCEL_NOT_ALLOWED", `cannot cancel from ${run.state}`);
      }
      if (run.activeAttemptId !== null) {
        const attempt = this.attemptInTransaction(tx, run.activeAttemptId);
        if (attempt.lifecycle === "PREPARED" || attempt.lifecycle === "RUNNING" || attempt.lifecycle === "UNKNOWN") {
          tx.run("UPDATE attempts SET lifecycle = ?, failure_class = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", "CANCELLED", "cancelled", now, now, attempt.attemptId);
        }
      }
      if (run.currentGateId !== null) {
        const gate = this.gateInTransaction(tx, run.currentGateId);
        if (gate.gate.status === "open") {
          const rejected: HumanGate = {
            ...gate.gate,
            status: "rejected",
            resolution: { optionId: "cancel", actor: "human", resolvedAt: now, note: reason },
          };
          tx.run("UPDATE human_gates SET status = ?, gate_json = ?, resolved_at = ? WHERE gate_id = ?", "rejected", JSON.stringify(rejected), now, gate.gateId);
        }
      }
      return {
        transition: {
          to: "CANCELLED",
          actor: "human",
          reasonCode: "cancel_requested",
          taskId: run.currentTaskId,
          attemptId: run.activeAttemptId,
          gateId: run.currentGateId,
          payload: { reason },
        },
        runPatch: { pauseContract: null, currentGateId: null, recoveryRequired: false, recoveryReason: null },
        details: { reason },
      } satisfies CommandMutation;
    });
  }

  cancelAfterQuiescence(
    runId: RunId,
    requestStateVersion: number,
    observedStateVersion: number,
    idempotencyKey: string,
    reason: string,
    commandId?: CommandId,
  ): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion: requestStateVersion,
      kind: "cancel",
      reason,
    });
    return this.store.executeCommandAtObservedVersion(command, observedStateVersion, ({ tx, run, now }) => {
      if (run.activeAttemptId !== null) {
        const attempt = this.attemptInTransaction(tx, run.activeAttemptId);
        if (attempt.lifecycle === "PREPARED" || attempt.lifecycle === "RUNNING" || attempt.lifecycle === "UNKNOWN") {
          throw new KerbsFlowError("CANCEL_REQUIRES_QUIESCENT_RUN", "coordinated cancellation cannot finalize while an executor attempt is active or ambiguous");
        }
      }
      return this.cancelQuiescentMutation(tx, run, now, reason);
    });
  }

  private cancelQuiescentMutation(tx: SqlTransaction, run: StoredRun, now: string, reason: string): CommandMutation {
    if (run.state === "IDLE" || run.state === "FAILED" || run.state === "CANCELLED" || run.state === "DONE") {
      throw new KerbsFlowError("CANCEL_NOT_ALLOWED", `cannot cancel from ${run.state}`);
    }
    if (run.currentGateId !== null) {
      const gate = this.gateInTransaction(tx, run.currentGateId);
      if (gate.gate.status === "open") {
        const rejected: HumanGate = {
          ...gate.gate,
          status: "rejected",
          resolution: { optionId: "cancel", actor: "human", resolvedAt: now, note: reason },
        };
        tx.run("UPDATE human_gates SET status = ?, gate_json = ?, resolved_at = ? WHERE gate_id = ?", rejected.status, JSON.stringify(rejected), now, gate.gateId);
      }
    }
    return {
      transition: {
        to: "CANCELLED",
        actor: "human",
        reasonCode: "cancel_requested",
        taskId: run.currentTaskId,
        attemptId: run.activeAttemptId,
        gateId: run.currentGateId,
        payload: { reason },
      },
      runPatch: { pauseContract: null, currentGateId: null, recoveryRequired: false, recoveryReason: null },
      details: { reason },
    } satisfies CommandMutation;
  }

  requestRealCancellation(
    runId: RunId,
    expectedStateVersion: number,
    idempotencyKey: string,
    reason: string,
    commandId?: CommandId,
    observedStateVersion = expectedStateVersion,
    requestIdentity?: Pick<Extract<Command, { kind: "cancel" }>, "commandId" | "idempotencyKey" | "expectedStateVersion">,
  ): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "cancel",
      reason,
    });
    const externalCommand = requestIdentity === undefined
      ? command
      : parseCommand({
          schemaVersion: CONTRACT_VERSIONS.command,
          commandId: requestIdentity.commandId,
          idempotencyKey: requestIdentity.idempotencyKey,
          runId,
          expectedStateVersion: requestIdentity.expectedStateVersion,
          kind: "cancel",
          reason,
        });
    if (externalCommand.kind !== "cancel") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "cancellation request identity did not parse as Cancel");
    if (externalCommand.expectedStateVersion !== expectedStateVersion) {
      throw new KerbsFlowError("CANCELLATION_COMMAND_CONFLICT", "durable cancellation intent must retain the command's original expected state version");
    }
    return this.store.executeCommandAtObservedVersion(command, observedStateVersion, ({ tx, run, now }) => {
      if (run.state === "IDLE" || run.state === "FAILED" || run.state === "CANCELLED" || run.state === "DONE") {
        throw new KerbsFlowError("CANCEL_NOT_ALLOWED", `cannot cancel from ${run.state}`);
      }
      if (run.activeAttemptId === null) {
        throw new KerbsFlowError("ATTEMPT_REQUIRED", "real cancellation requires an active attempt");
      }
      const attempt = this.attemptInTransaction(tx, run.activeAttemptId);
      const existing = tx.get("SELECT reason, request_command_id, request_idempotency_key, request_expected_state_version FROM cancellation_intents WHERE attempt_id = ?", attempt.attemptId) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        if (existing.reason !== reason || existing.request_command_id !== externalCommand.commandId
          || existing.request_idempotency_key !== externalCommand.idempotencyKey
          || existing.request_expected_state_version !== externalCommand.expectedStateVersion) {
          throw new KerbsFlowError("CANCELLATION_COMMAND_CONFLICT", "active attempt already has a different durable external Cancel identity, precondition, or reason");
        }
        return { details: { attemptId: attempt.attemptId, cancellationIntent: "already_persisted" } } satisfies CommandMutation;
      }
      if (isTerminalAttempt(attempt.lifecycle)) {
        throw new KerbsFlowError("ATTEMPT_NOT_ACTIVE", `attempt ${attempt.attemptId} is already ${attempt.lifecycle}`);
      }
      if (run.state !== "EXECUTE" && run.state !== "RECOVERY" && run.state !== "PAUSED") {
        throw new KerbsFlowError("CANCEL_NOT_ALLOWED", `real attempt cancellation is not allowed from ${run.state}`);
      }
      tx.run(
        "INSERT INTO cancellation_intents (attempt_id, run_id, reason, status, request_command_id, request_idempotency_key, request_expected_state_version, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        attempt.attemptId,
        runId,
        reason,
        "REQUESTED",
        externalCommand.commandId,
        externalCommand.idempotencyKey,
        externalCommand.expectedStateVersion,
        now,
        now,
      );
      return { details: { attemptId: attempt.attemptId, cancellationIntent: "persisted" } } satisfies CommandMutation;
    });
  }

  signalRealCancellation(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    const intent = this.store.getCancellationIntent(attempt.attemptId);
    if (intent === undefined) {
      throw new KerbsFlowError("CANCELLATION_INTENT_REQUIRED", "durable cancellation intent must be committed before signalling the adapter");
    }
    const pendingCommand = this.specializedCommand(runId, expectedStateVersion, `${idempotencyKey}:pending`, "complete_attempt", {
      attemptId: attempt.attemptId,
      phase: "cancel_signal_pending",
    });
    const pending = this.store.executeCommand(pendingCommand, ({ tx, run, now }) => {
      if (run.activeAttemptId !== attempt.attemptId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "cancellation intent no longer matches the active attempt");
      }
      const current = tx.get("SELECT status FROM cancellation_intents WHERE attempt_id = ?", attempt.attemptId) as Record<string, unknown> | undefined;
      if (current?.status !== "REQUESTED") {
        throw new KerbsFlowError("CANCELLATION_SIGNAL_AMBIGUOUS", `cancellation signal boundary is ${String(current?.status ?? "missing")}; reconcile without replaying the signal`);
      }
      tx.run("UPDATE cancellation_intents SET status = ?, updated_at = ? WHERE attempt_id = ?", "SIGNAL_PENDING", now, attempt.attemptId);
      return { details: { attemptId: attempt.attemptId, cancellationSignal: "pending" } } satisfies CommandMutation;
    });
    if (pending.replayed) {
      throw new KerbsFlowError("CANCELLATION_SIGNAL_AMBIGUOUS", "cancellation signal command was already committed; reconcile without replaying the side effect");
    }
    const handle = this.liveHandles.get(attempt.attemptId);
    const adapterOutcome = handle === undefined
      ? { outcome: "unknown" as const, summary: "live process handle is absent; no cancellation side effect was attempted" }
      : this.adapter.cancel(handle, intent.reason);
    const command = this.specializedCommand(runId, expectedStateVersion, `${idempotencyKey}:evidence`, "complete_attempt", {
      attemptId: attempt.attemptId,
      phase: "cancel_signal",
      adapterOutcome: parseJsonValue(adapterOutcome, "adapterCancellationOutcome"),
    });
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.activeAttemptId !== attempt.attemptId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "cancellation intent no longer matches the active attempt");
      }
      const current = tx.get("SELECT status FROM cancellation_intents WHERE attempt_id = ?", attempt.attemptId) as Record<string, unknown> | undefined;
      if (current?.status !== "SIGNAL_PENDING") {
        throw new KerbsFlowError("CANCELLATION_SIGNAL_AMBIGUOUS", `expected SIGNAL_PENDING before evidence persistence, found ${String(current?.status ?? "missing")}`);
      }
      tx.run(
        "UPDATE cancellation_intents SET status = ?, adapter_outcome_json = ?, updated_at = ? WHERE attempt_id = ?",
        handle === undefined ? "UNCERTAIN" : "SIGNALLED",
        JSON.stringify(adapterOutcome),
        now,
        attempt.attemptId,
      );
      return { details: { attemptId: attempt.attemptId, adapterOutcome: parseJsonValue(adapterOutcome, "adapterCancellationOutcome") } } satisfies CommandMutation;
    });
  }

  async reconcileRealCancellation(runId: RunId, expectedStateVersion: number, idempotencyKey: string): Promise<CommandResult> {
    return this.reconcileCancellation(runId, expectedStateVersion, (reconciliation, attemptId) => this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "recovery", {
      attemptId,
      phase: "cancel_reconcile",
      reconciliation: parseJsonValue(reconciliation, "cancellationReconciliation"),
    }));
  }

  finalizeCoordinatedCancellation(commandValue: unknown, observedStateVersion: number): Promise<CommandResult> {
    const command = parseCommand(commandValue);
    if (command.kind !== "cancel") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "coordinated cancellation finalization requires a Cancel command");
    return this.reconcileCancellation(command.runId, observedStateVersion, () => command);
  }

  private async reconcileCancellation(
    runId: RunId,
    observedStateVersion: number,
    commandFor: (reconciliation: ReconcileOutcome, attemptId: ReturnType<typeof asAttemptId>) => Command,
  ): Promise<CommandResult> {
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    const intent = this.store.getCancellationIntent(attempt.attemptId);
    if (intent === undefined) {
      throw new KerbsFlowError("CANCELLATION_INTENT_REQUIRED", "cannot reconcile cancellation without a durable intent");
    }
    let reconciliation = await this.adapter.reconcile({ runId, taskId: attempt.taskId, attemptId: attempt.attemptId });
    if (reconciliation.outcome === "terminal") {
      try {
        const result = parseExecutorResult(reconciliation.result);
        reconciliation = result.runId === runId && result.taskId === attempt.taskId && result.attemptId === attempt.attemptId
          ? { ...reconciliation, result }
          : { outcome: "unknown", summary: "cancellation terminal proof does not match the owned run, task, and attempt" };
      } catch (error) {
        if (!(error instanceof ContractValidationError)) throw error;
        reconciliation = { outcome: "unknown", summary: "cancellation terminal proof is malformed or incompatible" };
      }
    }
    const certainCancellation = reconciliation.outcome === "terminal" && reconciliation.result?.outcome === "cancelled";
    const command = commandFor(reconciliation, attempt.attemptId);
    if (command.runId !== runId) throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "cancellation finalization command does not match its run");
    if (command.kind === "cancel" && (command.reason !== intent.reason || command.commandId !== intent.requestCommandId
      || command.idempotencyKey !== intent.requestIdempotencyKey || command.expectedStateVersion !== intent.requestExpectedStateVersion)) {
      throw new KerbsFlowError("CANCELLATION_COMMAND_CONFLICT", "external Cancel identity, precondition, or reason does not match its durable cancellation intent");
    }
    const mutation = ({ tx, run, now }: CommandMutationContext): CommandMutation => {
      if (run.activeAttemptId !== attempt.attemptId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "cancellation reconciliation no longer matches the active attempt");
      }
      const target: Extract<RunState, "CANCELLED" | "RECOVERY"> = certainCancellation ? "CANCELLED" : "RECOVERY";
      tx.run(
        "UPDATE cancellation_intents SET status = ?, reconciliation_json = ?, updated_at = ?, terminal_at = ? WHERE attempt_id = ?",
        certainCancellation ? "CANCELLED" : "UNCERTAIN",
        JSON.stringify(reconciliation),
        now,
        certainCancellation ? now : null,
        attempt.attemptId,
      );
      tx.run(
        "UPDATE attempts SET lifecycle = ?, failure_class = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?",
        certainCancellation ? "CANCELLED" : "UNKNOWN",
        certainCancellation ? "cancelled" : "unknown",
        certainCancellation ? now : null,
        now,
        attempt.attemptId,
      );
      const transition = target === "RECOVERY" && run.state === "RECOVERY"
        ? undefined
        : {
          to: target,
          actor: "recovery" as const,
          reasonCode: certainCancellation ? "cancellation_reconciled" : "cancellation_uncertain",
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          payload: { reconciliation: parseJsonValue(reconciliation, "cancellationReconciliation") },
        };
      return {
        ...(transition === undefined ? {} : { transition }),
        runPatch: {
          recoveryRequired: !certainCancellation,
          recoveryReason: certainCancellation ? null : "cancellation outcome is not certain; automatic replay is prohibited",
        },
        details: { attemptId: attempt.attemptId, certainCancellation },
      } satisfies CommandMutation;
    };
    return command.kind === "cancel"
      ? this.store.executeCommandAtObservedVersion(command, observedStateVersion, mutation)
      : this.store.executeCommand(command, mutation);
  }

  recover(runId: RunId, expectedStateVersion: number, idempotencyKey: string, value: unknown): CommandResult {
    const decision = parseRecoveryDecision(value);
    if (decision.runId !== runId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "recovery runId does not match the command run");
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "recovery", { decision: parseJsonValue(decision, "recoveryDecision") });
    return this.store.executeCommand(command, ({ tx, run, now, nextId }) => {
      if (run.state !== "RECOVERY") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `recovery decision requires RECOVERY, found ${run.state}`);
      }
      const attempt = run.activeAttemptId === null ? undefined : this.attemptInTransaction(tx, run.activeAttemptId);
      if (decision.target === "EXECUTE") {
        throw new KerbsFlowError("AMBIGUOUS_REPLAY", "Phase 1 never re-dispatches an uncertain fake attempt directly");
      }
      if ((decision.target === "FAILED" || decision.target === "CANCELLED") && attempt !== undefined && !isTerminalAttempt(attempt.lifecycle)) {
        throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", `${decision.target} recovery requires trusted terminal evidence for the active attempt`);
      }
      if (decision.target === "VERIFY_FOCUSED") {
        if (attempt === undefined || !isTerminalAttempt(attempt.lifecycle) || attempt.outcomeJson === null) {
          throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "VERIFY_FOCUSED recovery requires a persisted terminal attempt result");
        }
        const persistedResult = this.validatePersistedExecutorResultForRecovery(runId, run.currentTaskId, run.activeAttemptId, attempt);
        if (persistedResult.outcome !== "succeeded" && persistedResult.outcome !== "failed" && persistedResult.outcome !== "partial") {
          throw new KerbsFlowError("RECOVERY_OUTCOME_NOT_VERIFIABLE", `executor outcome ${persistedResult.outcome} cannot recover to VERIFY_FOCUSED`);
        }
      }
      if (decision.target === "REVIEW") {
        if (run.currentTaskId === null || run.activeAttemptId === null || attempt === undefined || attempt.taskId !== run.currentTaskId || attempt.runId !== runId) {
          throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "REVIEW recovery requires the current task and active attempt");
        }
        const validation = this.focusedValidationInTransaction(tx, runId, run.currentTaskId, run.activeAttemptId);
        if (validation === undefined) {
          throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "REVIEW recovery requires persisted validation evidence");
        }
      }
      if (decision.target === "READY" && (run.currentTaskId === null || (attempt !== undefined && !isTerminalAttempt(attempt.lifecycle)))) {
        throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "READY recovery requires a task and no active attempt");
      }
      let gate: HumanGate | undefined;
      if (decision.target === "HUMAN_GATE" && attempt !== undefined && !isTerminalAttempt(attempt.lifecycle)) {
        throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "Human Gate recovery requires the uncertain executor activity to be reconciled or proven quiescent first.");
      }
      if (decision.target === "HUMAN_GATE") {
        gate = {
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId(nextId("gate")),
          runId,
          ...(run.currentTaskId === null ? {} : { taskId: run.currentTaskId }),
          ...(run.activeAttemptId === null ? {} : { attemptId: run.activeAttemptId }),
          reasonCode: "unknown",
          summary: decision.summary,
          evidenceRefs: decision.evidenceRefs,
          options: [
            { id: "fail", label: "Fail conservatively", consequence: "Stop without replaying the uncertain attempt.", target: "FAILED" },
            { id: "cancel", label: "Cancel", consequence: "Terminate the run while preserving evidence.", target: "CANCELLED" },
          ],
          status: "open",
        };
        this.insertGate(tx, gate, now);
      }
      return {
        transition: {
          to: decision.target,
          actor: "recovery",
          reasonCode: "recovery_decision",
          taskId: run.currentTaskId,
          attemptId: run.activeAttemptId,
          gateId: gate?.gateId ?? null,
          payload: { target: decision.target, summary: decision.summary },
        },
        runPatch: { currentGateId: gate?.gateId ?? null, recoveryRequired: false, recoveryReason: null },
        details: { target: decision.target, ...(gate === undefined ? {} : { gateId: gate.gateId }) },
      } satisfies CommandMutation;
    });
  }

  readModel(runId: RunId): ReadModel | undefined {
    return this.store.readModel(runId);
  }

  private transition(runId: RunId, expectedStateVersion: number, idempotencyKey: string, target: RunState, reasonCode: string, actor: "core" | "planner" | "human" | "verifier" | "adapter" | "recovery"): CommandResult {
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, target, actor, reasonCode, { target, reasonCode });
    return this.store.executeCommand(command, () => ({
      transition: { to: target, actor, reasonCode, payload: { target, reasonCode } },
      runPatch: { recoveryRequired: false, recoveryReason: null },
    } satisfies CommandMutation));
  }

  private persistAttemptHandle(runId: RunId, expectedStateVersion: number, idempotencyKey: string, attemptId: ReturnType<typeof asAttemptId>, handle: AttemptHandle): void {
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "begin_attempt", { attemptId, handle: parseJsonValue(handle, "attemptHandle") });
    this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.activeAttemptId !== attemptId) {
        throw new KerbsFlowError("ATTEMPT_SCOPE_MISMATCH", "attempt handle does not match the active attempt");
      }
      const current = this.attemptInTransaction(tx, attemptId);
      if (current.lifecycle !== "PREPARED" && current.lifecycle !== "RUNNING") {
        throw new KerbsFlowError("ATTEMPT_NOT_ACTIVE", `attempt ${attemptId} is ${current.lifecycle}`);
      }
      tx.run(
        "UPDATE attempts SET lifecycle = ?, provider_identity_json = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE attempt_id = ?",
        "RUNNING",
        JSON.stringify(handle),
        now,
        now,
        attemptId,
      );
      return { details: { attemptId, handlePersisted: true } } satisfies CommandMutation;
    });
  }

  private specializedCommand(runId: RunId, expectedStateVersion: number, idempotencyKey: string, kind: Command["kind"], payload: JsonValue, commandId?: CommandId): Command {
    return parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: commandId ?? this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind,
      payload,
    });
  }

  private transitionCommand(
    runId: RunId,
    expectedStateVersion: number,
    idempotencyKey: string,
    target: RunState,
    actor: "core" | "planner" | "human" | "verifier" | "adapter" | "recovery",
    reasonCode: string,
    payload?: JsonValue,
  ): Command {
    return parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "transition",
      target,
      actor,
      reasonCode,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  private nextCommandId(): ReturnType<typeof asCommandId> {
    return asCommandId(this.ids.next("command"));
  }

  private consumeObservedSteer(
    tx: SqlTransaction,
    runId: RunId,
    observation: PlanningSteerObservation,
    planningCommandId: CommandId,
    planningDecisionId: { toString(): string },
    now: string,
  ): void {
    const pending = tx.get("SELECT instruction_id, text FROM steer_instructions WHERE run_id = ? AND consumed_at IS NULL", runId) as Record<string, unknown> | undefined;
    if (observation.instructionId === null) {
      if (pending !== undefined) {
        throw new KerbsFlowError("PLANNING_STEER_STALE", "planning observed no steer instruction but a pending instruction exists");
      }
      return;
    }
    if (pending === undefined) {
      throw new KerbsFlowError("PLANNING_STEER_STALE", `planning observed ${observation.instructionId} but no pending steer instruction exists`);
    }
    const currentId = String(pending.instruction_id);
    const currentText = String(pending.text);
    if (currentId !== observation.instructionId || (observation.text !== null && observation.text !== currentText)) {
      throw new KerbsFlowError("PLANNING_STEER_STALE", "planning observed a stale steer instruction");
    }
    const result = tx.run(
      "UPDATE steer_instructions SET consumed_at = ?, planning_command_id = ?, planning_decision_id = ? WHERE instruction_id = ? AND consumed_at IS NULL",
      now,
      planningCommandId,
      String(planningDecisionId),
      currentId,
    );
    if (result.changes !== 1 && result.changes !== 1n) {
      throw new KerbsFlowError("PLANNING_STEER_STALE", "steer instruction was consumed concurrently");
    }
  }

  private requiredModel(runId: RunId): ReadModel {
    const model = this.store.readModel(runId);
    if (model === undefined) {
      throw new NotFoundError("run", runId);
    }
    return model;
  }

  private requiredTask(taskId: TaskId | null): StoredTask {
    if (taskId === null) {
      throw new KerbsFlowError("TASK_REQUIRED", "a current task is required");
    }
    const task = this.store.getTask(taskId);
    if (task === undefined) {
      throw new NotFoundError("task", taskId);
    }
    return task;
  }

  private requiredAttempt(attemptId: ReturnType<typeof asAttemptId> | null): StoredAttempt {
    if (attemptId === null) {
      throw new KerbsFlowError("ATTEMPT_REQUIRED", "a current attempt is required");
    }
    const attempt = this.store.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new NotFoundError("attempt", attemptId);
    }
    return attempt;
  }

  private taskInTransaction(tx: SqlTransaction, taskId: TaskId): StoredTask {
    const row = tx.get("SELECT * FROM tasks WHERE task_id = ?", taskId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new NotFoundError("task", taskId);
    }
    return {
      taskId: asTaskId(String(row.task_id)),
      runId: asRunId(String(row.run_id)),
      status: String(row.status),
      decision: parsePlanningDecision(JSON.parse(String(row.decision_json))),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private attemptInTransaction(tx: SqlTransaction, attemptId: ReturnType<typeof asAttemptId>): StoredAttempt {
    const row = tx.get("SELECT * FROM attempts WHERE attempt_id = ?", attemptId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new NotFoundError("attempt", attemptId);
    }
    return this.attemptFromRow(row);
  }

  private assertPhase4DispatchAuthority(tx: SqlTransaction, task: StoredTask, attempt: StoredAttempt): void {
    if (task.decision.policyVersion !== PHASE4_ROUTING_POLICY) return;
    const routingRow = tx.get("SELECT decision_json FROM routing_decisions WHERE planning_decision_id = ?", task.decision.decisionId) as Record<string, unknown> | undefined;
    if (routingRow === undefined) {
      throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "Phase 4 dispatch requires a persisted trusted routing decision");
    }
    const provenanceRow = tx.get("SELECT provenance_json FROM attempt_routing_provenance WHERE attempt_id = ?", attempt.attemptId) as Record<string, unknown> | undefined;
    if (provenanceRow === undefined) {
      throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "Phase 4 dispatch requires persisted attempt routing provenance");
    }
    if (attempt.adapterDescriptorJson === null) {
      throw new KerbsFlowError("ROUTING_CAPABILITY_MISMATCH", "Phase 4 dispatch requires the prepared adapter descriptor");
    }
    const routing = assertRoutingDecision(JSON.parse(String(routingRow.decision_json)) as RoutingDecision);
    const provenance = assertAttemptRoutingProvenance(JSON.parse(String(provenanceRow.provenance_json)) as AttemptRoutingProvenance);
    const descriptor = parseAdapterDescriptor(JSON.parse(attempt.adapterDescriptorJson), "attempts.adapter_descriptor_json");
    assertAttemptRoutingBinding({
      provenance,
      routingDecision: routing,
      planningDecision: task.decision,
      preparedDescriptor: descriptor,
      attemptId: attempt.attemptId,
    });
  }

  private gateInTransaction(tx: SqlTransaction, gateId: ReturnType<typeof asGateId>): StoredGate {
    const row = tx.get("SELECT * FROM human_gates WHERE gate_id = ?", gateId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new NotFoundError("gate", gateId);
    }
    return {
      gateId,
      runId: asRunId(String(row.run_id)),
      taskId: row.task_id === null ? null : asTaskId(String(row.task_id)),
      attemptId: row.attempt_id === null ? null : asAttemptId(String(row.attempt_id)),
      status: String(row.status),
      gate: parseHumanGate(JSON.parse(String(row.gate_json))),
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    };
  }

  private activeAttemptInTransaction(tx: SqlTransaction, attemptId: ReturnType<typeof asAttemptId>): boolean {
    const row = tx.get("SELECT lifecycle FROM attempts WHERE attempt_id = ?", attemptId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new NotFoundError("attempt", attemptId);
    }
    return !isTerminalAttempt(String(row.lifecycle) as AttemptLifecycle);
  }

  private attemptFromRow(row: Record<string, unknown>): StoredAttempt {
    const lifecycle = String(row.lifecycle) as AttemptLifecycle;
    if (!isAttemptLifecycle(lifecycle)) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `unknown attempt lifecycle ${lifecycle}`);
    }
    return {
      attemptId: asAttemptId(String(row.attempt_id)),
      runId: asRunId(String(row.run_id)),
      taskId: asTaskId(String(row.task_id)),
      lifecycle,
      adapterDescriptorJson: row.adapter_descriptor_json === null ? null : String(row.adapter_descriptor_json),
      providerIdentityJson: row.provider_identity_json === null ? null : String(row.provider_identity_json),
      outcomeJson: row.outcome_json === null ? null : String(row.outcome_json),
      failureClass: row.failure_class === null ? null : String(row.failure_class),
      startedAt: row.started_at === null ? null : String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private insertArtifact(tx: SqlTransaction, artifact: ReturnType<ArtifactStore["put"]>, now: string): void {
    tx.run(
      "INSERT INTO artifacts (artifact_id, run_id, attempt_id, kind, relative_path, content_hash, size_bytes, redaction_state, retention_category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      artifact.artifactId,
      artifact.runId,
      artifact.attemptId ?? null,
      artifact.kind,
      artifact.relativePath,
      artifact.contentHash,
      artifact.sizeBytes,
      artifact.redactionState,
      artifact.retentionCategory,
      now,
    );
  }

  private insertGate(tx: SqlTransaction, gate: HumanGate, now: string): void {
    for (const ref of [...gate.evidenceRefs, ...(gate.evidence ?? []).flatMap(e => e.artifactRef === undefined ? [] : [e.artifactRef])]) {
      const artifact = tx.get("SELECT run_id FROM artifacts WHERE artifact_id = ?", ref);
      if (artifact?.run_id !== gate.runId) throw new KerbsFlowError("GATE_EVIDENCE_SCOPE_MISMATCH", "gate requires exact Core-owned run-scoped artifact references");
    }
    const normalizedGate: HumanGate = gate.evidence !== undefined && gate.evidence.length > 0
      ? gate
      : {
        ...gate,
        evidence: [{
          schemaVersion: CONTRACT_VERSIONS.validation,
          id: asValidationId(`validation_gate_${gate.gateId}`),
          kind: "other",
          classification: "not_tested",
          summary: gate.evidenceRefs.length > 0 ? "gate references artifacts whose evidence classification was not supplied" : "no classified supporting evidence was supplied for this gate",
        }],
      };
    tx.run(
      "INSERT INTO human_gates (gate_id, run_id, task_id, attempt_id, status, gate_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      normalizedGate.gateId,
      normalizedGate.runId,
      normalizedGate.taskId ?? null,
      normalizedGate.attemptId ?? null,
      normalizedGate.status,
      JSON.stringify(normalizedGate),
      now,
    );
  }

  private assertExecutorGate(gate: HumanGate, runId: RunId, taskId: TaskId, attemptId: AttemptId): HumanGate {
    if (gate.runId !== runId || gate.taskId !== taskId || gate.attemptId !== attemptId || gate.status !== "open") {
      throw new KerbsFlowError("GATE_SCOPE_MISMATCH", "executor human gate does not match the active run/task/attempt");
    }
    if (gate.recommendation !== undefined && gate.evidenceRefs.length === 0 && (gate.evidence?.length ?? 0) === 0) {
      throw new KerbsFlowError("GATE_RECOMMENDATION_UNSUPPORTED", "executor gate recommendation requires classified supporting evidence");
    }
    for (const ref of [...gate.evidenceRefs, ...(gate.evidence ?? []).flatMap(e => e.artifactRef === undefined ? [] : [e.artifactRef])]) {
      const owned = this.store.getArtifactRecord(ref);
      if (owned === undefined || owned.runId !== runId) throw new KerbsFlowError("GATE_EVIDENCE_SCOPE_MISMATCH", "executor gate references foreign or unknown evidence");
    }
    const seenOptionIds = new Set<string>();
    for (const option of gate.options) {
      if (seenOptionIds.has(option.id)) {
        throw new KerbsFlowError("GATE_OPTION_DUPLICATE", "executor human gate repeats option IDs");
      }
      seenOptionIds.add(option.id);
      if (!isLegalTransition("HUMAN_GATE", option.target)) {
        throw new KerbsFlowError("GATE_TARGET_ILLEGAL", `executor human gate targets illegal transition HUMAN_GATE -> ${option.target}`);
      }
    }
    const canRework = this.store.countTaskAttempts(runId, taskId) < this.configuration.effectiveMaxImplementationAttempts;
    const controlIds = { REWORK: "rework", FAILED: "fail", CANCELLED: "cancel" } as const;
    const seenTargets = new Set<keyof typeof controlIds>();
    const options: HumanGate["options"] = [];
    for (const option of gate.options) {
      if (option.target !== "REWORK" && option.target !== "FAILED" && option.target !== "CANCELLED") continue;
      if (option.target === "REWORK" && !canRework) continue;
      if (seenTargets.has(option.target)) continue;
      seenTargets.add(option.target);
      options.push({ ...option, id: controlIds[option.target] });
    }
    const addTerminal = (target: "FAILED" | "CANCELLED", label: string, consequence: string): void => {
      if (options.some((option) => option.target === target)) return;
      options.push({ id: controlIds[target], label, consequence, target });
    };
    addTerminal("FAILED", "Fail conservatively", "Stop this run and preserve the blocked attempt and evidence.");
    addTerminal("CANCELLED", "Cancel this run", "Stop this run without granting the requested action; preserve evidence.");
    return {
      ...gate,
      options,
      ...(gate.evidence === undefined ? {} : {
        evidence: gate.evidence.map((evidence) => ({
          ...evidence,
          classification: "not_tested" as const,
          summary: `Executor claim (not independently validated): ${evidence.summary}`,
        })),
      }),
    };
  }

  private validatePersistedExecutorResultForRecovery(
    runId: RunId,
    currentTaskId: TaskId | null,
    activeAttemptId: AttemptId | null,
    attempt: StoredAttempt,
  ): ExecutorResult {
    let raw: unknown;
    try {
      raw = JSON.parse(attempt.outcomeJson ?? "");
    } catch (error) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", `persisted executor result is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    }
    let result: ExecutorResult;
    try {
      result = parseExecutorResult(raw, "attempts.outcome_json");
    } catch (error) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", error instanceof Error ? error.message : "persisted executor result is invalid");
    }
    if (
      currentTaskId === null
      || activeAttemptId === null
      || attempt.runId !== runId
      || attempt.taskId !== currentTaskId
      || attempt.attemptId !== activeAttemptId
      || result.runId !== runId
      || result.taskId !== currentTaskId
      || result.attemptId !== activeAttemptId
    ) {
      throw new KerbsFlowError("RECOVERY_RESULT_SCOPE_MISMATCH", "persisted executor result does not match the current run, task, and active attempt");
    }
    if (outcomeToAttemptLifecycle(result.outcome) !== attempt.lifecycle) {
      throw new KerbsFlowError("RECOVERY_RESULT_LIFECYCLE_MISMATCH", `persisted executor outcome ${result.outcome} contradicts attempt lifecycle ${attempt.lifecycle}`);
    }
    return result;
  }

  private assertFocusedAuthority(bundle: ValidationBundle): void {
    const authority = this.store.getPhaseValidationAuthority(bundle.validationId);
    const declaration = this.store.getValidationIntent(bundle.runId, "focused");
    if (authority?.declaration?.level !== "focused" || declaration === undefined || authority.commandHash !== checkIntentHash(declaration) || authority.commandHash !== checkIntentHash(authority.declaration)) throw new KerbsFlowError("VALIDATION_AUTHORITY_REQUIRED", "focused validation has no matching trusted declaration");
    const current = this.currentCandidateBinding(bundle.runId);
    if (canonicalJson(current) !== canonicalJson({ worktreePath: authority.worktreePath, worktreeGitDirectory: authority.worktreeGitDirectory, baseOid: authority.baseOid, diffHash: authority.diffHash, changedPathsHash: authority.changedPathsHash, changedPaths: authority.changedPaths, candidateFingerprint: authority.candidateFingerprint, headOid: authority.headOid })) throw new KerbsFlowError("VALIDATION_CANDIDATE_STALE", "focused validation belongs to a changed candidate");
  }

  private focusedValidationInTransaction(
    tx: SqlTransaction,
    runId: RunId,
    taskId: TaskId,
    attemptId: AttemptId,
  ): ValidationBundle | undefined {
    const row = tx.get(
      "SELECT validation_id, outcome, bundle_json FROM validations WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND level = 'focused' ORDER BY rowid DESC LIMIT 1",
      runId,
      taskId,
      attemptId,
    ) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    let validation: ValidationBundle;
    try {
      validation = parseValidationBundle(JSON.parse(String(row.bundle_json)), "validations.bundle_json");
    } catch (error) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", error instanceof Error ? error.message : "persisted validation is invalid");
    }
    if (
      validation.validationId !== String(row.validation_id)
      || validation.runId !== runId
      || validation.taskId !== taskId
      || validation.attemptId !== attemptId
      || validation.level !== "focused"
      || validation.outcome !== String(row.outcome)
    ) {
      throw new KerbsFlowError("PERSISTED_CONTRACT_INVALID", "persisted focused validation columns and contract do not agree");
    }
    this.assertFocusedAuthority(validation);
    return validation;
  }
}

function reviewTarget(outcome: ReviewDecision["outcome"]): Extract<RunState, "REWORK" | "VERIFY_PHASE" | "NEXT_PHASE" | "FINAL_VERIFY" | "HUMAN_GATE" | "FAILED"> {
  switch (outcome) {
    case "rework": return "REWORK";
    case "verify_phase": return "VERIFY_PHASE";
    case "next_phase": return "NEXT_PHASE";
    case "final_verify": return "FINAL_VERIFY";
    case "human_gate": return "HUMAN_GATE";
    case "failed": return "FAILED";
  }
}

function taskStatusForReview(outcome: ReviewDecision["outcome"]): string {
  return outcome === "rework" ? "rework" : outcome === "human_gate" ? "blocked" : outcome === "failed" ? "failed" : "reviewed";
}

function outcomeToAttemptLifecycle(outcome: ExecutorResult["outcome"]): AttemptLifecycle {
  switch (outcome) {
    case "succeeded": return "SUCCEEDED";
    case "failed": return "FAILED";
    case "blocked": return "BLOCKED";
    case "partial": return "PARTIAL";
    case "cancelled": return "CANCELLED";
  }
}

function isTerminalAttempt(value: AttemptLifecycle): boolean {
  return value === "SUCCEEDED" || value === "FAILED" || value === "BLOCKED" || value === "PARTIAL" || value === "CANCELLED";
}

function isAttemptLifecycle(value: string): value is AttemptLifecycle {
  return value === "PREPARED" || value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "BLOCKED" || value === "PARTIAL" || value === "CANCELLED" || value === "UNKNOWN";
}

function numberFromCount(row: Record<string, unknown> | undefined): number {
  if (row === undefined || typeof row.count !== "number") {
    throw new KerbsFlowError("PERSISTED_ROW_INVALID", "attempt count query returned an invalid value");
  }
  return row.count;
}
