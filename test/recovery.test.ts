import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSIONS,
  AttemptLifecycle,
  ExecutorResult,
  asAttemptId,
  asCommandId,
  asGateId,
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

function recoveryDecision(runId: string, target: "HUMAN_GATE" | "FAILED" | "VERIFY_FOCUSED" | "REVIEW" | "CANCELLED") {
  return {
    schemaVersion: CONTRACT_VERSIONS.recoveryDecision,
    runId,
    target,
    summary: `recover to ${target}`,
    evidenceRefs: [],
  };
}

function executorResultForOutcome(fixture: TestFixture, outcome: ExecutorResult["outcome"]): ExecutorResult {
  switch (outcome) {
    case "succeeded":
      return executorResultFor(fixture);
    case "failed":
    case "partial":
      return executorResultFor(fixture, {
        outcome,
        failureClass: "implementation_failure",
        recommendedNext: "rework",
        checks: [{ name: "synthetic check", outcome: "failed", evidenceClass: "simulated", evidenceRefs: [] }],
      });
    case "cancelled":
      return executorResultFor(fixture, {
        outcome,
        failureClass: "cancelled",
        recommendedNext: "fail",
        checks: [{ name: "synthetic check", outcome: "failed", evidenceClass: "simulated", evidenceRefs: [] }],
        exit: { kind: "signal" },
      });
    case "blocked": {
      const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
      assert.ok(attemptId);
      return executorResultFor(fixture, {
        outcome,
        failureClass: "security_or_privilege_gate",
        recommendedNext: "human_gate",
        humanGate: {
          schemaVersion: CONTRACT_VERSIONS.humanGate,
          gateId: asGateId("gate_recovery"),
          runId: fixture.runId,
          taskId: fixture.taskId,
          attemptId,
          reasonCode: "security_or_privilege_gate",
          summary: "synthetic blocked recovery result",
          evidenceRefs: [],
          options: [
            { id: "rework", label: "Rework", consequence: "Return to bounded rework.", target: "REWORK" },
            { id: "cancel", label: "Cancel", consequence: "Cancel and preserve evidence.", target: "CANCELLED" },
          ],
          status: "open",
        },
      });
    }
  }
}

function persistenceCounts(fixture: TestFixture): Record<string, number> {
  const db = new DatabaseSync(fixture.dbPath);
  try {
    const count = (table: "commands" | "transitions" | "validations" | "reviews" | "human_gates"): number =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      commands: count("commands"),
      transitions: count("transitions"),
      validations: count("validations"),
      reviews: count("reviews"),
      gates: count("human_gates"),
    };
  } finally {
    db.close();
  }
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

const focusedRecoveryOutcomes: Array<{ outcome: "succeeded" | "failed" | "partial"; lifecycle: AttemptLifecycle }> = [
  { outcome: "succeeded", lifecycle: "SUCCEEDED" },
  { outcome: "failed", lifecycle: "FAILED" },
  { outcome: "partial", lifecycle: "PARTIAL" },
];

for (const recoverable of focusedRecoveryOutcomes) {
  test(`a valid persisted ${recoverable.outcome} result may recover to VERIFY_FOCUSED`, () => {
    const fixture = createFixture();
    try {
      primeExecute(fixture);
      stageTerminalRecovery(fixture, recoverable.lifecycle, JSON.stringify(executorResultForOutcome(fixture, recoverable.outcome)));
      const focused = fixture.core.recover(fixture.runId, 5, `recover-${recoverable.outcome}`, recoveryDecision(fixture.runId, "VERIFY_FOCUSED"));
      assert.equal(focused.to, "VERIFY_FOCUSED");
    } finally {
      fixture.close();
    }
  });
}

const nonVerifiableRecoveryOutcomes: Array<{ outcome: "blocked" | "cancelled"; lifecycle: AttemptLifecycle }> = [
  { outcome: "blocked", lifecycle: "BLOCKED" },
  { outcome: "cancelled", lifecycle: "CANCELLED" },
];

for (const nonVerifiable of nonVerifiableRecoveryOutcomes) {
  test(`a valid persisted ${nonVerifiable.outcome} result cannot recover to VERIFY_FOCUSED`, () => {
    const fixture = createFixture();
    try {
      primeExecute(fixture);
      const outcomeJson = JSON.stringify(executorResultForOutcome(fixture, nonVerifiable.outcome));
      stageTerminalRecovery(fixture, nonVerifiable.lifecycle, outcomeJson);
      const before = persistenceCounts(fixture);

      assert.throws(
        () => fixture.core.recover(fixture.runId, 5, `reject-${nonVerifiable.outcome}`, recoveryDecision(fixture.runId, "VERIFY_FOCUSED")),
        /outcome|VERIFY_FOCUSED|recovery/i,
      );

      const model = fixture.core.readModel(fixture.runId);
      assert.equal(model?.run.state, "RECOVERY");
      assert.equal(model?.run.stateVersion, 5);
      assert.equal(model?.activeAttempt?.lifecycle, nonVerifiable.lifecycle);
      assert.equal(model?.activeAttempt?.outcomeJson, outcomeJson);
      assert.equal(model?.latestValidation, undefined);
      assert.equal(model?.latestReview, undefined);
      assert.deepEqual(persistenceCounts(fixture), before);
    } finally {
      fixture.close();
    }
  });
}

test("a valid persisted cancelled result may recover to terminal CANCELLED", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    stageTerminalRecovery(fixture, "CANCELLED", JSON.stringify(executorResultForOutcome(fixture, "cancelled")));
    const cancelled = fixture.core.recover(fixture.runId, 5, "recover-cancelled", recoveryDecision(fixture.runId, "CANCELLED"));
    assert.equal(cancelled.to, "CANCELLED");
    const model = fixture.core.readModel(fixture.runId);
    assert.equal(model?.run.state, "CANCELLED");
    assert.equal(model?.run.stateVersion, 6);
    assert.equal(model?.activeAttempt?.lifecycle, "CANCELLED");
    assert.equal(model?.latestValidation, undefined);
    assert.equal(model?.latestReview, undefined);
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
