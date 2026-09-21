import {
  AttemptHandle,
  AttemptLifecycle,
  Command,
  CommandResult,
  CONTRACT_VERSIONS,
  ExecutorResult,
  HumanGate,
  JsonValue,
  ReviewDecision,
  RunId,
  RunState,
  TaskId,
  asAttemptId,
  asCommandId,
  asGateId,
  asRunId,
  asTaskId,
  parseAdapterDescriptor,
  parseExecutorResult,
  parseExecutionRequest,
  parseHumanGate,
  parseJsonValue,
  parseNormalizedEvent,
  parsePlanningDecision,
  parseRecoveryDecision,
  parseReviewDecision,
  parseValidationBundle,
  parseCommand,
} from "./contracts.js";
import { FakeAdapter, FakeArtifactStore } from "./fake.js";
import { KerbsFlowError, NotFoundError } from "./errors.js";
import {
  CommandMutation,
  ReadModel,
  SqlTransaction,
  StateStore,
  StoredAttempt,
  StoredGate,
  StoredTask,
} from "./persistence.js";
import { Clock, IdSource, RandomIdSource } from "./runtime.js";
import { assertLegalTransition, assertResumeTarget, choosePauseContract } from "./state-machine.js";
import {
  ConfigLayers,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  EffectiveConfiguration,
  mergeConfiguration,
} from "./contracts.js";

export interface CoreOptions {
  store: StateStore;
  adapter: FakeAdapter;
  artifacts: FakeArtifactStore;
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
    private readonly adapter: FakeAdapter,
    private readonly artifacts: FakeArtifactStore,
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

  startRun(runId: RunId, objective: string, idempotencyKey: string): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
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

  completeIntake(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    return this.transition(runId, expectedStateVersion, idempotencyKey, "PLAN", "intake_validated", "core");
  }

  plan(runId: RunId, expectedStateVersion: number, idempotencyKey: string, value: unknown): CommandResult {
    const decision = parsePlanningDecision(value);
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
      const descriptor = parseAdapterDescriptor(this.adapter.probe());
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
          reasonCode: "fake_attempt_prepared",
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
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    if (attempt.lifecycle !== "PREPARED" && attempt.lifecycle !== "RUNNING") {
      throw new KerbsFlowError("ATTEMPT_NOT_PREPARED", `attempt ${attempt.attemptId} is ${attempt.lifecycle}`);
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "begin_attempt", { attemptId: attempt.attemptId });
    const result = this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "EXECUTE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `fake execution requires EXECUTE, found ${run.state}`);
      }
      const current = this.attemptInTransaction(tx, attempt.attemptId);
      if (current.lifecycle === "RUNNING") {
        return { details: { attemptId: attempt.attemptId, alreadyRunning: true } } satisfies CommandMutation;
      }
      if (current.lifecycle !== "PREPARED") {
        throw new KerbsFlowError("ATTEMPT_NOT_PREPARED", `attempt ${current.attemptId} is ${current.lifecycle}`);
      }
      tx.run("UPDATE attempts SET lifecycle = ?, started_at = ?, updated_at = ? WHERE attempt_id = ?", "RUNNING", now, now, current.attemptId);
      return { details: { attemptId: current.attemptId } } satisfies CommandMutation;
    });
    if (!result.replayed && !this.liveHandles.has(attempt.attemptId)) {
      const task = this.requiredTask(model.run.currentTaskId);
      const request = {
        schemaVersion: CONTRACT_VERSIONS.executionRequest,
        runId,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        role: "implementation" as const,
        workingDirectory: "<headless-fake-worktree>",
        promptSummary: task.decision.action.summary,
        model: task.decision.route.model,
        ...(task.decision.route.reasoning === undefined ? {} : { reasoning: task.decision.route.reasoning }),
        permissionPolicy: { filesystem: "worktree_only" as const, network: "denied" as const },
        timeoutMs: 1000,
        expectedResultSchema: CONTRACT_VERSIONS.executorResult,
      };
      const handle = this.adapter.start(parseExecutionRequest(request));
      this.liveHandles.set(attempt.attemptId, handle);
      this.persistAttemptHandle(runId, result.stateVersion, `${idempotencyKey}:identity`, attempt.attemptId, handle);
    }
    return result;
  }

  async completeFakeAttempt(runId: RunId, expectedStateVersion: number, idempotencyKey: string, suppliedResult?: unknown): Promise<CommandResult> {
    const model = this.requiredModel(runId);
    const attempt = this.requiredAttempt(model.run.activeAttemptId);
    let rawResult = suppliedResult;
    if (rawResult === undefined) {
      const handle = this.liveHandles.get(attempt.attemptId);
      if (handle === undefined) {
        throw new KerbsFlowError("ATTEMPT_HANDLE_MISSING", `no live fake handle exists for ${attempt.attemptId}; recovery must decide without replay`);
      }
      for await (const event of this.adapter.events(handle)) {
        parseNormalizedEvent(event);
      }
      rawResult = await this.adapter.wait(handle);
    }
    let rawJson: JsonValue;
    try {
      rawJson = parseJsonValue(rawResult, "executorResult");
    } catch {
      rawJson = { schemaVersion: "kerbsflow.executor-result/invalid", error: "result was not JSON data" };
    }
    let parsed: ExecutorResult | undefined;
    let malformedReason: string | undefined;
    try {
      parsed = parseExecutorResult(rawJson);
      if (parsed.runId !== runId || parsed.taskId !== attempt.taskId || parsed.attemptId !== attempt.attemptId) {
        throw new KerbsFlowError("RESULT_SCOPE_MISMATCH", "executor result IDs do not match the active fake attempt");
      }
    } catch (error) {
      malformedReason = error instanceof Error ? error.message : "malformed executor result";
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "complete_attempt", {
      attemptId: attempt.attemptId,
      result: rawJson,
    });
    const result = this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "EXECUTE") {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", `fake completion requires EXECUTE, found ${run.state}`);
      }
      const current = this.attemptInTransaction(tx, attempt.attemptId);
      if (current.lifecycle !== "RUNNING" && current.lifecycle !== "PREPARED") {
        throw new KerbsFlowError("ATTEMPT_NOT_ACTIVE", `attempt ${current.attemptId} is ${current.lifecycle}`);
      }
      const artifact = this.artifacts.put(runId, "fake-result", JSON.stringify(rawJson), attempt.attemptId);
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
      if (persistedResult.outcome === "blocked") {
        if (persistedResult.humanGate === null) {
          throw new KerbsFlowError("HUMAN_GATE_REQUIRED", "blocked executor result must contain a human gate");
        }
        const gate = this.assertGateScope(persistedResult.humanGate, runId, current.taskId, current.attemptId);
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
            to: "RECOVERY",
            actor: "adapter",
            reasonCode: "adapter_cancelled",
            taskId: current.taskId,
            attemptId: current.attemptId,
            payload: { outcome: persistedResult.outcome },
          },
          runPatch: { recoveryRequired: true, recoveryReason: "adapter cancellation requires reconciliation" },
          details: { attemptId: current.attemptId, outcome: persistedResult.outcome },
        } satisfies CommandMutation;
      }
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "verification_pending", now, current.taskId);
      return {
        transition: {
          to: "VERIFY_FOCUSED",
          actor: "adapter",
          reasonCode: "fake_attempt_terminal",
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
      tx.run(
        "INSERT INTO validations (validation_id, run_id, task_id, attempt_id, level, outcome, bundle_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        bundle.validationId,
        runId,
        bundle.taskId,
        bundle.attemptId ?? null,
        bundle.level,
        bundle.outcome,
        JSON.stringify(bundle),
        now,
      );
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
      const validationRow = tx.get("SELECT outcome FROM validations WHERE run_id = ? AND task_id = ? ORDER BY rowid DESC LIMIT 1", runId, decision.taskId) as Record<string, unknown> | undefined;
      if (validationRow === undefined) {
        throw new KerbsFlowError("VALIDATION_REQUIRED", "review requires persisted independent validation evidence");
      }
      const validationOutcome = String(validationRow.outcome);
      if ((decision.outcome === "next_phase" || decision.outcome === "final_verify" || decision.outcome === "verify_phase") && validationOutcome !== "passed") {
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
            { id: "rework", label: "Bounded rework", consequence: "Return to REWORK without changing scope.", target: "REWORK" },
            { id: "fail", label: "Fail the run", consequence: "Stop automatic continuation and preserve evidence.", target: "FAILED" },
          ],
          ...(decision.failureClass === undefined ? {} : { recommendation: `Investigate ${decision.failureClass} before continuing.` }),
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

  reworkToReady(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = this.transitionCommand(runId, expectedStateVersion, idempotencyKey, "READY", "core", "rework_action_ready", { target: "READY" });
    return this.store.executeCommand(command, ({ tx, run, now }) => {
      if (run.state !== "REWORK" || run.currentTaskId === null) {
        throw new KerbsFlowError("INVALID_COMMAND_STATE", "rework readiness requires REWORK with a current task");
      }
      tx.run("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?", "ready", now, run.currentTaskId);
      return {
        transition: { to: "READY", actor: "core", reasonCode: "rework_action_ready", taskId: run.currentTaskId, payload: { target: "READY" } },
        runPatch: { recoveryRequired: false, recoveryReason: null },
      } satisfies CommandMutation;
    });
  }

  resolveGate(runId: RunId, expectedStateVersion: number, idempotencyKey: string, optionId: string, note?: string): CommandResult {
    const payload: Record<string, JsonValue> = { optionId };
    if (note !== undefined) {
      payload.note = note;
    }
    const command = this.specializedCommand(runId, expectedStateVersion, idempotencyKey, "gate_resolution", payload);
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

  pause(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "pause",
    });
    return this.store.executeCommand(command, ({ tx, run }) => {
      const uncertain = run.activeAttemptId !== null && this.activeAttemptInTransaction(tx, run.activeAttemptId);
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

  resume(runId: RunId, expectedStateVersion: number, idempotencyKey: string): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
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

  cancel(runId: RunId, expectedStateVersion: number, idempotencyKey: string, reason: string): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "cancel",
      reason,
    });
    const current = this.store.getRun(runId);
    if (current?.stateVersion === expectedStateVersion && current.activeAttemptId !== null) {
      const handle = this.liveHandles.get(current.activeAttemptId);
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
      if (decision.target === "VERIFY_FOCUSED" && (attempt === undefined || !isTerminalAttempt(attempt.lifecycle) || attempt.outcomeJson === null)) {
        throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "VERIFY_FOCUSED recovery requires a persisted terminal attempt result");
      }
      if (decision.target === "REVIEW") {
        const validation = tx.get("SELECT validation_id FROM validations WHERE run_id = ? ORDER BY rowid DESC LIMIT 1", runId);
        if (validation === undefined) {
          throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "REVIEW recovery requires persisted validation evidence");
        }
      }
      if (decision.target === "READY" && (run.currentTaskId === null || (attempt !== undefined && !isTerminalAttempt(attempt.lifecycle)))) {
        throw new KerbsFlowError("RECOVERY_EVIDENCE_INSUFFICIENT", "READY recovery requires a task and no active attempt");
      }
      let gate: HumanGate | undefined;
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
      if (decision.target === "CANCELLED" && attempt !== undefined && !isTerminalAttempt(attempt.lifecycle)) {
        tx.run("UPDATE attempts SET lifecycle = ?, failure_class = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", "CANCELLED", "cancelled", now, now, attempt.attemptId);
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
      tx.run("UPDATE attempts SET provider_identity_json = ?, updated_at = ? WHERE attempt_id = ?", JSON.stringify(handle), now, attemptId);
      return { details: { attemptId, handlePersisted: true } } satisfies CommandMutation;
    });
  }

  private specializedCommand(runId: RunId, expectedStateVersion: number, idempotencyKey: string, kind: Command["kind"], payload: JsonValue): Command {
    return parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: this.nextCommandId(),
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
      throw new KerbsFlowError("ATTEMPT_REQUIRED", "a current fake attempt is required");
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

  private insertArtifact(tx: SqlTransaction, artifact: ReturnType<FakeArtifactStore["put"]>, now: string): void {
    tx.run(
      "INSERT INTO artifacts (artifact_id, run_id, attempt_id, kind, relative_path, content_hash, size_bytes, redaction_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      artifact.artifactId,
      artifact.runId,
      artifact.attemptId ?? null,
      artifact.kind,
      artifact.relativePath,
      artifact.contentHash,
      artifact.sizeBytes,
      artifact.redactionState,
      now,
    );
  }

  private insertGate(tx: SqlTransaction, gate: HumanGate, now: string): void {
    tx.run(
      "INSERT INTO human_gates (gate_id, run_id, task_id, attempt_id, status, gate_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      gate.gateId,
      gate.runId,
      gate.taskId ?? null,
      gate.attemptId ?? null,
      gate.status,
      JSON.stringify(gate),
      now,
    );
  }

  private assertGateScope(gate: HumanGate, runId: RunId, taskId: TaskId, attemptId: ReturnType<typeof asAttemptId>): HumanGate {
    if (gate.runId !== runId || gate.taskId !== taskId || gate.attemptId !== attemptId || gate.status !== "open") {
      throw new KerbsFlowError("GATE_SCOPE_MISMATCH", "executor human gate does not match the active run/task/attempt");
    }
    return gate;
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
