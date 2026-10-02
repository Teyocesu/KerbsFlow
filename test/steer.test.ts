import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  asDecisionId,
  type InstructionId,
} from "../src/contracts.js";
import { KerbsFlowError } from "../src/errors.js";
import { KerbsFlowCore } from "../src/core.js";
import { StateStore } from "../src/persistence.js";
import { createFixture, primeReady, reviewFor, authoritativeFocusedFor } from "./helpers.js";

test("steer persists one pending instruction, survives restart, and is consumed exactly once", async () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "steer:start");
    fixture.core.completeIntake(fixture.runId, 1, "steer:intake");
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 2);

    assert.throws(() => fixture.core.steer(fixture.runId, 2, "steer:empty", ""), /non-empty/i);
    assert.throws(() => fixture.core.steer(fixture.runId, 2, "steer:oversized", "x".repeat(4097)), /4096/i);
    assert.throws(
      () => fixture.core.steer(fixture.runId, 2, "steer:secret", "AWS_SECRET_ACCESS_KEY=synthetic-credential-value"),
      /sensitive credential material/i,
    );
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId), undefined);

    const first = fixture.core.steer(fixture.runId, 2, "steer:first", "focus on synthetic cache boundary");
    const instructionId = (first.details as { instructionId: string }).instructionId;
    assert.match(instructionId, /^instruction_/);
    assert.equal(first.replayed, false);
    assert.equal(first.to, "PLAN");
    assert.equal(first.stateVersion, 2);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "PLAN");

    const replay = fixture.core.steer(fixture.runId, 2, "steer:first", "focus on synthetic cache boundary");
    assert.equal(replay.replayed, true);
    assert.equal((replay.details as { instructionId: string }).instructionId, instructionId);

    assert.throws(
      () => fixture.core.steer(fixture.runId, 2, "steer:second", "a distinct pending instruction"),
      /already has a pending steer/i,
    );

    const schema = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const table = schema.prepare("SELECT sql FROM sqlite_master WHERE name = 'steer_instructions'").get() as { sql: string };
      assert.match(table.sql, /length\(CAST\(text AS BLOB\)\)/i);
      assert.match(table.sql, /consumed_at IS NULL AND planning_command_id IS NULL/);
      const index = schema.prepare("SELECT sql FROM sqlite_master WHERE name = 'steer_one_pending_per_run_idx'").get() as { sql: string };
      assert.match(index.sql, /WHERE consumed_at IS NULL/);
    } finally {
      schema.close();
    }

    fixture.store.close();
    fixture.store = StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids });
    fixture.core = new KerbsFlowCore(fixture.store, fixture.adapter, fixture.artifacts, { clock: fixture.clock, ids: fixture.ids });
    const survived = fixture.store.getPendingSteerInstruction(fixture.runId);
    assert.equal(survived?.instructionId, instructionId);
    assert.equal(survived?.text, "focus on synthetic cache boundary");

    const planned = fixture.core.plan(fixture.runId, 2, "steer:plan", fixture.decision, {
      instructionId,
      text: "focus on synthetic cache boundary",
    });
    assert.equal(planned.to, "READY");
    const consumed = fixture.store.getSteerInstruction(instructionId as unknown as InstructionId);
    assert.ok(consumed?.consumedAt);
    assert.ok(consumed?.planningCommandId);
    assert.equal(consumed?.planningDecisionId, fixture.decision.decisionId);
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId), undefined);
  } finally {
    fixture.close();
  }
});

test("stale observation and rejected planning leave the pending steer without transition", () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "stale:start");
    fixture.core.completeIntake(fixture.runId, 1, "stale:intake");

    const observedNoneBeforeSteer: { instructionId: null; text: null } = { instructionId: null, text: null };
    const steered = fixture.core.steer(fixture.runId, 2, "stale:steer", "steer arrived while planning was in flight");
    const arrivedId = (steered.details as { instructionId: string }).instructionId;

    assert.throws(
      () => fixture.core.plan(fixture.runId, 2, "stale:plan-none", fixture.decision, observedNoneBeforeSteer),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "PLANNING_STEER_STALE",
    );
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "PLAN");
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, 2);
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId)?.instructionId, arrivedId);

    assert.throws(
      () => fixture.core.plan(fixture.runId, 2, "stale:plan-wrong-id", fixture.decision, { instructionId: "instruction_wrong", text: "focus" }),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "PLANNING_STEER_STALE",
    );
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId)?.instructionId, arrivedId);

    const badRoute = { ...fixture.decision, route: { adapter: "unknown-adapter", model: "unknown" } };
    assert.throws(
      () => fixture.core.plan(fixture.runId, 2, "stale:plan-bad-route", badRoute, { instructionId: arrivedId, text: "steer arrived while planning was in flight" }),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "ROUTE_NOT_ALLOWED",
    );
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "PLAN");
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId)?.instructionId, arrivedId);

    const accepted = fixture.core.plan(fixture.runId, 2, "stale:plan-good", fixture.decision, {
      instructionId: arrivedId,
      text: "steer arrived while planning was in flight",
    });
    assert.equal(accepted.to, "READY");
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId), undefined);
  } finally {
    fixture.close();
  }
});

test("rework observes pending steer and rejects broadened or weakened protection", async () => {
  const fixture = createFixture();
  try {
    fixture.decision = {
      ...fixture.decision,
      action: { ...fixture.decision.action, validationLevel: "phase" },
    };
    primeReady(fixture);
    fixture.core.prepareExecution(fixture.runId, 3, "rework:prepare");
    fixture.adapter.script(fixture.taskId, "success");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "rework:begin");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "rework:complete");
    fixture.core.recordFocusedValidation(fixture.runId, 5, "rework:validate", await authoritativeFocusedFor(fixture, "passed"));
    fixture.core.review(fixture.runId, 6, "rework:review", { ...reviewFor(fixture, "rework", "rework-steer"), failureClass: "implementation_failure" });
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "REWORK");

    const steered = fixture.core.steer(fixture.runId, 7, "rework:steer", "narrow the synthetic cache fix");
    const steerId = (steered.details as { instructionId: string }).instructionId;
    const observation = { instructionId: steerId, text: "narrow the synthetic cache fix" };
    const prior = fixture.store.getTask(fixture.taskId)!.decision;

    const broadened = {
      ...prior,
      decisionId: asDecisionId("decision_rework_broadened"),
      action: { ...prior.action, kind: "rework" as const, positiveScope: [...prior.action.positiveScope, "unapproved-synthetic-scope"] },
    };
    assert.throws(
      () => fixture.core.reworkToReady(fixture.runId, 7, "rework:broadened", broadened, observation),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "REWORK_SCOPE_BROADENED",
    );

    const weakened = {
      ...prior,
      decisionId: asDecisionId("decision_rework_weakened"),
      action: { ...prior.action, kind: "rework" as const, validationLevel: "focused" as const },
    };
    assert.throws(
      () => fixture.core.reworkToReady(fixture.runId, 7, "rework:weakened", weakened, observation),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "REWORK_VALIDATION_WEAKENED",
    );

    const reskilled = { ...prior, decisionId: asDecisionId("decision_rework_reskilled"), action: { ...prior.action, kind: "rework" as const }, selectedSkills: ["invented-skill"] };
    assert.throws(
      () => fixture.core.reworkToReady(fixture.runId, 7, "rework:reskilled", reskilled, observation),
      (error: unknown) => error instanceof KerbsFlowError && error.code === "REWORK_SKILLS_CHANGED",
    );

    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "REWORK");
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId)?.instructionId, steerId);

    const narrowedScope = prior.action.positiveScope.slice(0, 1);
    const corrected = {
      ...prior,
      decisionId: asDecisionId("decision_rework_corrected"),
      action: { ...prior.action, kind: "rework" as const, summary: "bounded synthetic rework correction", positiveScope: narrowedScope },
    };
    const ready = fixture.core.reworkToReady(fixture.runId, 7, "rework:corrected", corrected, observation);
    assert.equal(ready.to, "READY");
    const evidence = fixture.store.getSteerInstruction(steerId as `instruction_${string}` as never);
    assert.ok(evidence?.consumedAt);
    assert.equal(evidence?.planningDecisionId, asDecisionId("decision_rework_corrected"));
    assert.equal(fixture.store.getPendingSteerInstruction(fixture.runId), undefined);
    assert.equal(fixture.store.getTask(fixture.taskId)?.decision.action.kind, "rework");
  } finally {
    fixture.close();
  }
});

test("steer rejects terminal runs without incrementing state", async () => {
  const fixture = createFixture();
  try {
    fixture.core.startRun(fixture.runId, "synthetic objective", "terminal:start");
    fixture.core.completeIntake(fixture.runId, 1, "terminal:intake");
    fixture.core.plan(fixture.runId, 2, "terminal:plan", fixture.decision);
    fixture.core.prepareExecution(fixture.runId, 3, "terminal:prepare");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "terminal:begin");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "terminal:complete");
    fixture.core.recordFocusedValidation(fixture.runId, 5, "terminal:validate", await authoritativeFocusedFor(fixture, "passed"));
    fixture.core.review(fixture.runId, 6, "terminal:review", reviewFor(fixture, "failed", "terminal"));
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "FAILED");
    const version = fixture.core.readModel(fixture.runId)!.run.stateVersion;
    assert.throws(() => fixture.core.steer(fixture.runId, version, "terminal:steer", "late instruction"), /terminal/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.stateVersion, version);
  } finally {
    fixture.close();
  }
});
