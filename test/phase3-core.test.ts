import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTRACT_VERSIONS,
  asArtifactId,
  asGateId,
  asReviewId,
  asValidationId,
  type ValidationBundle,
} from "../src/contracts.js";
import { FailurePolicyCoordinator } from "../src/phase3.js";
import { hashCanonicalDocuments } from "../src/canonical.js";
import { StateStore } from "../src/persistence.js";
import { createFixture, primeExecute, reviewFor, validationFor } from "./helpers.js";

test("trusted phase-close path requires current phase evidence and reaches NEXT_PHASE", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    const repositoryPath = recordCanonicalFixture(fixture, "a".repeat(40));
    const input = {
      validation: phaseBundle(fixture),
      diff: "",
      changedPaths: [] as string[],
    };
    const closed = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:close", input);
    assert.equal(closed.to, "NEXT_PHASE");
    assert.equal(fixture.core.readModel(fixture.runId)?.latestValidation?.level, "phase");
    assert.equal(fixture.core.readModel(fixture.runId)?.latestReview?.decision.reasonCode, "trusted_phase_close");
    writeFileSync(join(repositoryPath, "docs/HANDOFF.md"), "changed after the accepted command\n", "utf8");
    const replay = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:close", input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.to, "NEXT_PHASE");
  } finally {
    fixture.close();
  }
});

test("lower validation and canonical drift cannot close a phase", async () => {
  const lower = createFixture();
  try {
    await reachVerifyPhase(lower);
    recordCanonicalFixture(lower, "b".repeat(40));
    const rework = lower.core.completeTrustedPhaseValidation(lower.runId, 7, "phase3:lower", {
      validation: { ...phaseBundle(lower), validationId: asValidationId("validation_lower"), level: "focused" },
      diff: "",
      changedPaths: [],
    });
    assert.equal(rework.to, "REWORK");
  } finally {
    lower.close();
  }

  const drift = createFixture();
  try {
    await reachVerifyPhase(drift);
    const repositoryPath = recordCanonicalFixture(drift, "c".repeat(40));
    writeFileSync(join(repositoryPath, "docs/HANDOFF.md"), "unexpected drift\n", "utf8");
    const gated = drift.core.completeTrustedPhaseValidation(drift.runId, 7, "phase3:drift", {
      validation: phaseBundle(drift),
      diff: "",
      changedPaths: [],
    });
    assert.equal(gated.to, "HUMAN_GATE");
    const gate = drift.core.readModel(drift.runId)?.currentGate;
    assert.ok(gate);
    assert.equal(gate.gate.reasonCode, "canonical_intent_drift");
    assert.equal(gate.gate.evidence?.[0]?.classification, "automatically_tested");

    assert.throws(() => drift.core.resolveGateScoped(drift.runId, 8, "wrong-gate", asGateId("gate_wrong"), "fail"), /scope/i);
    assert.throws(() => drift.core.resolveGateScoped(drift.runId, 8, "bad-option", gate.gateId, "missing"), /option/i);
    const resolved = drift.core.resolveGateScoped(drift.runId, 8, "resolve", gate.gateId, "fail", "operator reviewed drift");
    assert.equal(resolved.to, "FAILED");
    const replay = drift.core.resolveGateScoped(drift.runId, 8, "resolve", gate.gateId, "fail", "operator reviewed drift");
    assert.equal(replay.replayed, true);
    assert.throws(() => drift.core.resolveGateScoped(drift.runId, 8, "stale-resolution", gate.gateId, "fail"), /open|state|gate/i);
    drift.store.close();
    drift.store = StateStore.open(drift.dbPath, { clock: drift.clock, ids: drift.ids });
    assert.equal(drift.store.getRun(drift.runId)?.state, "FAILED");
    assert.equal(drift.store.getGate(gate.gateId)?.status, "resolved");
  } finally {
    drift.close();
  }
});

test("failure fingerprints, occurrences, route, and one escalation reason persist", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const coordinator = new FailurePolicyCoordinator(fixture.store, 2);
    const base = {
      runId: fixture.runId,
      taskId: fixture.taskId,
      attemptId,
      failureClass: "implementation_failure" as const,
      transient: false,
      causalDiagnosis: true,
      scopeUnchanged: true,
      eligibleHigherRoute: true,
      fingerprintInput: { failureClass: "implementation_failure" as const, reasonCode: "same-cause", diagnostic: "attempt_1 failed in /tmp/a.ts:10", category: "implementation" },
      route: { adapter: "codex", model: "low", reasoning: "medium" },
    };
    const first = coordinator.recordAndDecide(base);
    const duplicate = coordinator.recordAndDecide({ ...base, fingerprintInput: { ...base.fingerprintInput, diagnostic: "attempt_9 failed in /tmp/z.ts:77" } });
    assert.equal(first.occurrence, 1);
    assert.equal(first.resultingAction, "rework");
    assert.equal(duplicate.occurrence, 1, "the same attempt/fingerprint is ingested once");

    const escalated = coordinator.recordAndDecide({
      ...base,
      failureClass: "invariant_violation",
      fingerprintInput: { failureClass: "invariant_violation", reasonCode: "filesystem-boundary", diagnostic: "forbidden write", category: "filesystem" },
    });
    assert.equal(escalated.resultingAction, "escalate");
    assert.equal(escalated.escalationReason, "invariant_violation_escalation");

    fixture.adapter.script(fixture.taskId, "implementation_failure");
    await fixture.core.beginFakeAttempt(fixture.runId, 4, "failure:begin");
    await fixture.core.completeFakeAttempt(fixture.runId, 4, "failure:complete");
    fixture.core.recordFocusedValidation(fixture.runId, 5, "failure:validate", validationFor(fixture, "failed"));
    fixture.core.review(fixture.runId, 6, "failure:review", { ...reviewFor(fixture, "rework", "failure"), failureClass: "implementation_failure" });
    fixture.core.reworkToReady(fixture.runId, 7, "failure:ready");
    fixture.core.prepareExecution(fixture.runId, 8, "failure:prepare-second");
    const secondAttemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(secondAttemptId);
    const second = coordinator.recordAndDecide({ ...base, attemptId: secondAttemptId, fingerprintInput: { ...base.fingerprintInput, diagnostic: "attempt_2 failed in /tmp/b.ts:99" } });
    assert.equal(second.occurrence, 2);
    assert.equal(second.resultingAction, "human_gate");
    assert.equal(fixture.store.listFailureOccurrences(fixture.runId, fixture.taskId).length, 3);
  } finally {
    fixture.close();
  }
});

test("trusted phase close applies the anti-greenwashing detector before PASS", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    recordCanonicalFixture(fixture, "d".repeat(40));
    const result = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:greenwashing", {
      validation: phaseBundle(fixture),
      diff: "diff --git a/test/example.test.ts b/test/example.test.ts\n--- a/test/example.test.ts\n+++ b/test/example.test.ts\n@@ -1,1 +1,1 @@\n-test('works', fn);\n+test.skip('works', fn);\n",
      changedPaths: ["test/example.test.ts"],
    });
    assert.equal(result.to, "REWORK");
    assert.match(fixture.core.readModel(fixture.runId)?.latestReview?.decision.reasonCode ?? "", /anti_greenwashing_test_skip/);
  } finally {
    fixture.close();
  }
});

test("trusted phase close rejects an unpersisted model-review claim", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    recordCanonicalFixture(fixture, "e".repeat(40));
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    assert.throws(() => fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:forged-review", {
      validation: phaseBundle(fixture),
      diff: "diff --git a/test/example.test.ts b/test/example.test.ts\n--- a/test/example.test.ts\n+++ b/test/example.test.ts\n@@ -1,1 +1,0 @@\n-assert.equal(value, true);\n",
      changedPaths: ["test/example.test.ts"],
      semanticReview: {
        schemaVersion: CONTRACT_VERSIONS.semanticReviewResult,
        reviewAttemptId: asReviewId("review_forged"),
        runId: fixture.runId,
        taskId: fixture.taskId,
        attemptId,
        reviewer: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model: "reviewer" },
        outcome: "supports_continuation",
        summary: "unpersisted claim",
        findings: [],
        evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_forged_review"), kind: "review", classification: "inspected", summary: "model opinion" }],
        scopeConcerns: [],
        invariantViolations: [],
      },
    }), /persisted terminal semantic review/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "VERIFY_PHASE");
  } finally {
    fixture.close();
  }
});

test("trusted phase close can consume the exact persisted independent review result", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    recordCanonicalFixture(fixture, "f".repeat(40));
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const reviewAttemptId = asReviewId("review_persisted");
    const reviewedDiff = "diff --git a/test/example.test.ts b/test/example.test.ts\n--- a/test/example.test.ts\n+++ b/test/example.test.ts\n@@ -1,2 +1,1 @@\n-assert.equal(value, true);\n assert.ok(value);\n";
    fixture.store.prepareSemanticReview({
      schemaVersion: CONTRACT_VERSIONS.semanticReviewRequest,
      reviewAttemptId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      attemptId,
      role: "review",
      workingDirectory: "/synthetic/worktree",
      promptSummary: "inspect the assertion removal without changing files",
      model: "review-model",
      permissionPolicy: { filesystem: "read_only", network: "denied" },
      canonicalContextHash: fixture.decision.canonicalContextHash,
      diffHash: createHash("sha256").update(reviewedDiff).digest("hex"),
      validationIds: [phaseBundle(fixture).validationId],
      expectedResultSchema: CONTRACT_VERSIONS.semanticReviewResult,
    });
    fixture.store.markSemanticReviewRunning(reviewAttemptId, { providerSessionId: "fresh-review-session" });
    const semanticReview = {
      schemaVersion: CONTRACT_VERSIONS.semanticReviewResult,
      reviewAttemptId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      attemptId,
      reviewer: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model: "review-model" },
      outcome: "supports_continuation",
      summary: "the changed assertion was redundant and phase evidence remains sufficient",
      findings: [],
      evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_persisted_review"), kind: "review", classification: "inspected", summary: "independent semantic inspection" }],
      scopeConcerns: [],
      invariantViolations: [],
    } as const;
    fixture.store.completeSemanticReview(reviewAttemptId, semanticReview);

    assert.throws(() => fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:stale-review", {
      validation: phaseBundle(fixture),
      diff: `${reviewedDiff}\n`,
      changedPaths: ["test/example.test.ts"],
      semanticReview,
    }), /stale|does not match/i);

    const closed = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:persisted-review", {
      validation: phaseBundle(fixture),
      diff: reviewedDiff,
      changedPaths: ["test/example.test.ts"],
      semanticReview,
    });
    assert.equal(closed.to, "NEXT_PHASE");
    assert.deepEqual(fixture.core.readModel(fixture.runId)?.latestReview?.decision.evidence?.map((entry) => entry.classification), ["automatically_tested", "inspected"]);
  } finally {
    fixture.close();
  }
});

async function reachVerifyPhase(fixture: ReturnType<typeof createFixture>): Promise<void> {
  primeExecute(fixture);
  fixture.adapter.script(fixture.taskId, "success");
  await fixture.core.beginFakeAttempt(fixture.runId, 4, "phase3:begin");
  await fixture.core.completeFakeAttempt(fixture.runId, 4, "phase3:complete");
  fixture.core.recordFocusedValidation(fixture.runId, 5, "phase3:focused", validationFor(fixture, "passed"));
  fixture.core.review(fixture.runId, 6, "phase3:review", reviewFor(fixture, "verify_phase", "phase3"));
}

function phaseBundle(fixture: ReturnType<typeof createFixture>): ValidationBundle {
  const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  const artifact = asArtifactId("artifact_phase_evidence");
  return {
    schemaVersion: CONTRACT_VERSIONS.validation,
    validationId: asValidationId("validation_phase_close"),
    runId: fixture.runId,
    taskId: fixture.taskId,
    attemptId,
    level: "phase",
    outcome: "passed",
    summary: "independent phase gate passed",
    checks: [{ name: "phase gate", outcome: "passed", evidenceClass: "automatically_tested", evidenceRefs: [artifact] }],
    evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_phase_command"), kind: "command", classification: "automatically_tested", summary: "phase command ran", artifactRef: artifact }],
  };
}

function recordCanonicalFixture(fixture: ReturnType<typeof createFixture>, baseOid: string): string {
  const repositoryPath = join(fixture.root, "canonical-repository");
  mkdirSync(join(repositoryPath, "docs"), { recursive: true });
  writeFileSync(join(repositoryPath, "AGENTS.md"), "synthetic agent policy\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/SPEC-v0.1.0.md"), "synthetic frozen spec\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/PLAN-v0.1.0.md"), "synthetic plan\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/HANDOFF.md"), "synthetic handoff\n", "utf8");
  fixture.store.recordCanonicalSnapshot({ runId: fixture.runId, repositoryPath, baseOid, hashes: hashCanonicalDocuments(repositoryPath) });
  return repositoryPath;
}
