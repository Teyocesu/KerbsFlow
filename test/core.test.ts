import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSIONS,
  ExecutorResult,
  HumanGate,
  asAttemptId,
  asCommandId,
  asGateId,
  asRunId,
  asValidationId,
  parseCommand,
} from "../src/contracts.js";
import { IdempotencyConflictError, StateVersionConflictError } from "../src/errors.js";
import { KerbsFlowCore } from "../src/core.js";
import { StateStore } from "../src/persistence.js";
import { StateMachineError } from "../src/state-machine.js";
import { createFixture, executorResultFor, primeExecute, primeReady, reviewFor, validationFor, TestFixture } from "./helpers.js";

function reopen(fixture: TestFixture): void {
  fixture.store.close();
  fixture.store = StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids });
  fixture.core = new KerbsFlowCore(fixture.store, fixture.adapter, fixture.artifacts, { clock: fixture.clock, ids: fixture.ids });
}

function blockedResult(fixture: TestFixture, options: HumanGate["options"]): ExecutorResult {
  const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  return executorResultFor(fixture, {
    outcome: "blocked",
    failureClass: "security_or_privilege_gate",
    humanGate: {
      schemaVersion: CONTRACT_VERSIONS.humanGate,
      gateId: asGateId("gate_supplied"),
      runId: fixture.runId,
      taskId: fixture.taskId,
      attemptId,
      reasonCode: "security_or_privilege_gate",
      summary: "synthetic executor gate",
      evidenceRefs: [],
      options,
      status: "open",
    },
    recommendedNext: "human_gate",
  });
}

async function completeFirstAttemptForRework(fixture: TestFixture): Promise<ReturnType<typeof asAttemptId>> {
  const firstAttemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  assert.ok(firstAttemptId);
  fixture.adapter.script(fixture.taskId, "implementation_failure");
  await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-first");
  await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete-first");
  fixture.core.recordFocusedValidation(fixture.runId, 5, "validate-first", validationFor(fixture, "passed"));
  fixture.core.review(fixture.runId, 6, "review-first", { ...reviewFor(fixture, "rework", "first"), failureClass: "implementation_failure" });
  fixture.core.reworkToReady(fixture.runId, 7, "ready-second");
  fixture.core.prepareExecution(fixture.runId, 8, "prepare-second");
  fixture.adapter.script(fixture.taskId, "success");
  await fixture.core.beginFakeAttempt(fixture.runId, 9, "begin-second");
  await fixture.core.completeFakeAttempt(fixture.runId, 9, "complete-second");
  return firstAttemptId;
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

test("focused validation rejects a missing attemptId without changing state", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "success");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete");
    const { attemptId: _attemptId, ...missingAttempt } = validationFor(fixture, "passed");
    assert.throws(() => fixture.core.recordFocusedValidation(fixture.runId, 5, "missing-attempt", missingAttempt), /attempt/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "VERIFY_FOCUSED");
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 5);
    assert.equal(fixture.core.readModel(fixture.runId)?.latestValidation, undefined);
  } finally {
    fixture.close();
  }
});

test("focused validation rejects previous and unrelated attempt IDs after rework", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const firstAttemptId = await completeFirstAttemptForRework(fixture);
    const currentValidation = validationFor(fixture, "passed");
    assert.throws(() => fixture.core.recordFocusedValidation(fixture.runId, 10, "previous-attempt", { ...currentValidation, validationId: "validation_previous", attemptId: firstAttemptId }), /attempt/i);
    assert.throws(() => fixture.core.recordFocusedValidation(fixture.runId, 10, "unrelated-attempt", { ...currentValidation, validationId: "validation_unrelated", attemptId: asAttemptId("attempt_unrelated") }), /attempt/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "VERIFY_FOCUSED");
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 10);
  } finally {
    fixture.close();
  }
});

test("focused validation accepts only the current active attempt", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    fixture.adapter.script(fixture.taskId, "success");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete");
    const accepted = fixture.core.recordFocusedValidation(fixture.runId, 5, "current-attempt", validationFor(fixture, "passed"));
    assert.equal(accepted.to, "REVIEW");
    assert.equal(fixture.core.readModel(fixture.runId)?.latestValidation?.attemptId, fixture.core.readModel(fixture.runId)?.run.activeAttemptId);
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

test("executor gates reject duplicate option IDs", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const result = blockedResult(fixture, [
      { id: "same", label: "Rework", consequence: "Rework safely.", target: "REWORK" },
      { id: "same", label: "Cancel", consequence: "Cancel safely.", target: "CANCELLED" },
    ]);
    await assert.rejects(() => fixture.core.completeFakeAttempt(fixture.runId, 4, "duplicate-options", result), /option/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "EXECUTE");
  } finally {
    fixture.close();
  }
});

for (const illegalTarget of ["DONE", "EXECUTE"] as const) {
  test(`executor gates reject illegal HUMAN_GATE target ${illegalTarget}`, async () => {
    const fixture = createFixture();
    try {
      primeExecute(fixture);
      const result = blockedResult(fixture, [
        { id: "illegal", label: "Illegal", consequence: "Must be rejected.", target: illegalTarget },
        { id: "cancel", label: "Cancel", consequence: "Cancel safely.", target: "CANCELLED" },
      ]);
      await assert.rejects(() => fixture.core.completeFakeAttempt(fixture.runId, 4, `illegal-${illegalTarget}`, result), /transition|target/i);
      const model = fixture.core.readModel(fixture.runId);
      assert.equal(model?.run.state, "EXECUTE");
      assert.equal(model?.run.stateVersion, 4);
      assert.equal(model?.activeAttempt?.lifecycle, "PREPARED");
      assert.equal(model?.activeAttempt?.outcomeJson, null);
      assert.equal(model?.currentGate, undefined);
      const db = new DatabaseSync(fixture.dbPath);
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM human_gates").get() as { count: number }).count, 0);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number }).count, 0);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM transitions WHERE run_id = ?").get(fixture.runId) as { count: number }).count, 4);
      } finally {
        db.close();
      }
    } finally {
      fixture.close();
    }
  });
}

test("executor gates accept unique REWORK and CANCELLED options", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const result = blockedResult(fixture, [
      { id: "rework", label: "Rework", consequence: "Return to bounded rework.", target: "REWORK" },
      { id: "cancel", label: "Cancel", consequence: "Cancel and preserve evidence.", target: "CANCELLED" },
    ]);
    const accepted = await fixture.core.completeFakeAttempt(fixture.runId, 4, "valid-options", result);
    assert.equal(accepted.to, "HUMAN_GATE");
    assert.deepEqual(fixture.core.readModel(fixture.runId)?.currentGate?.gate.options.map((option) => option.target), ["REWORK", "CANCELLED"]);
  } finally {
    fixture.close();
  }
});

test("executor gate evidence is persisted as an untrusted claim", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const result = blockedResult(fixture, [
      { id: "rework", label: "Rework", consequence: "Return to bounded rework.", target: "REWORK" },
      { id: "cancel", label: "Cancel", consequence: "Cancel and preserve evidence.", target: "CANCELLED" },
    ]);
    assert.ok(result.humanGate);
    result.humanGate.evidence = [{
      schemaVersion: CONTRACT_VERSIONS.validation,
      id: asValidationId("validation_executor_gate_claim"),
      kind: "result",
      classification: "automatically_tested",
      summary: "executor claimed automatic proof",
    }];
    result.humanGate.recommendation = "Choose rework.";
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "normalize-gate-evidence", result);
    const stored = fixture.core.readModel(fixture.runId)?.currentGate?.gate;
    assert.equal(stored?.evidence?.[0]?.classification, "not_tested");
    assert.match(stored?.evidence?.[0]?.summary ?? "", /not independently validated/i);
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
