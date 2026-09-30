import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  asCommandId,
  asRunId,
  asTaskId,
  type RunId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { KerbsFlowError } from "../src/errors.js";
import { FakeAdapter, FakeArtifactStore } from "../src/fake.js";
import { Phase2Loop, type Phase2DriveControls, type Phase2LoopRequest, type Phase2LoopResult } from "../src/phase2.js";
import { createPhase2PlanningDecision, type PlanningMaster } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { RunCoordinator, type CoordinatorCancelRequest, type CoordinatorControlRequest, type CoordinatorStartRequest, type TrustedLaunchProfile } from "../src/run-coordinator.js";
import type { AdapterDescriptor, AttemptHandle, AttemptId, GateId, ReconcileOutcome, TaskId } from "../src/contracts.js";
import { PolicyRouter, RoutedExecutorAdapter, RoutingDiscovery, createAttemptRoutingProvenance, type RouteModelPolicy } from "../src/routing.js";

test("RunCoordinator binds Start atomically and owns only one drive across retries", async () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const coordinator = fixture.coordinator(driver);
  const request = startRequest("run_coord_start");
  try {
    const started = coordinator.start(request);
    assert.equal(started.to, "INTAKE");
    await driver.started.promise;
    const binding = fixture.store.getRunLaunchBinding(request.runId);
    assert.ok(binding);
    assert.equal(binding.runId, request.runId);
    assert.equal(binding.taskId, asTaskId(binding.taskId));
    assert.equal(binding.canonicalRepositoryPath, realpathSync(fixture.profile.canonicalRepositoryPath));
    assert.equal(binding.launchProfileId, fixture.profile.launchProfileId);
    assert.equal(binding.launchProfileHash, fixture.profile.launchProfileHash);
    assert.equal(binding.createdAt, fixture.clock.now());

    const replay = coordinator.start(request);
    assert.equal(replay.replayed, true);
    assert.equal(driver.calls, 1, "duplicate idempotent Start must not install a second drive");

    const competing = startRequest("run_coord_competing");
    assert.throws(() => coordinator.start(competing), (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");
    assert.equal(fixture.store.getRun(competing.runId), undefined, "competing Start must conflict before durable creation");

    const collisionRun = asRunId("run_coord_binding_collision");
    assert.throws(() => fixture.core.startRunWithLaunchBinding(collisionRun, "atomic rollback", "coord:binding-collision", {
      ...binding,
      runId: collisionRun,
    }, asCommandId("command_coord_binding_collision")));
    assert.equal(fixture.store.getRun(collisionRun), undefined, "binding constraint failure must roll back the run row");
    assert.equal(fixture.store.getRunLaunchBinding(collisionRun), undefined);
  } finally {
    driver.release.resolve();
    if (driver.started.settled) {
      await settleDriver(driver.done.promise);
      await Promise.resolve();
      await Promise.resolve();
    }
    fixture.close();
  }
});

test("Pause waits for owned work, and Resume continues the same drive", async () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const coordinator = fixture.coordinator(driver);
  const started = startRequest("run_coord_pause");
  try {
    coordinator.start(started);
    await driver.started.promise;
    const pauseRequest = controlRequest(started.runId, 1, "command_coord_pause", "coord:pause");
    let pauseFinished = false;
    const pause = coordinator.pause(pauseRequest).then((result) => {
      pauseFinished = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(fixture.store.getRun(started.runId)?.state, "INTAKE");
    assert.equal(pauseFinished, false, "Pause must wait for the owned operation to settle");

    driver.release.resolve();
    const paused = await pause;
    assert.equal(paused.to, "PAUSED");
    assert.equal(fixture.store.getRun(started.runId)?.state, "PAUSED");
    assert.equal(driver.continued.settled, false, "the drive must remain blocked until Resume commits");

    const resumed = await coordinator.resume(controlRequest(started.runId, paused.stateVersion, "command_coord_resume", "coord:resume"));
    assert.equal(resumed.to, "INTAKE");
    await driver.continued.promise;
    await driver.done.promise;
    assert.equal(driver.calls, 1, "Resume must continue the owned drive rather than create another one");
  } finally {
    driver.release.resolve();
    if (driver.started.settled) {
      await settleDriver(driver.done.promise);
      await Promise.resolve();
      await Promise.resolve();
    }
    fixture.close();
  }
});

test("Pause refuses to create PAUSED when its Phase2 drive has already settled", async () => {
  const fixture = makeCoordinatorFixture();
  const driver = new SettledDriver();
  const coordinator = fixture.coordinator(driver);
  const request = startRequest("run_coord_pause_settled");
  try {
    coordinator.start(request);
    await driver.done.promise;
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(
      coordinator.pause(controlRequest(request.runId, 1, "command_coord_pause_settled", "coord:pause:settled")),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "RUN_DRIVE_NOT_PAUSABLE",
    );
    assert.equal(fixture.store.getRun(request.runId)?.state, "INTAKE");
  } finally {
    fixture.close();
  }
});

test("startup refuses to report an unfinished historical Start as a live drive", () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const runId = asRunId("run_coord_startup");
  const original = startRequest(runId, "command_coord_startup", "coord:startup");
  try {
    const historicalStart = fixture.core.startRun(runId, original.objective, original.idempotencyKey, original.commandId);
    const coordinator = fixture.coordinator(driver);
    assert.equal(coordinator.activeRunId, runId);

    assert.throws(
      () => coordinator.start(original),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "RUN_CONTINUATION_UNAVAILABLE",
    );
    assert.equal(driver.calls, 0, "startup must not replay an unfinished run");
    const preservedStart = fixture.core.startRun(runId, original.objective, original.idempotencyKey, original.commandId);
    assert.deepEqual({ ...preservedStart, replayed: false }, historicalStart, "a rejected coordinator retry must leave the historical Start result unchanged");
    assert.equal(fixture.store.getRun(runId)?.stateVersion, historicalStart.stateVersion);
    assert.equal(fixture.store.listTransitions(runId).length, 1);
    const competing = startRequest("run_coord_startup_competing");
    assert.throws(() => coordinator.start(competing), (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");
    assert.equal(fixture.store.getRun(competing.runId), undefined);
  } finally {
    fixture.close();
  }
});

test("live executor REWORK is projected before Phase2 registers its held-gate checkpoint", async () => {
  const fixture = makeCoordinatorFixture();
  let coordinator!: RunCoordinator;
  const driver = new ExecutorGateProjectionDriver(fixture.core, fixture.store, (runId, gateId) => coordinator.getActionableGateOptionIds(runId, gateId), fixture.adapter);
  coordinator = fixture.coordinator(driver);
  const request = startRequest("run_coord_gate_projection_race");
  try {
    coordinator.start(request);
    const beforeHold = await Promise.race([
      driver.beforeHold.promise,
      driver.done.promise.then(() => { throw driver.error ?? new Error("driver exited before the gate projection"); }),
    ]);
    assert.deepEqual(beforeHold, ["rework"], "persisted blocked proof plus the live owned drive keeps REWORK visible before heldGate registration");

    const afterHold = await driver.afterHold.promise;
    assert.deepEqual([...afterHold].sort(), ["cancel", "fail", "rework"]);
    const model = fixture.core.readModel(request.runId);
    const gate = model?.currentGate;
    assert.ok(model);
    assert.ok(gate);
    assert.ok(gate.attemptId);
    const resolved = await coordinator.resolveGate({
      runId: request.runId,
      expectedStateVersion: model.run.stateVersion,
      commandId: asCommandId("command_coord_gate_projection_cancel"),
      idempotencyKey: "coord:gate-projection:cancel",
      gateId: gate.gateId,
      optionId: "cancel",
    });
    assert.equal(resolved.to, "CANCELLED");
    await driver.done.promise;
    assert.equal(coordinator.activeRunId, undefined);
  } finally {
    fixture.close();
  }
});

test("startup fails closed when more than one run is unfinished", () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const first = asRunId("run_coord_startup_multiple_a");
  const second = asRunId("run_coord_startup_multiple_b");
  try {
    fixture.core.startRun(first, "first unfinished run", "coord:startup:multiple:a", asCommandId("command_coord_startup_multiple_a"));
    fixture.core.startRun(second, "second unfinished run", "coord:startup:multiple:b", asCommandId("command_coord_startup_multiple_b"));
    const before = [fixture.store.getRun(first), fixture.store.getRun(second)];
    assert.throws(
      () => fixture.coordinator(driver),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "MULTIPLE_UNFINISHED_RUNS",
    );
    assert.equal(driver.calls, 0);
    assert.deepEqual([fixture.store.getRun(first), fixture.store.getRun(second)], before, "startup must not mutate either unfinished run");
    assert.equal(fixture.store.listUnfinishedRuns().length, 2);
  } finally {
    fixture.close();
  }
});

test("startup does not report a persisted Resume replay as a live continuation", async () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const runId = asRunId("run_coord_resume_restart");
  const started = fixture.core.startRun(runId, "restart a previously resumed run", "coord:resume-restart:start", asCommandId("command_coord_resume_restart_start"));
  const paused = fixture.core.pause(runId, started.stateVersion, "coord:resume-restart:pause", asCommandId("command_coord_resume_restart_pause"));
  fixture.core.resume(runId, paused.stateVersion, "coord:resume-restart:resume", asCommandId("command_coord_resume_restart_resume"));
  const coordinator = fixture.coordinator(driver);
  try {
    await assert.rejects(
      coordinator.resume(controlRequest(runId, paused.stateVersion, "command_coord_resume_restart_resume", "coord:resume-restart:resume")),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "RUN_CONTINUATION_UNAVAILABLE",
    );
    assert.equal(driver.calls, 0);
    assert.equal(fixture.store.getRun(runId)?.state, "INTAKE");
  } finally {
    fixture.close();
  }
});

test("completion winning before Cancel is quiescent and receives no external signal", async () => {
  const fixture = makeCoordinatorFixture(new ControlledRealAdapter(fixedClock(), new SequenceIdSource("coord_complete_adapter")));
  const releaseCheckpoint = deferred<void>();
  const driver = new RealAttemptDriver(fixture.core, fixture.store, fixture.adapter as ControlledRealAdapter, releaseCheckpoint);
  const coordinator = fixture.coordinator(driver);
  const started = startRequest("run_coord_complete_wins");
  try {
    coordinator.start(started);
    await driver.waitForStart();
    (fixture.adapter as ControlledRealAdapter).finishNormally();
    await driver.completionPersisted.promise;
    const current = fixture.store.getRun(started.runId)!;
    assert.equal(current.state, "VERIFY_FOCUSED");
    assert.equal(fixture.store.getAttempt(current.activeAttemptId!)?.lifecycle, "SUCCEEDED");

    const cancel = coordinator.cancel(cancelRequest(started.runId, current.stateVersion, "command_coord_complete_cancel", "coord:complete-cancel"));
    await Promise.resolve();
    assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 0);
    releaseCheckpoint.resolve();
    const result = await cancel;
    await driver.done.promise;
    assert.equal(result.to, "CANCELLED");
    assert.equal(fixture.store.getRun(started.runId)?.state, "CANCELLED");
    assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 0, "a completed attempt must never receive a provider signal");
    assert.equal(coordinator.activeRunId, undefined, "a quiescent terminal Cancel releases the run reservation");
  } finally {
    releaseCheckpoint.resolve();
    fixture.close();
  }
});

test("durable cancellation intent wins result-ingestion race with at most one signal", async () => {
  const fixture = makeCoordinatorFixture(new ControlledRealAdapter(fixedClock(), new SequenceIdSource("coord_cancel_adapter")));
  const driver = new RealAttemptDriver(fixture.core, fixture.store, fixture.adapter as ControlledRealAdapter);
  const coordinator = fixture.coordinator(driver);
  const started = startRequest("run_coord_cancel_wins");
  const request = cancelRequest(started.runId, 4, "command_coord_cancel_wins", "coord:cancel-wins");
  try {
    coordinator.start(started);
    await driver.waitForStart();
    const cancelled = await coordinator.cancel(request);
    await driver.done.promise;
    assert.equal(cancelled.to, "CANCELLED");
    assert.equal(cancelled.commandId, request.commandId);
    assert.equal(cancelled.idempotencyKey, request.idempotencyKey);
    assert.equal(cancelled.replayed, false);
    assert.equal(fixture.store.getRun(started.runId)?.state, "CANCELLED");
    assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 1);
    const attemptId = fixture.store.getRun(started.runId)?.activeAttemptId;
    assert.ok(attemptId);
    assert.equal(fixture.store.getCancellationIntent(attemptId)?.requestCommandId, request.commandId);
    assert.equal(fixture.store.getCancellationIntent(attemptId)?.requestIdempotencyKey, request.idempotencyKey);
    assert.equal(fixture.store.getCancellationIntent(attemptId)?.requestExpectedStateVersion, request.expectedStateVersion);
    assert.equal(fixture.store.getCancellationIntent(attemptId)?.status, "CANCELLED");
    assert.equal(fixture.store.listTransitions(started.runId).filter((transition) => transition.to === "VERIFY_FOCUSED").length, 0,
      "durable intent must prevent a competing normal-completion transition");
    const replay = await coordinator.cancel(request);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, cancelled, "replay must preserve the exact durable external command result");
    assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 1, "Cancel replay must not signal the adapter twice");
  } finally {
    fixture.close();
  }
});

test("SIGNAL_PENDING cancellation errors reconcile once in-process to CANCELLED or RECOVERY", async () => {
  for (const scenario of [
    { label: "terminal proof", outcome: undefined, expected: "CANCELLED" as const },
    { label: "uncertain reconciliation", outcome: { outcome: "unknown", summary: "fixture cannot prove cancellation" } satisfies ReconcileOutcome, expected: "RECOVERY" as const },
  ]) {
    const adapter = new ControlledRealAdapter(fixedClock(), new SequenceIdSource(`coord_signal_error_${scenario.expected}`));
    adapter.throwAfterSignal = true;
    adapter.reconcileOutcome = scenario.outcome;
    const fixture = makeCoordinatorFixture(adapter);
    const driver = new RealAttemptDriver(fixture.core, fixture.store, adapter);
    const coordinator = fixture.coordinator(driver);
    const started = startRequest(`run_coord_signal_error_${scenario.expected.toLowerCase()}`);
    const request = cancelRequest(started.runId, 4, `command_coord_signal_error_${scenario.expected.toLowerCase()}`, `coord:signal-error:${scenario.expected}`, "reconcile after a pending signal error");
    try {
      coordinator.start(started);
      await driver.waitForStart();
      const result = await coordinator.cancel(request);
      await driver.done.promise;

      assert.equal(result.commandId, request.commandId);
      assert.equal(result.idempotencyKey, request.idempotencyKey);
      assert.equal(result.replayed, false);
      assert.equal(result.to, scenario.expected, scenario.label);
      assert.equal(driver.calls, 1, "the coordinator must reconcile without restarting the drive");
      assert.equal(adapter.cancelCalls, 1, "the provider signal must be attempted exactly once");
      assert.equal(adapter.reconcileCalls, 1, "the ambiguous signal boundary must be reconciled in this process");

      const replay = await coordinator.cancel(request);
      assert.deepEqual({ ...replay, replayed: false }, result);
      assert.equal(adapter.cancelCalls, 1, "replay must not signal again");
      assert.equal(adapter.reconcileCalls, 1, "a durable final replay must not reconcile or signal again");
    } finally {
      fixture.close();
    }
  }
});

for (const intentStatus of ["REQUESTED", "SIGNAL_PENDING"] as const) {
  test(`restart with ${intentStatus} cancellation intent never blindly re-signals`, async () => {
    const fixture = makeCoordinatorFixture(new ControlledRealAdapter(fixedClock(), new SequenceIdSource(`coord_restart_adapter_${intentStatus}`)));
    const runId = asRunId(`run_coord_restart_${intentStatus.toLowerCase()}`);
    let driver = new BlockingDriver(fixture.store);
    try {
      const taskId = asTaskId(`task_coord_restart_${intentStatus.toLowerCase()}`);
      fixture.core.startRun(runId, "restart cancellation fixture", `coord:restart:start:${intentStatus}`, asCommandId(`command_coord_restart_start_${intentStatus.toLowerCase()}`));
      let version = fixture.core.completeIntake(runId, 1, `coord:restart:intake:${intentStatus}`).stateVersion;
      const decision = createPhase2PlanningDecision({
        decisionId: `decision_coord_restart_${intentStatus.toLowerCase()}`,
        runId,
        taskId,
        objective: "exercise restart cancellation reconciliation",
        acceptance: ["preserve the durable cancellation boundary"],
        positiveScope: ["src"],
        negativeScope: ["out of scope"],
        model: "fixture-model",
        canonicalContext: `restart-${intentStatus}`,
      });
      version = fixture.core.plan(runId, version, `coord:restart:plan:${intentStatus}`, decision).stateVersion;
      version = fixture.core.prepareExecution(runId, version, `coord:restart:prepare:${intentStatus}`).stateVersion;
      await fixture.core.beginAttempt(runId, version, `coord:restart:begin:${intentStatus}`, "<test-worktree>", { prompt: "restart", timeoutMs: 1000 });
      const attemptId = fixture.store.getRun(runId)?.activeAttemptId;
      assert.ok(attemptId);
      const request = cancelRequest(
        runId,
        version,
        `command_coord_restart_cancel_${intentStatus.toLowerCase()}`,
        `coord:restart:cancel:${intentStatus}`,
        "restart must reconcile first",
      );
      fixture.core.requestRealCancellation(
        runId,
        version,
        `coord:restart:request:${intentStatus}`,
        request.reason,
        asCommandId(`command_coord_restart_internal_request_${intentStatus.toLowerCase()}`),
        version,
        { commandId: request.commandId, idempotencyKey: request.idempotencyKey, expectedStateVersion: request.expectedStateVersion },
      );

      fixture.store.close();
      if (intentStatus === "SIGNAL_PENDING") {
        const db = new DatabaseSync(fixture.dbPath);
        try {
          db.prepare("UPDATE cancellation_intents SET status = 'SIGNAL_PENDING' WHERE attempt_id = ?").run(attemptId);
        } finally {
          db.close();
        }
      }
      fixture.reopen();
      driver = new BlockingDriver(fixture.store);
      const coordinator = fixture.coordinator(driver);
      assert.equal(driver.calls, 0);
      assert.throws(
        () => coordinator.cancel({ ...request, expectedStateVersion: request.expectedStateVersion + 1 }),
        (error: unknown) => error instanceof KerbsFlowError && error.code === "CANCELLATION_COMMAND_CONFLICT",
        "a restarted intent must not authorize the same command identity with a changed original precondition",
      );
      const result = await coordinator.cancel(request);
      assert.equal(result.commandId, request.commandId);
      assert.equal(result.idempotencyKey, request.idempotencyKey);
      assert.equal(result.replayed, false);
      assert.equal(result.to, "RECOVERY");
      assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 0);
      assert.equal(fixture.store.getRun(runId)?.state, "RECOVERY");
      assert.equal(fixture.store.getCancellationIntent(attemptId)?.status, "UNCERTAIN");
      const replay = await coordinator.cancel(request);
      assert.deepEqual({ ...replay, replayed: false }, result);
      assert.equal((fixture.adapter as ControlledRealAdapter).cancelCalls, 0);
    } finally {
      fixture.close();
    }
  });
}

class ExecutorGateProjectionDriver {
  readonly beforeHold = deferred<readonly string[]>();
  readonly afterHold = deferred<readonly string[]>();
  readonly done = deferred<void>();
  error: unknown;

  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly project: (runId: RunId, gateId: GateId) => readonly string[],
    private readonly adapter: FakeAdapter,
  ) {}

  async driveStarted(request: Phase2LoopRequest, controls?: Phase2DriveControls): Promise<Phase2LoopResult> {
    try {
      let command = this.core.completeIntake(request.runId, this.store.getRun(request.runId)!.stateVersion, `${request.runId}:gate-projection:intake`);
      const planned = createPhase2PlanningDecision({
        decisionId: `decision_${request.runId}`,
        runId: request.runId,
        taskId: request.taskId,
        objective: request.objective,
        acceptance: ["the blocked executor gate retains its exact actionability"],
        positiveScope: ["src"],
        negativeScope: ["out of scope"],
        model: "fixture-model",
        canonicalContext: "live executor gate projection race",
      });
      const decision = { ...planned, route: { adapter: "fake" as const, model: "fake" }, requiredCapabilities: ["simulated_execution"], policyVersion: "phase1-test-policy" };
      command = this.core.plan(request.runId, command.stateVersion, `${request.runId}:gate-projection:plan`, decision);
      command = this.core.prepareExecution(request.runId, command.stateVersion, `${request.runId}:gate-projection:prepare`);
      this.adapter.script(request.taskId, "blocked");
      command = await this.core.beginFakeAttempt(request.runId, command.stateVersion, `${request.runId}:gate-projection:begin`);
      command = await this.core.completeFakeAttempt(request.runId, command.stateVersion, `${request.runId}:gate-projection:complete`);
      const model = this.core.readModel(request.runId);
      const gate = model?.currentGate;
      if (model === undefined || gate === undefined || gate.attemptId === null) throw new Error("synthetic executor did not persist an attempt-bound gate");

      this.beforeHold.resolve(this.project(request.runId, gate.gateId));
      const held = controls?.waitForGateResolution?.({ gateId: gate.gateId, taskId: request.taskId, attemptId: gate.attemptId });
      this.afterHold.resolve(this.project(request.runId, gate.gateId));
      const stateVersion = held === undefined ? command.stateVersion : await held;
      return { verdict: "CANCELLED", stateVersion };
    } catch (error) {
      this.error = error;
      throw error;
    } finally {
      this.done.resolve();
    }
  }
}

class BlockingDriver {
  calls = 0;
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  readonly continued = deferred<void>();
  readonly done = deferred<void>();

  constructor(private readonly store: StateStore) {}

  async driveStarted(request: Phase2LoopRequest, controls?: Phase2DriveControls): Promise<Phase2LoopResult> {
    this.calls += 1;
    this.started.resolve();
    try {
      await this.release.promise;
      await controls?.checkpoint?.();
      this.continued.resolve();
      return { verdict: "HUMAN_GATE", stateVersion: this.store.getRun(request.runId)?.stateVersion ?? 0 };
    } finally {
      this.done.resolve();
    }
  }
}

class SettledDriver {
  readonly done = deferred<void>();

  async driveStarted(_request: Phase2LoopRequest): Promise<Phase2LoopResult> {
    this.done.resolve();
    return { verdict: "HUMAN_GATE", stateVersion: 1 };
  }
}

class RealAttemptDriver {
  calls = 0;
  readonly waitingForResult = deferred<void>();
  readonly completionPersisted = deferred<void>();
  readonly done = deferred<void>();
  error: unknown;

  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly adapter: ControlledRealAdapter,
    private readonly afterCompletion?: Deferred<void>,
    private readonly clock = fixedClock(),
  ) {}

  async driveStarted(request: Phase2LoopRequest, controls?: Phase2DriveControls): Promise<Phase2LoopResult> {
    this.calls += 1;
    try {
      let command = this.core.completeIntake(request.runId, this.store.getRun(request.runId)!.stateVersion, `${request.runId}:driver:intake`);
      const proposed = createPhase2PlanningDecision({
        decisionId: `decision_${request.runId}`,
        runId: request.runId,
        taskId: request.taskId,
        objective: request.objective,
        acceptance: ["the controlled attempt reaches one terminal winner"],
        positiveScope: ["src"],
        negativeScope: ["out of scope"],
        model: "fixture-model",
        canonicalContext: "coordinator real attempt fixture",
      });
      const model: RouteModelPolicy = { adapter: "codex", provider: "openai", model: "fixture-model", family: "sol", reasoning: "high" };
      const discovery = await new RoutingDiscovery([{ adapter: "codex", implementation: this.adapter }], { now: () => this.clock.now() })
        .discover({ workingDirectory: request.repositoryPath, models: [model] });
      const routed = new PolicyRouter().route({ planningDecision: proposed, classification: "difficult", discovery });
      command = this.core.plan(request.runId, command.stateVersion, `${request.runId}:driver:plan`, routed.planningDecision);
      this.store.recordRoutingDecision(routed.routingDecision);
      command = this.core.prepareExecution(request.runId, command.stateVersion, `${request.runId}:driver:prepare`);
      const attemptId = this.store.getRun(request.runId)?.activeAttemptId;
      assert.ok(attemptId);
      this.store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
        routingDecision: routed.routingDecision,
        planningDecision: routed.planningDecision,
        attemptId,
        selectionReason: routed.routingDecision.selectionReason,
      }));
      await this.core.beginAttempt(request.runId, command.stateVersion, `${request.runId}:driver:begin`, request.repositoryPath, { prompt: "coordinator fixture", timeoutMs: 1000 });
      const completion = this.core.completeAttempt(request.runId, command.stateVersion, `${request.runId}:driver:complete`);
      await this.adapter.waitStarted.promise;
      this.waitingForResult.resolve();
      command = await completion;
      this.completionPersisted.resolve();
      await this.afterCompletion?.promise;
      await controls?.checkpoint?.();
      return { verdict: "HUMAN_GATE", stateVersion: this.store.getRun(request.runId)?.stateVersion ?? command.stateVersion };
    } catch (error) {
      this.error = error;
      throw error;
    } finally {
      this.done.resolve();
    }
  }

  async waitForStart(): Promise<void> {
    await Promise.race([
      this.waitingForResult.promise,
      this.done.promise.then(() => { throw this.error ?? new Error("driver completed before entering the controlled adapter wait"); }),
    ]);
  }
}

class ControlledRealAdapter extends FakeAdapter {
  cancelCalls = 0;
  reconcileCalls = 0;
  throwAfterSignal = false;
  reconcileOutcome: ReconcileOutcome | undefined;
  private activeHandle?: AttemptHandle;
  private resolveWait?: (value: unknown) => void;
  readonly waitStarted = deferred<void>();

  override probe(): AdapterDescriptor {
    const descriptor = super.probe();
    return {
      ...descriptor,
      adapter: "codex",
      provider: "openai",
      capabilities: {
        ...descriptor.capabilities,
        eventTransport: "jsonl",
        finalJsonSchema: true,
        modelSelection: true,
        reasoningEffort: ["high"],
        filesystemEnforcement: "enforced",
        network: { providerControlPlane: "provider_owned", workload: "enforced" },
        cancellation: "process_only",
        resumableSession: true,
      },
    };
  }

  override wait(handle: AttemptHandle): Promise<unknown> {
    this.activeHandle = handle;
    this.waitStarted.resolve();
    return new Promise((resolve) => { this.resolveWait = resolve; });
  }

  override cancel(handle: AttemptHandle, reason: string) {
    this.cancelCalls += 1;
    const outcome = super.cancel(handle, reason);
    void super.wait(handle).then((result) => this.resolveWait?.(this.codexResult(result)));
    if (this.throwAfterSignal) throw new Error("fixture adapter failed after the durable signal boundary");
    return outcome;
  }

  override async reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome> {
    this.reconcileCalls += 1;
    return this.reconcileOutcome ?? super.reconcile(identity);
  }

  finishNormally(): void {
    const handle = this.activeHandle;
    if (handle === undefined) throw new Error("controlled executor has not started");
    void super.wait(handle).then((result) => this.resolveWait?.(this.codexResult(result)));
  }

  private codexResult(result: unknown): unknown {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
    const record = result as Record<string, unknown>;
    const executor = record.executor;
    if (typeof executor !== "object" || executor === null || Array.isArray(executor)) return result;
    return { ...record, executor: { ...executor, adapter: "codex", adapterVersion: "fixture", provider: "openai", model: "fixture-model" } };
  }
}

function makeCoordinatorFixture(adapter = new FakeAdapter(fixedClock(), new SequenceIdSource("coord_adapter"))) {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-run-coordinator-"));
  const clock = fixedClock();
  const ids = new SequenceIdSource("run_coordinator");
  let store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  const artifacts = new FakeArtifactStore(ids);
  const coreAdapter = adapter instanceof ControlledRealAdapter ? new RoutedExecutorAdapter([adapter]) : adapter;
  let core = coordinatorCore(store, coreAdapter, artifacts, clock, ids);
  const profile: TrustedLaunchProfile = {
    launchProfileId: "synthetic-test-profile/v1",
    launchProfileHash: "a".repeat(64),
    canonicalRepositoryPath: root,
    focusedCheck: { name: "synthetic", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000 },
    executionTimeoutMs: 1000,
    planningMaster: unusedPlanningMaster(),
  };
  return {
    root,
    dbPath: join(root, "state.sqlite"),
    clock,
    ids,
    get store() { return store; },
    get core() { return core; },
    artifacts,
    adapter,
    profile,
    coordinator(driver: Pick<Phase2Loop, "driveStarted">) {
      return new RunCoordinator(core, store, driver, profile, ids);
    },
    reopen() {
      store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
      core = coordinatorCore(store, coreAdapter, artifacts, clock, ids);
      return { store, core };
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function coordinatorCore(store: StateStore, adapter: FakeAdapter | RoutedExecutorAdapter, artifacts: FakeArtifactStore, clock: FixedClock, ids: SequenceIdSource): KerbsFlowCore {
  return new KerbsFlowCore(store, adapter, artifacts, {
    clock,
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: { ...DEFAULT_PROJECT_POLICY, allowedAdapters: ["fake", "codex"] },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    },
  });
}

function unusedPlanningMaster(): PlanningMaster {
  return {
    planInitial: () => { throw new Error("synthetic driver does not invoke Planning Master"); },
    planRework: () => { throw new Error("synthetic driver does not invoke Planning Master"); },
  };
}

function startRequest(runId: string, commandId = `command_${runId}`, idempotencyKey = `start:${runId}`): CoordinatorStartRequest {
  return {
    runId: asRunId(runId),
    objective: "synthetic coordinator objective",
    commandId: asCommandId(commandId),
    idempotencyKey,
    expectedStateVersion: 0,
  };
}

function controlRequest(runId: RunId, expectedStateVersion: number, commandId: string, idempotencyKey: string): CoordinatorControlRequest {
  return { runId, expectedStateVersion, commandId: asCommandId(commandId), idempotencyKey };
}

function cancelRequest(runId: RunId, expectedStateVersion: number, commandId: string, idempotencyKey: string, reason = "synthetic cancellation"): CoordinatorCancelRequest {
  return { ...controlRequest(runId, expectedStateVersion, commandId, idempotencyKey), reason };
}

function fixedClock(): FixedClock {
  return new FixedClock("2026-09-28T12:00:00.000Z");
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((accept) => {
    resolve = (value: T) => {
      if (settled) return;
      settled = true;
      accept(value);
    };
  });
  return { promise, resolve, get settled() { return settled; } };
}

async function settleDriver(promise: Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 250); })]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  readonly settled: boolean;
}
