import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSIONS,
  asCommandId,
  asRunId,
  parseCommand,
} from "../src/contracts.js";
import { IdempotencyConflictError, StateVersionConflictError } from "../src/errors.js";
import { KerbsFlowCore } from "../src/core.js";
import { StateStore } from "../src/persistence.js";
import { allLegalTransitions, StateMachineError } from "../src/state-machine.js";
import { createFixture, primeExecute, primeReady, reviewFor, validationFor, TestFixture } from "./helpers.js";

function reopen(fixture: TestFixture): void {
  fixture.store.close();
  fixture.store = StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids });
  fixture.core = new KerbsFlowCore(fixture.store, fixture.adapter, fixture.artifacts, { clock: fixture.clock, ids: fixture.ids });
}

test("fake vertical loop persists through close and reopen", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "success");
    const begin = await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin");
    assert.equal(begin.stateVersion, 4);
    const completed = await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete");
    assert.equal(completed.to, "VERIFY_FOCUSED");
    const validated = fixture.core.recordFocusedValidation(fixture.runId, 5, "validate", validationFor(fixture, "passed"));
    assert.equal(validated.to, "REVIEW");
    const reviewed = fixture.core.review(fixture.runId, 6, "review", reviewFor(fixture, "next_phase", "pass"));
    assert.equal(reviewed.to, "NEXT_PHASE");
    const finalReady = fixture.core.completePhase(fixture.runId, 7, "phase-close", "FINAL_VERIFY");
    assert.equal(finalReady.to, "FINAL_VERIFY");

    reopen(fixture);
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.run.state, "FINAL_VERIFY");
    assert.equal(model?.run.stateVersion, 8);
    assert.equal(model?.currentTask?.taskId, fixture.taskId);
    assert.equal(model?.activeAttempt?.lifecycle, "SUCCEEDED");
    assert.equal(model?.latestValidation?.bundle.outcome, "passed");
    assert.equal(model?.latestReview?.decision.outcome, "next_phase");
    assert.equal(model?.lastTransition?.to, "FINAL_VERIFY");
  } finally {
    fixture.close();
  }
});

test("idempotency reconstructs the original result and rejects mismatched reuse", () => {
  const fixture = createFixture();
  try {
    const first = fixture.core.startRun(fixture.runId, "synthetic objective", "same-key");
    const duplicate = fixture.core.startRun(fixture.runId, "synthetic objective", "same-key");
    assert.equal(first.replayed, false);
    assert.equal(duplicate.replayed, true);
    assert.equal(duplicate.transitionId, first.transitionId);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 1);
    assert.throws(() => fixture.core.startRun(asRunId("run_other"), "different objective", "same-key"), IdempotencyConflictError);
  } finally {
    fixture.close();
  }
});

test("optimistic state-version conflicts leave state unchanged", () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "start");
    assert.throws(() => fixture.core.completeIntake(fixture.runId, 0, "stale-intake"), StateVersionConflictError);
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.run.state, "INTAKE");
    assert.equal(model?.run.stateVersion, 1);
  } finally {
    fixture.close();
  }
});

test("atomic command rollback removes related writes when the mutation fails", () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "start");
    fixture.core.completeIntake(fixture.runId, 1, "intake");
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: asCommandId("command_atomic"),
      idempotencyKey: "atomic-failure",
      runId: fixture.runId,
      expectedStateVersion: 2,
      kind: "transition",
      target: "READY",
      actor: "core",
      reasonCode: "test_failure",
    });
    assert.throws(() => fixture.store.executeCommand(command, ({ tx }) => {
      tx.run("INSERT INTO tasks (task_id, run_id, status, decision_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "task_atomic", fixture.runId, "ready", "{}", "now", "now");
      throw new Error("injected mutation failure");
    }), /injected mutation failure/);
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.run.state, "PLAN");
    assert.equal(model?.run.stateVersion, 2);
    assert.equal(model?.currentTask, undefined);
  } finally {
    fixture.close();
  }
});

test("terminal states cannot be transitioned or cancelled", () => {
  const fixture = createFixture();
  try {
    primeReady(fixture);
    const cancelled = fixture.core.cancel(fixture.runId, 3, "cancel", "test cancellation");
    assert.equal(cancelled.to, "CANCELLED");
    assert.equal(fixture.core.cancel(fixture.runId, 3, "cancel", "test cancellation").replayed, true);
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: asCommandId("command_terminal"),
      idempotencyKey: "terminal-transition",
      runId: fixture.runId,
      expectedStateVersion: 4,
      kind: "transition",
      target: "PLAN",
      actor: "core",
      reasonCode: "should_fail",
    });
    assert.throws(() => fixture.store.executeCommand(command, () => ({ transition: { to: "PLAN", actor: "core", reasonCode: "should_fail" } })), StateMachineError);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "CANCELLED");
  } finally {
    fixture.close();
  }
});

test("the persisted pause contract controls resume and cancellation from PAUSED is terminal", () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "start");
    fixture.core.completeIntake(fixture.runId, 1, "intake");
    const paused = fixture.core.pause(fixture.runId, 2, "pause");
    assert.equal(paused.to, "PAUSED");
    assert.equal(fixture.core.readModel(fixture.runId)?.run.pauseContract?.resumeTarget, "PLAN");
    const resumed = fixture.core.resume(fixture.runId, 3, "resume");
    assert.equal(resumed.to, "PLAN");
    assert.equal(fixture.core.resume(fixture.runId, 4, "resume").replayed, true);
    const pausedAgain = fixture.core.pause(fixture.runId, 4, "pause-again");
    assert.equal(pausedAgain.to, "PAUSED");
    const cancelled = fixture.core.cancel(fixture.runId, 5, "cancel-paused", "operator requested cancellation");
    assert.equal(cancelled.to, "CANCELLED");
  } finally {
    fixture.close();
  }
});

test("pausing EXECUTE always resumes through RECOVERY", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const paused = fixture.core.pause(fixture.runId, 4, "pause-execute");
    assert.equal(paused.to, "PAUSED");
    const contract = fixture.core.readModel(fixture.runId)?.run.pauseContract;
    assert.equal(contract?.originState, "EXECUTE");
    assert.equal(contract?.resumeTarget, "RECOVERY");
    assert.equal(contract?.durableBoundary, "uncertain_activity");
    const resumed = fixture.core.resume(fixture.runId, 5, "resume-execute");
    assert.equal(resumed.to, "RECOVERY");
  } finally {
    fixture.close();
  }
});

test("tampered persisted resume target fails closed without a transition", () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "start");
    fixture.core.completeIntake(fixture.runId, 1, "intake");
    fixture.core.pause(fixture.runId, 2, "pause");
    fixture.store.close();
    const tamper = new DatabaseSync(fixture.dbPath);
    tamper.prepare("UPDATE runs SET pause_contract_json = ? WHERE run_id = ?").run(JSON.stringify({
      schemaVersion: CONTRACT_VERSIONS.pause,
      originState: "PLAN",
      durableBoundary: "quiescent",
      resumeTarget: "RECOVERY",
    }), fixture.runId);
    tamper.close();
    assert.throws(() => StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids }), /quiescent pause/);
    const verify = new DatabaseSync(fixture.dbPath);
    try {
      assert.equal((verify.prepare("SELECT state, state_version FROM runs WHERE run_id = ?").get(fixture.runId) as { state: string; state_version: number }).state, "PAUSED");
      assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM transitions WHERE run_id = ?").get(fixture.runId) as { count: number }).count, 3);
    } finally {
      verify.close();
    }
  } finally {
    fixture.close();
  }
});

test("fake implementation failure reaches bounded REWORK", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "implementation_failure");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-failure");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete-failure");
    fixture.core.recordFocusedValidation(fixture.runId, 5, "validate-failure", validationFor(fixture, "failed"));
    const rework = fixture.core.review(fixture.runId, 6, "review-failure", { ...reviewFor(fixture, "rework", "failure"), failureClass: "implementation_failure" });
    assert.equal(rework.to, "REWORK");
    assert.equal(fixture.core.reworkToReady(fixture.runId, 7, "rework-ready").to, "READY");
  } finally {
    fixture.close();
  }
});

test("fake blocked result creates a durable human gate", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "blocked");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-blocked");
    const blocked = await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete-blocked");
    assert.equal(blocked.to, "HUMAN_GATE");
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.currentGate?.gate.options.length, 2);
    reopen(fixture);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "HUMAN_GATE");
    const resolved = fixture.core.resolveGate(fixture.runId, 5, "resolve-gate", "rework", "keep scope bounded");
    assert.equal(resolved.to, "REWORK");
  } finally {
    fixture.close();
  }
});

test("malformed fake output enters recovery instead of being accepted", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "malformed");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-malformed");
    const result = await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete-malformed");
    assert.equal(result.to, "RECOVERY");
    assert.equal(fixture.core.readModel(fixture.runId)?.activeAttempt?.lifecycle, "UNKNOWN");
  } finally {
    fixture.close();
  }
});

test("the Phase 1 adapter descriptor is explicitly simulated, not a real provider", () => {
  const fixture = createFixture();
  try {
    const descriptor = fixture.adapter.probe();
    assert.equal(descriptor.adapter, "fake");
    assert.equal(descriptor.capabilities.cancellation, "simulated");
    assert.equal(descriptor.capabilities.filesystemEnforcement, "unavailable");
  } finally {
    fixture.close();
  }
});

test("the legal transition table remains the sole transition vocabulary", () => {
  assert.ok(allLegalTransitions().length > 0);
  assert.ok(!allLegalTransitions().some(([from, to]) => from === "PAUSED" && to === "EXECUTE"));
});
