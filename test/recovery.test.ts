import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSIONS,
  AttemptLifecycle,
  asAttemptId,
  asCommandId,
  asRunId,
  asTaskId,
  parseCommand,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { StateStore } from "../src/persistence.js";
import { createFixture, executorResultFor, primeExecute, TestFixture, validationFor } from "./helpers.js";

function reopen(fixture: TestFixture): void {
  fixture.store.close();
  fixture.store = StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids });
  fixture.core = new KerbsFlowCore(fixture.store, fixture.adapter, fixture.artifacts, { clock: fixture.clock, ids: fixture.ids });
}

function recoveryDecision(runId: string, target: "HUMAN_GATE" | "FAILED" | "VERIFY_FOCUSED" | "REVIEW") {
  return {
    schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
    runId,
    target,
    summary: `recover to ${target}`,
    evidenceRefs: [],
  };
}

function stageTerminalRecovery(fixture: TestFixture, lifecycle: AttemptLifecycle, outcomeJson: string): void {
  const model = fixture.core.readModel(fixture.runId);
  const attemptId = model?.run.activeAttemptId;
  assert.ok(attemptId);
  assert.ok(model);
  const markTerminal = parseCommand({
    schemaVersion: CONTRACT_VERSIONS.command,
    commandId: asCommandId(`command_terminal_${lifecycle.toLowerCase()}`),
    idempotencyKey: `terminal-${lifecycle.toLowerCase()}`,
    runId: fixture.runId,
    expectedStateVersion: model.run.stateVersion,
    kind: "complete_attempt",
    payload: { attemptId, result: { persisted: true } },
  });
  fixture.store.executeCommand(markTerminal, ({ tx, now }) => {
    tx.run("UPDATE attempts SET lifecycle = ?, outcome_json = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", lifecycle, outcomeJson, now, now, attemptId);
    return { details: { persisted: true } };
  });
  reopen(fixture);
  assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
}

test("startup detects PREPARED attempts and moves EXECUTE to RECOVERY", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    reopen(fixture);
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.run.state, "RECOVERY");
    assert.equal(model?.run.stateVersion, 5);
    assert.equal(model?.activeAttempt?.lifecycle, "PREPARED");
    assert.equal(fixture.store.startupRecovery[0]?.automaticTransition, true);
    const gated = fixture.core.recover(fixture.runId, 5, "recover-prepared", recoveryDecision(fixture.runId, "HUMAN_GATE"));
    assert.equal(gated.to, "HUMAN_GATE");
  } finally {
    fixture.close();
  }
});

test("startup detects RUNNING attempts without replaying them", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-running");
    reopen(fixture);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
    assert.equal(fixture.core.readModel(fixture.runId)?.activeAttempt?.lifecycle, "RUNNING");
    const failed = fixture.core.recover(fixture.runId, 5, "recover-running", recoveryDecision(fixture.runId, "FAILED"));
    assert.equal(failed.to, "FAILED");
  } finally {
    fixture.close();
  }
});

test("a valid persisted ExecutorResult may recover to VERIFY_FOCUSED", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    stageTerminalRecovery(fixture, "SUCCEEDED", JSON.stringify(executorResultFor(fixture)));
    const focused = fixture.core.recover(fixture.runId, 5, "recover-terminal", recoveryDecision(fixture.runId, "VERIFY_FOCUSED"));
    assert.equal(focused.to, "VERIFY_FOCUSED");
  } finally {
    fixture.close();
  }
});

const invalidPersistedOutcomes: Array<{ name: string; lifecycle: AttemptLifecycle; make(fixture: TestFixture): string }> = [
  { name: "malformed JSON", lifecycle: "SUCCEEDED", make: () => "{not-json" },
  { name: "syntactically valid wrong contract", lifecycle: "SUCCEEDED", make: () => JSON.stringify({ synthetic: true }) },
  { name: "unknown schema version", lifecycle: "SUCCEEDED", make: (fixture) => JSON.stringify({ ...executorResultFor(fixture), schemaVersion: "kerbsflow.executor-result/v2" }) },
  { name: "mismatched run ID", lifecycle: "SUCCEEDED", make: (fixture) => JSON.stringify(executorResultFor(fixture, { runId: asRunId("run_other") })) },
  { name: "mismatched task ID", lifecycle: "SUCCEEDED", make: (fixture) => JSON.stringify(executorResultFor(fixture, { taskId: asTaskId("task_other") })) },
  { name: "mismatched attempt ID", lifecycle: "SUCCEEDED", make: (fixture) => JSON.stringify(executorResultFor(fixture, { attemptId: asAttemptId("attempt_other") })) },
  { name: "lifecycle/result contradiction", lifecycle: "FAILED", make: (fixture) => JSON.stringify(executorResultFor(fixture)) },
];

for (const invalid of invalidPersistedOutcomes) {
  test(`VERIFY_FOCUSED recovery rejects ${invalid.name} without changing state`, () => {
    const fixture = createFixture();
    try {
      primeExecute(fixture);
      stageTerminalRecovery(fixture, invalid.lifecycle, invalid.make(fixture));
      assert.throws(() => fixture.core.recover(fixture.runId, 5, `reject-${invalid.name}`, recoveryDecision(fixture.runId, "VERIFY_FOCUSED")), /persisted|recovery|result|contract|JSON/i);
      assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
      assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 5);
    } finally {
      fixture.close();
    }
  });
}

test("REVIEW recovery rejects passed validation from a previous attempt", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const firstAttempt = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(firstAttempt);
    fixture.adapter.script(fixture.taskId, "implementation_failure");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "begin-first");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "complete-first");
    fixture.core.recordFocusedValidation(fixture.runId, 5, "validate-first", validationFor(fixture, "passed"));
    fixture.core.review(fixture.runId, 6, "review-first", {
      schemaVersion: CONTRACT_VERSIONS.reviewDecision,
      reviewId: "review_first",
      runId: fixture.runId,
      taskId: fixture.taskId,
      outcome: "rework",
      failureClass: "implementation_failure",
      summary: "prepare a second attempt",
      evidenceRefs: [],
      reasonCode: "rework_first",
    });
    fixture.core.reworkToReady(fixture.runId, 7, "ready-second");
    fixture.core.prepareExecution(fixture.runId, 8, "prepare-second");
    const secondAttempt = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(secondAttempt);
    assert.notEqual(secondAttempt, firstAttempt);
    stageTerminalRecovery(fixture, "SUCCEEDED", JSON.stringify(executorResultFor(fixture)));
    assert.throws(() => fixture.core.recover(fixture.runId, 10, "recover-old-validation", recoveryDecision(fixture.runId, "REVIEW")), /validation/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
  } finally {
    fixture.close();
  }
});

test("current-attempt validation boundary is recoverable without duplicate dispatch", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    stageTerminalRecovery(fixture, "SUCCEEDED", JSON.stringify(executorResultFor(fixture)));
    fixture.core.recover(fixture.runId, 5, "recover-terminal", recoveryDecision(fixture.runId, "VERIFY_FOCUSED"));

    const validation = validationFor(fixture, "passed");
    const validationCommand = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: asCommandId("command_validation_boundary"),
      idempotencyKey: "validation-boundary",
      runId: fixture.runId,
      expectedStateVersion: 6,
      kind: "validation",
      payload: { bundle: validation },
    });
    fixture.store.executeCommand(validationCommand, ({ tx, now }) => {
      tx.run("INSERT INTO validations (validation_id, run_id, task_id, attempt_id, level, outcome, bundle_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", validation.validationId, fixture.runId, fixture.taskId, attemptId, validation.level, validation.outcome, JSON.stringify(validation), now);
      return { details: { persisted: true } };
    });
    reopen(fixture);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
    const reviewed = fixture.core.recover(fixture.runId, 7, "recover-validation", recoveryDecision(fixture.runId, "REVIEW"));
    assert.equal(reviewed.to, "REVIEW");
  } finally {
    fixture.close();
  }
});
