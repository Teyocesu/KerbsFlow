import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  asCommandId,
  asRunId,
  asTaskId,
  parseExecutorResult,
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

test("Pause waits for owned work, concurrent Resume commits once, and later Cancel preserves its receipt", { timeout: 5_000 }, async () => {
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

    const resumeRequest = controlRequest(started.runId, paused.stateVersion, "command_coord_resume", "coord:resume");
    const resume = coordinator.resume(resumeRequest);
    const duplicate = coordinator.resume({ ...resumeRequest });
    const incompatible = assert.rejects(coordinator.resume({ ...resumeRequest, commandId: asCommandId("command_coord_resume_other"), idempotencyKey: "coord:resume:other" }),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "CONTROL_COMMAND_IN_PROGRESS");
    assert.equal(fixture.store.getRun(started.runId)?.state, "PAUSED");
    assert.equal(fixture.store.getCommandIdempotencyKey(resumeRequest.commandId), undefined);
    const [resumed, sameOutcome] = await Promise.all([resume, duplicate]);
    await incompatible;
    assert.strictEqual(sameOutcome, resumed, "identical pending requests share the exact operational result");
    assert.equal(resumed.to, "INTAKE");
    assert.equal(fixture.store.getCommandIdempotencyKey(resumeRequest.commandId), resumeRequest.idempotencyKey);
    assert.equal(fixture.store.listTransitions(started.runId).filter(t => t.reasonCode === "resume_persisted_target").length, 1);
    await driver.continued.promise;
    await driver.done.promise;
    assert.equal(driver.calls, 1, "Resume must continue the owned drive rather than create another one");
    const cancelled = await coordinator.cancel(cancelRequest(started.runId, resumed.stateVersion, "command_coord_later_cancel", "coord:later-cancel"));
    assert.equal(cancelled.to, "CANCELLED");
    const replay = await coordinator.resume(resumeRequest);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, resumed, "later Cancel cannot revoke the successful operational receipt");
    assert.equal(coordinator.activeRunId, undefined);
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

test("a Resume Core error reaches every waiter and preserves the held checkpoint for an explicit Resume", { timeout: 5_000 }, async () => {
  const fixture = makeCoordinatorFixture();
  const driver = new BlockingDriver(fixture.store);
  const coordinator = fixture.coordinator(driver);
  const started = startRequest("run_coord_resume_error");
  const originalError = new Error("synthetic Resume transaction failure");
  const coreResume = fixture.core.resume.bind(fixture.core);
  let calls = 0;
  fixture.core.resume = (...args) => {
    calls += 1;
    if (calls === 1) throw originalError;
    return coreResume(...args);
  };
  try {
    coordinator.start(started);
    await driver.started.promise;
    const pause = coordinator.pause(controlRequest(started.runId, 1, "command_coord_error_pause", "coord:error:pause"));
    driver.release.resolve();
    const paused = await pause;
    const failedRequest = controlRequest(started.runId, paused.stateVersion, "command_coord_error_resume", "coord:error:resume");
    const failed = coordinator.resume(failedRequest);
    const duplicate = coordinator.resume({ ...failedRequest });
    await Promise.all([
      assert.rejects(failed, (error: unknown) => error === originalError),
      assert.rejects(duplicate, (error: unknown) => error === originalError),
    ]);
    assert.equal(calls, 1, "Core errors do not trigger automatic retries");
    assert.equal(fixture.store.getRun(started.runId)?.state, "PAUSED");
    assert.equal(fixture.store.getRun(started.runId)?.stateVersion, paused.stateVersion);
    assert.equal(fixture.store.getCommandIdempotencyKey(failedRequest.commandId), undefined);
    assert.equal(driver.continued.settled, false);
    assert.equal(coordinator.activeRunId, started.runId);
    assert.throws(() => coordinator.start(startRequest("run_coord_error_competing")),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");

    const resumed = await coordinator.resume(controlRequest(started.runId, paused.stateVersion, "command_coord_error_explicit_resume", "coord:error:explicit-resume"));
    assert.equal(resumed.to, "INTAKE");
    assert.equal(calls, 2);
    await driver.continued.promise;
    await driver.done.promise;
    assert.equal(driver.calls, 1);
    assert.equal(fixture.store.getCommandIdempotencyKey(failedRequest.commandId), undefined);
    assert.equal(fixture.store.listTransitions(started.runId).filter(t => t.reasonCode === "resume_persisted_target").length, 1);
  } finally {
    driver.release.resolve();
    const current = fixture.store.getRun(started.runId);
    if (current?.state === "PAUSED") await coordinator.cancel(cancelRequest(started.runId, current.stateVersion, "command_coord_error_cleanup", "coord:error:cleanup"));
    await driver.done.promise;
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

for (const control of ["pause", "cancel"] as const) {
  test(`a terminal settled drive retains its reservation until its ${control} claim clears`, async () => {
    const fixture = makeCoordinatorFixture();
    const release = deferred<void>();
    const driver = {
      async driveStarted(request: Phase2LoopRequest): Promise<Phase2LoopResult> {
        await release.promise;
        const failed = fixture.core.failIntake(request.runId, 1, `${request.runId}:fail`, "synthetic_failure", "Synthetic terminal failure.");
        return { verdict: "FAILED", stateVersion: failed.stateVersion };
      },
    };
    const coordinator = fixture.coordinator(driver);
    const start = startRequest(`run_coord_terminal_claim_${control}`);
    let operation: Promise<unknown> | undefined;
    try {
      coordinator.start(start);
      const reservation = (coordinator as unknown as { reservation: { settled: Deferred<void>; drivePromise: Promise<void>; pauseClaim?: unknown; cancelClaim?: unknown } }).reservation;
      const observed = reservation.settled.promise.then(() => {
        assert.ok(reservation[control === "pause" ? "pauseClaim" : "cancelClaim"]);
        assert.equal(fixture.store.getRun(start.runId)?.state, "FAILED");
        assert.equal(coordinator.activeRunId, start.runId);
        assert.throws(() => coordinator.start(startRequest(`run_coord_terminal_competing_${control}`)),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");
      });
      operation = control === "pause"
        ? coordinator.pause(controlRequest(start.runId, 1, `command_terminal_pause_${control}`, `terminal:pause:${control}`))
        : coordinator.cancel(cancelRequest(start.runId, 1, `command_terminal_cancel_${control}`, `terminal:cancel:${control}`));
      const rejected = assert.rejects(operation, (error: unknown) => error instanceof KerbsFlowError
        && error.code === (control === "pause" ? "RUN_DRIVE_NOT_PAUSABLE" : "CANCEL_NOT_ALLOWED"));
      release.resolve();
      await Promise.all([observed, rejected, reservation.drivePromise]);
      assert.equal(coordinator.activeRunId, undefined);
      assert.equal(coordinator.start(startRequest(`run_coord_terminal_after_${control}`)).to, "INTAKE");
      const next = (coordinator as unknown as { reservation: { drivePromise: Promise<void> } }).reservation;
      await next.drivePromise;
    } finally {
      release.resolve();
      await operation?.catch(() => undefined);
      fixture.close();
    }
  });
}

for (const control of ["pause", "cancel"] as const) {
  test(`failure disposition claims before its continuation and excludes later ${control}`, { timeout: 5_000 }, async () => {
    const fixture = makeCoordinatorFixture();
    const runId = asRunId(`run_disposition_first_${control}`);
    const driver = {
      async driveStarted(request: Phase2LoopRequest, controls: Phase2DriveControls = {}): Promise<Phase2LoopResult> {
        const runId = request.runId;
        fixture.core.completeIntake(request.runId, 1, `${request.runId}:intake`);
        assert.ok(controls.claimFailureDisposition);
        const acquiring = controls.claimFailureDisposition();
        const observed = acquiring.then((boundary) => {
          const reservation = (coordinator as unknown as { reservation: { failureDispositionClaim?: unknown; pauseClaim?: unknown; cancelClaim?: unknown } }).reservation;
          assert.ok(reservation.failureDispositionClaim, "the claim is installed before acquisition resolves");
          assert.equal(boundary.stateVersion, 2);
          assert.throws(() => control === "pause"
            ? coordinator.pause(controlRequest(runId, 2, `command_disposition_pause_${control}`, `disposition:pause:${control}`))
            : coordinator.cancel(cancelRequest(runId, 2, `command_disposition_cancel_${control}`, `disposition:cancel:${control}`)),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "CONTROL_COMMAND_IN_PROGRESS");
          assert.equal(reservation.pauseClaim, undefined);
          assert.equal(reservation.cancelClaim, undefined);
          return boundary;
        });
        const boundary = await observed;
        try {
          const result = fixture.core.failInitialPlanning(runId, boundary.stateVersion, `${runId}:fail`);
          assert.equal(coordinator.activeRunId, runId, "terminal state retains the live failure claim");
          return { verdict: "FAILED", stateVersion: result.stateVersion };
        } finally {
          boundary.release();
          boundary.release();
        }
      },
    };
    const coordinator = fixture.coordinator(driver);
    try {
      coordinator.start(startRequest(runId));
      const reservation = (coordinator as unknown as { reservation: { drivePromise: Promise<void>; driveError?: unknown; failureDispositionClaim?: unknown } }).reservation;
      await reservation.drivePromise;
      assert.equal(reservation.driveError, undefined);
      assert.equal(reservation.failureDispositionClaim, undefined);
      assert.equal(fixture.store.getRun(runId)?.state, "FAILED");
      assert.equal(fixture.store.getRun(runId)?.stateVersion, 3);
      assert.equal(fixture.store.listTransitions(runId).filter(t => t.to === "FAILED").length, 1);
      assert.equal(coordinator.activeRunId, undefined);
      assert.equal(coordinator.start(startRequest(`run_after_disposition_${control}`)).to, "INTAKE");
      const next = (coordinator as unknown as { reservation: { drivePromise: Promise<void> } }).reservation;
      await next.drivePromise;
      assert.equal(coordinator.activeRunId, undefined);
    } finally {
      fixture.close();
    }
  });
}

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

test("rejected direct terminal recovery keeps the startup coordinator reservation", async (suite) => {
  for (const lifecycle of ["PREPARED", "RUNNING", "UNKNOWN"] as const) {
    await suite.test(`${lifecycle} remains reserved after rejected terminal recovery`, async () => {
      const fixture = makeCoordinatorFixture();
      const runId = asRunId(`run_coord_recovery_slot_${lifecycle.toLowerCase()}`);
      try {
        const recovery = await stageCoordinatorRecovery(fixture, runId, lifecycle);
        const coordinator = fixture.coordinator(new SettledDriver());
        assert.equal(coordinator.activeRunId, runId);
        assert.throws(
          () => fixture.core.recover(runId, recovery.stateVersion, `coord:recovery-slot:reject:${lifecycle}`, {
            schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
            runId,
            target: "FAILED",
            summary: "ambiguous attempts cannot be abandoned",
            evidenceRefs: [],
          }),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "RECOVERY_EVIDENCE_INSUFFICIENT",
        );

        assert.equal(coordinator.activeRunId, runId, "rejected recovery must retain the startup reservation");
        const competingRun = startRequest(`run_coord_recovery_slot_competing_${lifecycle.toLowerCase()}`);
        assert.throws(
          () => coordinator.start(competingRun),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT",
        );
        assert.equal(fixture.store.getRun(competingRun.runId), undefined, "a rejected recovery cannot free the slot for another Start");
      } finally {
        fixture.close();
      }
    });
  }
});

for (const target of ["FAILED", "CANCELLED"] as const) {
  test(`terminal ${target} recovery releases the startup reservation for the next Start`, async () => {
    const fixture = makeCoordinatorFixture();
    const runId = asRunId(`run_coord_terminal_recovery_${target.toLowerCase()}`);
    const nextRunId = asRunId(`run_coord_after_recovery_${target.toLowerCase()}`);
    const driver = new BlockingDriver(fixture.store);
    try {
      const recovery = await stageCoordinatorRecovery(fixture, runId, "SUCCEEDED");
      const coordinator = fixture.coordinator(driver);
      assert.equal(coordinator.activeRunId, runId);
      const outcome = fixture.store.getAttempt(recovery.attemptId)?.outcomeJson;
      assert.ok(outcome);
      assert.equal(parseExecutorResult(JSON.parse(outcome)).outcome, "succeeded");

      const result = fixture.core.recover(runId, recovery.stateVersion, `coord:recovery-terminal:${target}`, {
        schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
        runId,
        target,
        summary: `terminal ${target} recovery with succeeded executor evidence`,
        evidenceRefs: [],
      });
      assert.equal(result.to, target);
      if (target === "FAILED") {
        assert.equal(coordinator.activeRunId, undefined, "activeRunId reconciles the exact terminal startup reservation");
      }

      const next = coordinator.start(startRequest(nextRunId));
      assert.equal(next.to, "INTAKE", "Start reconciliation releases the stale slot before checking for a conflict");
      await driver.started.promise;
      assert.equal(coordinator.activeRunId, nextRunId, "the next run acquires the released slot");
    } finally {
      driver.release.resolve();
      if (driver.started.settled) await settleDriver(driver.done.promise);
      fixture.close();
    }
  });
}

test("replaying an old terminal recovery cannot release a newer run reservation", async () => {
  const fixture = makeCoordinatorFixture();
  const runId = asRunId("run_coord_recovery_replay_old");
  const nextRunId = asRunId("run_coord_recovery_replay_next");
  const driver = new BlockingDriver(fixture.store);
  try {
    const recovery = await stageCoordinatorRecovery(fixture, runId, "SUCCEEDED");
    const coordinator = fixture.coordinator(driver);
    const recoveryKey = "coord:recovery-replay-old";
    const decision = {
      schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
      runId,
      target: "FAILED" as const,
      summary: "finish the historical recovered run",
      evidenceRefs: [],
    };
    const terminal = fixture.core.recover(runId, recovery.stateVersion, recoveryKey, decision);
    assert.equal(terminal.to, "FAILED");
    assert.equal(coordinator.activeRunId, undefined);

    coordinator.start(startRequest(nextRunId));
    await driver.started.promise;
    assert.equal(coordinator.activeRunId, nextRunId);
    const replay = fixture.core.recover(runId, recovery.stateVersion, recoveryKey, decision);
    assert.equal(replay.replayed, true);
    assert.equal(coordinator.activeRunId, nextRunId, "old recovery replay cannot reconcile or clear the newer reservation");
    assert.throws(
      () => coordinator.start(startRequest("run_coord_recovery_replay_competing")),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT",
    );
  } finally {
    driver.release.resolve();
    if (driver.started.settled) await settleDriver(driver.done.promise);
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
    assert.deepEqual([...beforeHold].sort(), ["cancel", "fail", "rework"], "the exact live executor gate keeps every policy-valid action visible before heldGate registration");

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

async function stageCoordinatorRecovery(
  fixture: ReturnType<typeof makeCoordinatorFixture>,
  runId: RunId,
  lifecycle: "PREPARED" | "RUNNING" | "UNKNOWN" | "SUCCEEDED",
): Promise<{ stateVersion: number; taskId: TaskId; attemptId: AttemptId }> {
  let command = fixture.core.startRun(runId, "exercise startup recovery ownership", `coord:recovery-stage:${runId}`, asCommandId(`command_${runId}`));
  command = fixture.core.completeIntake(runId, command.stateVersion, `coord:recovery-intake:${runId}`);
  const taskId = asTaskId(`task_${runId}`);
  const planned = createPhase2PlanningDecision({
    decisionId: `decision_${runId}`,
    runId,
    taskId,
    objective: "exercise startup recovery ownership",
    acceptance: ["recovery evidence remains bound to its run and attempt"],
    positiveScope: ["src"],
    negativeScope: ["external execution"],
    model: "fixture-model",
    canonicalContext: "coordinator recovery reservation test",
  });
  const decision = { ...planned, route: { adapter: "fake" as const, model: "fake" }, requiredCapabilities: ["simulated_execution"], policyVersion: "phase1-test-policy" };
  command = fixture.core.plan(runId, command.stateVersion, `coord:recovery-plan:${runId}`, decision);
  command = fixture.core.prepareExecution(runId, command.stateVersion, `coord:recovery-prepare:${runId}`);
  if (lifecycle !== "PREPARED") await fixture.core.beginFakeAttempt(runId, command.stateVersion, `coord:recovery-begin:${runId}`);

  const model = fixture.core.readModel(runId);
  const attemptId = model?.run.activeAttemptId;
  assert.ok(attemptId);
  if (lifecycle === "UNKNOWN" || lifecycle === "SUCCEEDED") {
    const outcomeJson = lifecycle === "SUCCEEDED" ? JSON.stringify(parseExecutorResult({
      schemaVersion: CONTRACT_VERSIONS.executorResult,
      runId,
      taskId,
      attemptId,
      executor: { adapter: "fake", adapterVersion: "fixture", provider: "synthetic", model: "fixture-model" },
      outcome: "succeeded",
      failureClass: null,
      scopeClaim: "within_scope",
      summary: "synthetic terminal executor success",
      filesChanged: [],
      checks: [],
      evidence: [],
      invariantViolations: [],
      risks: [],
      warnings: [],
      artifacts: [],
      humanGate: null,
      recommendedNext: "verify_focused",
      exit: { kind: "normal", code: 0 },
    })) : null;
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.prepare("UPDATE attempts SET lifecycle = ?, outcome_json = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?")
        .run(lifecycle, outcomeJson, lifecycle === "SUCCEEDED" ? fixture.clock.now() : null, fixture.clock.now(), attemptId);
    } finally {
      database.close();
    }
  }

  fixture.store.close();
  fixture.reopen();
  const recovery = fixture.core.readModel(runId);
  assert.equal(recovery?.run.state, "RECOVERY");
  assert.equal(recovery?.activeAttempt?.lifecycle, lifecycle);
  assert.ok(recovery);
  return { stateVersion: recovery.run.stateVersion, taskId, attemptId };
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
