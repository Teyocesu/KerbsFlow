import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSIONS,
  asCommandId,
  parseCommand,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { StateStore } from "../src/persistence.js";
import { createFixture, primeExecute, TestFixture, validationFor } from "./helpers.js";

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

test("terminal fake result and validation boundaries are recoverable without duplicate dispatch", () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const markTerminal = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: asCommandId("command_terminal_result"),
      idempotencyKey: "terminal-result-boundary",
      runId: fixture.runId,
      expectedStateVersion: 4,
      kind: "complete_attempt",
      payload: { attemptId, result: { schemaVersion: "kerbsflow.executor-result/v1", outcome: "succeeded" } },
    });
    fixture.store.executeCommand(markTerminal, ({ tx, now }) => {
      tx.run("UPDATE attempts SET lifecycle = ?, outcome_json = ?, ended_at = ?, updated_at = ? WHERE attempt_id = ?", "SUCCEEDED", "{\"synthetic\":true}", now, now, attemptId);
      return { details: { persisted: true } };
    });
    reopen(fixture);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "RECOVERY");
    const focused = fixture.core.recover(fixture.runId, 5, "recover-terminal", recoveryDecision(fixture.runId, "VERIFY_FOCUSED"));
    assert.equal(focused.to, "VERIFY_FOCUSED");

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
