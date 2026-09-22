import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTRACT_VERSIONS,
  asGateId,
  asReviewId,
  asValidationId,
  parseExecutorResult,
} from "../src/contracts.js";
import { FailurePolicyCoordinator } from "../src/phase3.js";
import { StateStore } from "../src/persistence.js";
import { GitWorktreeManager } from "../src/git.js";
import { FocusedVerifier } from "../src/verifier.js";
import { ProcessSupervisor } from "../src/process.js";
import { CanonicalIntentGuard } from "../src/canonical.js";
import { createFixture, primeExecute, reviewFor, validationFor } from "./helpers.js";

test("trusted phase-close path requires current phase evidence and reaches NEXT_PHASE", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    const authority = await recordAuthoritativePhase(fixture);
    const input = { validationId: authority.validationId };
    const closed = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:close", input);
    assert.equal(closed.to, "NEXT_PHASE");
    assert.equal(fixture.core.readModel(fixture.runId)?.latestValidation?.level, "phase");
    assert.equal(fixture.core.readModel(fixture.runId)?.latestReview?.decision.reasonCode, "trusted_phase_close");
    const replay = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:close", input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.to, "NEXT_PHASE");
  } finally {
    fixture.close();
  }
});

test("caller-created phase records cannot acquire verifier authority", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    const focused = fixture.core.readModel(fixture.runId)?.latestValidation?.bundle;
    assert.ok(focused);
    assert.throws(() => fixture.store.recordAuthoritativePhaseValidation({
      bundle: { ...focused, validationId: asValidationId("validation_fabricated"), level: "phase", outcome: "passed" },
      binding: { worktreePath: "/fabricated", worktreeGitDirectory: "/fabricated/.git", baseOid: "0".repeat(40), diffHash: "0".repeat(64), changedPathsHash: "0".repeat(64), changedPaths: [] },
    } as never), /independent phase verifier/i);
  } finally {
    fixture.close();
  }
});

test("trusted phase close rejects stale worktree diff after authoritative validation", async () => {
  const fixture = createFixture();
  try {
    await reachVerifyPhase(fixture);
    const authority = await recordAuthoritativePhase(fixture);
    mkdirSync(join(authority.worktreePath, "src"), { recursive: true });
    writeFileSync(join(authority.worktreePath, "src/stale.ts"), "export const stale = true;\n", "utf8");
    assert.throws(() => fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:stale-diff", {
      validationId: authority.validationId,
    }), /stale|changed/i);
    assert.equal(fixture.core.readModel(fixture.runId)?.run.state, "VERIFY_PHASE");
  } finally {
    fixture.close();
  }
});

test("lower validation and canonical drift cannot close a phase", async () => {
  const lower = createFixture();
  try {
    await reachVerifyPhase(lower);
    assert.throws(() => lower.core.completeTrustedPhaseValidation(lower.runId, 7, "phase3:lower", {
      validationId: asValidationId("validation_unpersisted"),
    }), /previously persisted authoritative/i);
  } finally {
    lower.close();
  }

  const drift = createFixture();
  try {
    await reachVerifyPhase(drift);
    const authority = await recordAuthoritativePhase(drift);
    const repositoryPath = authority.repository.root;
    writeFileSync(join(repositoryPath, "docs/HANDOFF.md"), "unexpected drift\n", "utf8");
    const gated = drift.core.completeTrustedPhaseValidation(drift.runId, 7, "phase3:drift", {
      validationId: authority.validationId,
    });
    assert.equal(gated.to, "HUMAN_GATE");
    const gate = drift.core.readModel(drift.runId)?.currentGate;
    assert.ok(gate);
    assert.equal(gate.gate.reasonCode, "canonical_intent_drift");
    assert.ok(gate.gate.evidence?.some((entry) => entry.classification === "automatically_tested"));

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
    const authority = await recordAuthoritativePhase(fixture, (path) => {
      mkdirSync(join(path, "src"), { recursive: true });
      writeFileSync(join(path, "src/example.test.ts"), "test.skip('works', fn);\n", "utf8");
    });
    const result = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:greenwashing", {
      validationId: authority.validationId,
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
    const authority = await recordAuthoritativePhase(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    assert.throws(() => fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:forged-review", {
      validationId: authority.validationId,
      semanticReviewId: asReviewId("review_forged"),
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
    const authority = await recordAuthoritativePhase(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const reviewAttemptId = asReviewId("review_persisted");
    const reviewedDiff = authority.inspection.diff;
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
      validationIds: [authority.validationId],
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

    const closed = fixture.core.completeTrustedPhaseValidation(fixture.runId, 7, "phase3:persisted-review", {
      validationId: authority.validationId,
      semanticReviewId: reviewAttemptId,
    });
    assert.equal(closed.to, "NEXT_PHASE");
    const classifications = fixture.core.readModel(fixture.runId)?.latestReview?.decision.evidence?.map((entry) => entry.classification) ?? [];
    assert.ok(classifications.includes("automatically_tested"));
    assert.ok(classifications.includes("inspected"));
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

async function recordAuthoritativePhase(
  fixture: ReturnType<typeof createFixture>,
  mutate?: (worktreePath: string) => void,
): Promise<{ validationId: ReturnType<typeof asValidationId>; inspection: ReturnType<GitWorktreeManager["inspect"]>; repository: { root: string }; worktreePath: string }> {
  const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  const repositoryPath = join(fixture.root, "canonical-repository");
  mkdirSync(join(repositoryPath, "docs"), { recursive: true });
  mkdirSync(join(repositoryPath, "src"), { recursive: true });
  writeFileSync(join(repositoryPath, "AGENTS.md"), "synthetic agent policy\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/SPEC-v0.1.0.md"), "synthetic frozen spec\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/PLAN-v0.1.0.md"), "synthetic plan\n", "utf8");
  writeFileSync(join(repositoryPath, "docs/HANDOFF.md"), "synthetic handoff\n", "utf8");
  writeFileSync(join(repositoryPath, "README.md"), "synthetic\n", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: repositoryPath });
  execFileSync("git", ["config", "user.name", "KerbsFlow Test"], { cwd: repositoryPath });
  execFileSync("git", ["config", "user.email", "kerbsflow@example.invalid"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repositoryPath });
  const manager = new GitWorktreeManager(join(fixture.root, "owned"));
  const intake = manager.intake(repositoryPath);
  const worktree = manager.create(intake, fixture.runId);
  fixture.store.recordWorktree({
    runId: fixture.runId,
    repositoryPath: worktree.repositoryPath,
    gitCommonDirectory: worktree.gitCommonDirectory,
    worktreeGitDirectory: worktree.worktreeGitDirectory,
    baseOid: worktree.baseOid,
    branch: worktree.branch,
    worktreePath: worktree.path,
    markerPath: worktree.markerPath,
    createdAt: worktree.createdAt,
  });
  new CanonicalIntentGuard(fixture.store).capture(fixture.runId, repositoryPath, intake.baseOid);
  mutate?.(worktree.path);
  const result = parseExecutorResult(JSON.parse(fixture.store.getAttempt(attemptId)!.outcomeJson!));
  const phase = await new FocusedVerifier(manager, new ProcessSupervisor(), fixture.ids).verifyPhase(
    intake,
    worktree,
    fixture.decision,
    result,
    { name: "phase gate", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5000 },
  );
  fixture.store.recordAuthoritativePhaseValidation(phase.authoritative);
  return { validationId: phase.authoritative.bundle.validationId, inspection: phase.verification.inspection, repository: { root: repositoryPath }, worktreePath: worktree.path };
}
