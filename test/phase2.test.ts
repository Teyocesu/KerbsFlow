import { VerificationSandbox } from "../src/verification-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileArtifactStore } from "../src/artifacts.js";
import { CodexAdapter } from "../src/codex.js";
import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  type ExecutorResult,
  type ExecutionRequest,
  type SemanticReviewHandle,
  type SemanticReviewRequest,
  asAttemptId,
  asRunId,
  asTaskId,
  asValidationId,
  parsePlanningDecision,
} from "../src/contracts.js";
import type { ExecutorAdapter, SemanticReviewAdapter } from "../src/adapter.js";
import { KerbsFlowCore } from "../src/core.js";
import { KerbsFlowError } from "../src/errors.js";
import { GitWorktreeManager } from "../src/git.js";
import { Phase2Loop, type Phase2LoopRequest } from "../src/phase2.js";
import { createPhase2PlanningDecision } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { ProcessSupervisor } from "../src/process.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { FocusedVerifier } from "../src/verifier.js";
import { IndependentSemanticReviewer } from "../src/reviewer.js";
import { PolicyRouter, RoutedExecutorAdapter, RoutingDiscovery } from "../src/routing.js";
import { createFakeCodex, createGitRepository, git } from "./phase2-helpers.js";
import { createFixture, primeExecute } from "./helpers.js";

test("Phase 4 planning cannot execute without a runtime-trusted routing decision", async () => {
  const fixture = integratedLoopFixture("phase4-authority-missing");
  try {
    const planningDecision = parsePlanningDecision({ ...fixture.decision, policyVersion: "kerbsflow.phase4-routing/v1" });
    const loop = new Phase2Loop(
      codexCore(fixture.store, fixture.adapter, fixture.ids),
      fixture.store,
      fixture.gitManager,
      new FocusedVerifier(fixture.gitManager, new VerificationSandbox(new ProcessSupervisor()), fixture.ids),
      fixture.ids,
    );
    await assert.rejects(loop.run({
      runId: fixture.runId,
      taskId: fixture.taskId,
      objective: "reject missing Phase 4 authority",
      repositoryPath: fixture.repository.root,
      expectedBaseOid: fixture.repository.head,
      planningDecision,
      focusedCheck: { name: "unused", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
    }), /trusted routing decision|routing authority/i);
    assert.equal(fixture.store.getRun(fixture.runId), undefined);
  } finally {
    fixture.close();
  }
});

test("the real Phase 4 loop persists distinct OpenCode and Codex escalation provenance", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-phase4-routed-loop-"));
  const ids = new SequenceIdSource("phase4_routed_loop");
  const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
  const codex = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
  const open = invariantOpenCodeAdapter();
  const gitManager = new GitWorktreeManager(join(runtime, "owned"));
  const runId = asRunId("run_phase4_routed_loop");
  const taskId = asTaskId("task_phase4_routed_loop");
  try {
    const base = createPhase2PlanningDecision({
      decisionId: "decision_phase4_routed_loop",
      runId,
      taskId,
      objective: "SCENARIO=success prove cross-adapter provenance",
      acceptance: ["the Codex fallback creates the expected result"],
      positiveScope: ["result.txt", "test/example.test.ts"],
      negativeScope: ["README.md"],
      model: "placeholder",
      canonicalContext: "phase4 routed loop",
    });
    const discovery = await new RoutingDiscovery([
      { adapter: "opencode", implementation: open },
      { adapter: "codex", implementation: codex },
    ], { now: () => "2026-09-22T12:00:00.000Z" }).discover({
      workingDirectory: repository.root,
      models: [
        { adapter: "opencode", provider: "opencode", model: "opencode/muse-fixture", family: "muse" },
        { adapter: "codex", provider: "openai", model: "fixture-model", family: "sol", reasoning: "high" },
      ],
    });
    const routed = new PolicyRouter().route({ planningDecision: base, classification: "normal", discovery });
    const loop = new Phase2Loop(
      codexCore(store, new RoutedExecutorAdapter([open, codex]), ids),
      store,
      gitManager,
      new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids),
      ids,
    );
    const result = await loop.run({
      runId,
      taskId,
      objective: "phase4 routed loop",
      repositoryPath: repository.root,
      expectedBaseOid: repository.head,
      planningDecision: routed.planningDecision,
      routingDecision: routed.routingDecision,
      focusedCheck: { name: "focused content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      phaseCheck: { level: "phase", commandId: "phase4-routed", name: "phase content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
      failurePolicy: { higherCodexRoute: { model: "fixture-model", reasoning: "high" } },
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.attempts, 2);
    const provenance = store.listAttemptRoutingProvenance(runId, taskId).map((entry) => entry.provenance);
    assert.deepEqual(provenance.map((entry) => entry.selected.adapter), ["opencode", "codex"]);
    assert.match(provenance[1]?.escalationReason ?? "", /escalat|higher|invariant/i);
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("executor start observes durable PREPARED and a spawn failure remains conservatively PREPARED", async () => {
  const fixture = createFixture();
  try {
    primeExecute(fixture);
    const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    let observedLifecycle: string | undefined;
    fixture.adapter.start = () => {
      observedLifecycle = fixture.store.getAttempt(attemptId)?.lifecycle;
      throw new Error("injected spawn failure");
    };
    await assert.rejects(() => fixture.core.beginFakeAttempt(fixture.runId, 4, "spawn-failure"), /injected spawn failure/);
    assert.equal(observedLifecycle, "PREPARED");
    assert.equal(fixture.store.getAttempt(attemptId)?.lifecycle, "PREPARED");
    assert.equal(fixture.store.getAttempt(attemptId)?.providerIdentityJson, null);
  } finally {
    fixture.close();
  }
});

test("independent verification fails the bundle when executor changed-path claims disagree with Git", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-disagreement-"));
  const ids = new SequenceIdSource("disagreement");
  try {
    const manager = new GitWorktreeManager(runtime);
    const intake = manager.intake(repository.root);
    const worktree = manager.create(intake, "run_disagreement");
    const runId = asRunId("run_disagreement");
    const taskId = asTaskId("task_disagreement");
    const attemptId = asAttemptId("attempt_disagreement");
    const decision = createPhase2PlanningDecision({
      decisionId: "decision_disagreement",
      runId,
      taskId,
      objective: "create result.txt",
      acceptance: ["result.txt is exact"],
      positiveScope: ["result.txt"],
      negativeScope: ["README.md"],
      model: "fixture-model",
      canonicalContext: "disagreement",
    });
    writeFileSync(join(worktree.path, "result.txt"), "done\n", "utf8");
    const executorResult: ExecutorResult = {
      schemaVersion: CONTRACT_VERSIONS.executorResult,
      runId,
      taskId,
      attemptId,
      executor: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model: "fixture-model" },
      outcome: "succeeded",
      failureClass: null,
      scopeClaim: "within_scope",
      summary: "incorrectly claimed no changed files",
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
    };
    const verification = await new FocusedVerifier(manager, new VerificationSandbox(new ProcessSupervisor()), ids).verify(
      intake,
      worktree,
      decision,
      executorResult,
      { name: "exact content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
    );
    assert.equal(verification.bundle.outcome, "failed");
    assert.equal(verification.executorDisagreements.length, 1);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

for (const mutation of [
  {
    name: "a forbidden worktree path",
    args: ["-e", "import {writeFileSync} from 'node:fs'; writeFileSync('README.md', 'mutated by check\\n')"],
  },
  {
    name: "an allowed implementation path",
    args: ["-e", "import {writeFileSync} from 'node:fs'; writeFileSync('result.txt', 'mutated by check\\n')"],
  },
  {
    name: "a tracked test file",
    args: ["-e", "import {rmSync} from 'node:fs'; rmSync('check.mjs')"],
  },
] as const) {
  test(`focused verification fails closed when the check mutates ${mutation.name}`, async () => {
    const fixture = verificationFixture(`check_mutation_${mutation.name.replaceAll(" ", "_")}`);
    try {
      const verification = await fixture.verifier.verify(
        fixture.intake,
        fixture.worktree,
        fixture.decision,
        fixture.executorResult,
        { name: "mutating focused check", executable: process.execPath, args: [...mutation.args], timeoutMs: 5000 },
      );
      assert.notEqual(verification.checkResult.exitCode, 0);
      assert.equal(verification.bundle.outcome, "failed");
      assert.deepEqual(verification.verifierMutations, [], "sandbox denied the write before Git evidence changed");
    } finally {
      fixture.close();
    }
  });
}

test("focused verification fails closed when the check mutates the original checkout", async () => {
  const fixture = verificationFixture("check_mutation_original");
  try {
    const originalReadme = join(fixture.repository.root, "README.md");
    const verification = await fixture.verifier.verify(
      fixture.intake,
      fixture.worktree,
      fixture.decision,
      fixture.executorResult,
      {
        name: "original checkout mutation",
        executable: process.execPath,
        args: ["-e", "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1], 'mutated by check\\n')", originalReadme],
        timeoutMs: 5000,
      },
    );
    assert.notEqual(verification.checkResult.exitCode, 0);
    assert.equal(verification.bundle.outcome, "failed");
    assert.deepEqual(verification.verifierMutations, [], "sandbox denied the original-checkout write");
  } finally {
    fixture.close();
  }
});

test("a focused command cannot be promoted by calling the phase verifier", async () => {
  const fixture = verificationFixture("focused_promotion");
  try {
    await assert.rejects(() => fixture.verifier.verifyPhase(
      fixture.intake,
      fixture.worktree,
      fixture.decision,
      fixture.executorResult,
      { name: "focused only", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 } as never,
    ), /explicit phase command identity/);
  } finally {
    fixture.close();
  }
});

test("synthetic real vertical loop writes only the owned worktree and passes independent verification", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-phase2-"));
  const ids = new SequenceIdSource("phase2");
  const store = StateStore.open(join(runtime, "state.sqlite"), { clock: new FixedClock("2026-09-21T12:00:00.000Z"), ids });
  try {
    const cliPath = createFakeCodex(runtime);
    const gitManager = new GitWorktreeManager(join(runtime, "owned"));
    const adapter = new CodexAdapter({ cliPath, runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
    const core = new KerbsFlowCore(store, adapter, new FileArtifactStore(join(runtime, "artifacts"), ids), {
      ids,
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    const runId = asRunId("run_e2e");
    const taskId = asTaskId("task_e2e");
    const decision = createPhase2PlanningDecision({
      decisionId: "decision_e2e",
      runId,
      taskId,
      objective: "SCENARIO=success create result.txt containing done",
      acceptance: ["result.txt contains exactly done followed by a newline"],
      positiveScope: ["result.txt"],
      negativeScope: ["README.md", ".git"],
      model: "fixture-model",
      reasoning: "medium",
      canonicalContext: "synthetic Phase 2 contract",
    });
    const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids);
    const result = await loop.run({
      runId,
      taskId,
      objective: "make a synthetic isolated change",
      repositoryPath: repository.root,
      expectedBaseOid: repository.head,
      planningDecision: decision,
      focusedCheck: { name: "synthetic content check", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      phaseCheck: { level: "phase", commandId: "phase-synthetic-content", name: "phase synthetic content check", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(store.readModel(runId)?.run.state, "NEXT_PHASE");
    assert.ok(store.getCanonicalSnapshot(runId));
    assert.equal(result.verification?.bundle.outcome, "passed");
    assert.deepEqual(result.verification?.verifierMutations, []);
    assert.equal(git(repository.root, ["status", "--porcelain"]), "");
    assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.head);
    assert.deepEqual(result.verification?.inspection.changedPaths, ["result.txt"]);
    assert.ok(result.worktree);
    assert.equal(store.getWorktree(runId)?.worktreePath, result.worktree.path);
    const authority = store.getPhaseValidationAuthority(result.verification!.bundle.validationId);
    assert.equal(authority?.commandId, "phase-synthetic-content");
    assert.match(authority?.commandHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(result.verification?.bundle.evidence.find((evidence) => evidence.kind === "command")?.summary ?? "", /phase-synthetic-content/);
    assert.match(store.readModel(runId)?.activeAttempt?.providerIdentityJson ?? "", /process:.*:thread:fixture-thread/);
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("unavailable verification sandbox creates a durable HUMAN_GATE without unrestricted fallback", async () => {
  const fixture = integratedLoopFixture("success");
  class UnavailableSandbox extends VerificationSandbox {
    override async run(): Promise<never> {
      throw new KerbsFlowError("VERIFICATION_SANDBOX_UNAVAILABLE", "synthetic adversarial probe failed");
    }
  }
  try {
    const result = await fixture.run({ sandbox: new UnavailableSandbox(new ProcessSupervisor()) });
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(fixture.store.readModel(fixture.runId)?.run.state, "HUMAN_GATE");
    assert.equal(fixture.store.readModel(fixture.runId)?.currentGate?.gate.reasonCode, "verification_sandbox_unavailable");
  } finally { fixture.close(); }
});

test("focused evidence alone cannot close a phase without an explicit phase command", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-missing-phase-"));
  const ids = new SequenceIdSource("missing_phase");
  const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
    const gitManager = new GitWorktreeManager(join(runtime, "owned"));
    const runId = asRunId("run_missing_phase");
    const taskId = asTaskId("task_missing_phase");
    const decision = createPhase2PlanningDecision({ decisionId: "decision_missing_phase", runId, taskId, objective: "SCENARIO=success", acceptance: ["explicit phase gate required"], positiveScope: ["result.txt"], negativeScope: ["README.md"], model: "fixture-model", canonicalContext: "missing phase" });
    const result = await new Phase2Loop(codexCore(store, adapter, ids), store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids).run({
      runId,
      taskId,
      objective: "missing phase validation",
      repositoryPath: repository.root,
      planningDecision: decision,
      focusedCheck: { name: "focused content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
    });
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(store.getRun(runId)?.state, "HUMAN_GATE");
    assert.equal(store.readModel(runId)?.currentGate?.gate.reasonCode, "phase_validation_plan_missing");
    assert.equal(store.readModel(runId)?.latestValidation?.level, "focused");
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("phase-command failure stays phase-scoped and cannot inherit focused success", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-phase-failure-"));
  const ids = new SequenceIdSource("phase_failure");
  const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
    const gitManager = new GitWorktreeManager(join(runtime, "owned"));
    const runId = asRunId("run_phase_failure");
    const taskId = asTaskId("task_phase_failure");
    const decision = createPhase2PlanningDecision({ decisionId: "decision_phase_failure", runId, taskId, objective: "SCENARIO=success", acceptance: ["phase command must pass"], positiveScope: ["result.txt"], negativeScope: ["README.md"], model: "fixture-model", canonicalContext: "phase failure" });
    const result = await new Phase2Loop(codexCore(store, adapter, ids), store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids).run({
      runId,
      taskId,
      objective: "phase command failure",
      repositoryPath: repository.root,
      planningDecision: decision,
      focusedCheck: { name: "focused content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      phaseCheck: { level: "phase", commandId: "phase-always-fails", name: "phase failure", executable: process.execPath, args: ["-e", "process.exit(7)"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
    });
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(result.attempts, 2);
    const failures = store.listFailureOccurrences(runId, taskId);
    assert.equal(failures.length, 2);
    assert.ok(failures.every((entry) => JSON.parse(entry.normalizedJson).category === "phase_verification"));
    assert.match(store.readModel(runId)?.latestValidation?.bundle.checks.find((check) => check.name.includes("phase-always-fails"))?.name ?? "", /phase-always-fails/);
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

for (const semantic of [
  { outcome: "supports_continuation", verdict: "PASS", state: "NEXT_PHASE" },
  { outcome: "rework_required", verdict: "REWORK", state: "REWORK" },
  { outcome: "evidence_insufficient", verdict: "HUMAN_GATE", state: "HUMAN_GATE" },
] as const) {
  test(`real semantic-review path maps ${semantic.outcome} to ${semantic.state}`, async () => {
    const repository = createGitRepository();
    const runtime = mkdtempSync(join(tmpdir(), `kerbsflow-semantic-${semantic.outcome}-`));
    const ids = new SequenceIdSource(`semantic_${semantic.outcome}`);
    const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
    try {
      const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
      const gitManager = new GitWorktreeManager(join(runtime, "owned"));
      const core = codexCore(store, adapter, ids);
      const runId = asRunId(`run_semantic_${semantic.outcome}`);
      const taskId = asTaskId(`task_semantic_${semantic.outcome}`);
      const decision = createPhase2PlanningDecision({
        decisionId: `decision_semantic_${semantic.outcome}`,
        runId,
        taskId,
        objective: "SCENARIO=semantic-review exercise semantic review",
        acceptance: ["result remains independently reviewable"],
        positiveScope: ["result.txt", "test/example.test.ts"],
        negativeScope: ["README.md"],
        model: "fixture-model",
        canonicalContext: `semantic-${semantic.outcome}`,
      });
      let reviewRequest: SemanticReviewRequest | undefined;
      const reviewAdapter: SemanticReviewAdapter = {
        probeReview: () => adapter.probe(),
        startReview: (request) => {
          reviewRequest = request;
          return { schemaVersion: CONTRACT_VERSIONS.semanticReviewHandle, reviewAttemptId: request.reviewAttemptId, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, providerSessionId: `review-${semantic.outcome}` };
        },
        async *reviewEvents(_handle: SemanticReviewHandle) {},
        waitReview: async (_handle) => {
          assert.ok(reviewRequest);
          return {
            schemaVersion: CONTRACT_VERSIONS.semanticReviewResult,
            reviewAttemptId: reviewRequest.reviewAttemptId,
            runId: reviewRequest.runId,
            taskId: reviewRequest.taskId,
            attemptId: reviewRequest.attemptId,
            reviewer: { adapter: "fake-review", adapterVersion: "1", provider: "synthetic", model: reviewRequest.model },
            outcome: semantic.outcome,
            summary: `synthetic ${semantic.outcome}`,
            findings: [],
            evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(`validation_review_${semantic.outcome}`), kind: "review", classification: "inspected", summary: "semantic inspection" }],
            scopeConcerns: [],
            invariantViolations: [],
          };
        },
        cancelReview: (_handle, reason) => ({ outcome: "cancelled", summary: reason }),
      };
      const reviewer = new IndependentSemanticReviewer(store, reviewAdapter, gitManager);
      const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids, reviewer);
      const result = await loop.run({
        runId,
        taskId,
        objective: `semantic ${semantic.outcome}`,
        repositoryPath: repository.root,
        planningDecision: decision,
        focusedCheck: { name: "focused content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
        phaseCheck: { level: "phase", commandId: "phase-semantic", name: "phase content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
        executionTimeoutMs: 5000,
        semanticReview: { model: "fixture-review", canonicalContract: "synthetic canonical contract" },
      });
      assert.equal(result.verdict, semantic.verdict);
      assert.equal(store.getRun(runId)?.state, semantic.state);
      const reviews = store.listSemanticReviewAttempts(runId);
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]?.lifecycle, "SUCCEEDED", reviews[0]?.failureSummary ?? "semantic reviewer did not succeed");
      const validationId = reviews[0]!.request.validationIds[0]!;
      const authority = store.getPhaseValidationAuthority(validationId);
      assert.ok(authority);
      assert.equal(reviews[0]!.request.diffHash, authority.diffHash);
      assert.equal(authority.commandId, "phase-semantic");
    } finally {
      store.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    }
  });
}

test("deterministic anti-greenwashing blockers never dispatch the semantic reviewer", async () => {
  const fixture = await integratedLoopFixture("deterministic-blocker");
  let dispatches = 0;
  const reviewAdapter: SemanticReviewAdapter = {
    probeReview: () => fixture.adapter.probe(),
    startReview: (request) => {
      dispatches += 1;
      return { schemaVersion: CONTRACT_VERSIONS.semanticReviewHandle, reviewAttemptId: request.reviewAttemptId, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, providerSessionId: "must-not-dispatch" };
    },
    async *reviewEvents(_handle) {},
    waitReview: async () => { throw new Error("must not wait"); },
    cancelReview: (_handle, reason) => ({ outcome: "cancelled", summary: reason }),
  };
  try {
    const reviewer = new IndependentSemanticReviewer(fixture.store, reviewAdapter, fixture.gitManager);
    const result = await fixture.run({ reviewer });
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(dispatches, 0);
    assert.equal(fixture.store.listSemanticReviewAttempts(fixture.runId).length, 0);
    assert.ok(result.verification?.suspiciousSignals.some((signal) => signal.blocksPass));
  } finally {
    fixture.close();
  }
});

test("semantic-review ambiguity becomes UNKNOWN and gates the real loop", async () => {
  const fixture = await integratedLoopFixture("semantic-review");
  const reviewAdapter: SemanticReviewAdapter = {
    probeReview: () => fixture.adapter.probe(),
    startReview: (request) => ({ schemaVersion: CONTRACT_VERSIONS.semanticReviewHandle, reviewAttemptId: request.reviewAttemptId, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, providerSessionId: "ambiguous-review-session" }),
    async *reviewEvents(_handle) {},
    waitReview: async () => { throw new Error("synthetic reviewer transport ambiguity"); },
    cancelReview: (_handle, reason) => ({ outcome: "cancelled", summary: reason }),
  };
  try {
    const result = await fixture.run({ reviewer: new IndependentSemanticReviewer(fixture.store, reviewAdapter, fixture.gitManager) });
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(fixture.store.getRun(fixture.runId)?.state, "HUMAN_GATE");
    const reviews = fixture.store.listSemanticReviewAttempts(fixture.runId);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.lifecycle, "UNKNOWN");
    assert.match(reviews[0]?.providerIdentityJson ?? "", /ambiguous-review-session/);
  } finally {
    fixture.close();
  }
});

test("semantic-required phase evidence cannot close when no reviewer result exists", async () => {
  const fixture = await integratedLoopFixture("semantic-review");
  try {
    const result = await fixture.run({});
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(fixture.store.getRun(fixture.runId)?.state, "HUMAN_GATE");
    assert.equal(fixture.store.listSemanticReviewAttempts(fixture.runId).length, 0);
    assert.equal(fixture.store.readModel(fixture.runId)?.latestReview?.decision.reasonCode, "semantic_review_required");
  } finally {
    fixture.close();
  }
});

test("transient execution failure performs exactly one same-route retry in one run", async () => {
  const fixture = await integratedLoopFixture("transient-failure", { transientFailureClasses: ["executor_error"] });
  try {
    const result = await fixture.run({});
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(result.attempts, 2);
    const attempts = fixture.store.listTaskAttempts(fixture.runId, fixture.taskId);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => attempt.runId === fixture.runId && attempt.taskId === fixture.taskId));
    assert.deepEqual(attempts.map((attempt) => JSON.parse(attempt.outcomeJson!).executor.model), ["fixture-model", "fixture-model"]);
    const failures = fixture.store.listFailureOccurrences(fixture.runId, fixture.taskId);
    assert.deepEqual(failures.map((failure) => failure.resultingAction), ["retry_same_route", "human_gate"]);
    assert.equal(failures[0]?.fingerprint, failures[1]?.fingerprint);
    assert.equal(fixture.store.listTransitions(fixture.runId).filter((transition) => transition.from === "IDLE" && transition.to === "INTAKE").length, 1);
  } finally {
    fixture.close();
  }
});

test("invariant failure escalates only the Codex route once, then gates at the attempt ceiling", async () => {
  const higherRoute = { model: "fixture-high", reasoning: "high" };
  const fixture = await integratedLoopFixture("invariant-failure", { higherCodexRoute: higherRoute });
  try {
    const result = await fixture.run({});
    assert.equal(result.verdict, "HUMAN_GATE");
    assert.equal(result.attempts, 2);
    const attempts = fixture.store.listTaskAttempts(fixture.runId, fixture.taskId);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => JSON.parse(attempt.outcomeJson!).executor.model), ["fixture-model", "fixture-high"]);
    const failures = fixture.store.listFailureOccurrences(fixture.runId, fixture.taskId);
    assert.deepEqual(failures.map((failure) => failure.resultingAction), ["escalate", "human_gate"]);
    assert.equal(failures[0]?.fingerprint, failures[1]?.fingerprint);
    const escalated = fixture.store.getTask(fixture.taskId)?.decision;
    assert.ok(escalated);
    assert.deepEqual({ ...escalated, route: fixture.decision.route }, fixture.decision);
    assert.deepEqual(escalated.route, { ...fixture.decision.route, ...higherRoute });
    assert.equal(fixture.store.listTransitions(fixture.runId).filter((transition) => transition.from === "IDLE" && transition.to === "INTAKE").length, 1);
  } finally {
    fixture.close();
  }
});

test("durable cancellation intent precedes signalling and dirty worktree evidence is retained", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-cancel-"));
  const ids = new SequenceIdSource("cancel");
  const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
    const gitManager = new GitWorktreeManager(join(runtime, "owned"));
    const intake = gitManager.intake(repository.root);
    const worktree = gitManager.create(intake, "run_cancel");
    const core = codexCore(store, adapter, ids);
    const runId = asRunId("run_cancel");
    const taskId = asTaskId("task_cancel");
    const decision = createPhase2PlanningDecision({
      decisionId: "decision_cancel",
      runId,
      taskId,
      objective: "SCENARIO=cancel-output keep writing until cancelled",
      acceptance: ["process stops only after durable intent"],
      positiveScope: ["partial.txt"],
      negativeScope: ["README.md"],
      model: "fixture-model",
      canonicalContext: "cancel test",
    });
    core.startRun(runId, "cancel fixture", "cancel:start");
    core.completeIntake(runId, 1, "cancel:intake");
    core.plan(runId, 2, "cancel:plan", decision);
    core.prepareExecution(runId, 3, "cancel:prepare");
    await core.beginAttempt(runId, 4, "cancel:begin", worktree.path, { prompt: "SCENARIO=cancel-output", timeoutMs: 5000 });
    await waitForFile(join(worktree.path, "partial.txt"));
    const attemptId = core.readModel(runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const requested = core.requestRealCancellation(runId, 4, "cancel:intent", "human requested stop");
    assert.equal(requested.stateVersion, 4);
    assert.equal(store.getCancellationIntent(attemptId)?.status, "REQUESTED");
    const signalled = core.signalRealCancellation(runId, 4, "cancel:signal");
    assert.equal(signalled.stateVersion, 4);
    assert.equal(store.getCancellationIntent(attemptId)?.status, "SIGNALLED");
    assert.throws(() => core.signalRealCancellation(runId, 4, "cancel:signal"), /reconcile without replaying/);
    const terminal = await core.reconcileRealCancellation(runId, 4, "cancel:reconcile");
    assert.equal(terminal.to, "CANCELLED");
    assert.equal(store.getCancellationIntent(attemptId)?.status, "CANCELLED");
    assert.equal(gitManager.inspect(worktree).dirty, true);
    assert.equal(gitManager.discover("run_cancel")?.path, worktree.path);
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

for (const intakeCase of ["tracked", "staged", "untracked", "base-mismatch"] as const) {
  test(`Phase 2 intake persists a human gate for ${intakeCase} checkout evidence without creating a worktree`, async () => {
    const repository = createGitRepository();
    const runtime = mkdtempSync(join(tmpdir(), `kerbsflow-intake-${intakeCase}-`));
    const ids = new SequenceIdSource(`intake_${intakeCase}`);
    const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
    try {
      if (intakeCase === "tracked" || intakeCase === "staged") {
        writeFileSync(join(repository.root, "README.md"), `${intakeCase} mutation\n`, "utf8");
        if (intakeCase === "staged") {
          git(repository.root, ["add", "README.md"]);
        }
      } else if (intakeCase === "untracked") {
        writeFileSync(join(repository.root, "untracked.txt"), "untracked mutation\n", "utf8");
      }
      const statusBefore = git(repository.root, ["status", "--porcelain"]);
      const readmeBefore = readFileSync(join(repository.root, "README.md"), "utf8");
      const cliPath = createFakeCodex(runtime);
      const adapter = new CodexAdapter({ cliPath, runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
      const gitManager = new GitWorktreeManager(join(runtime, "owned"));
      const core = codexCore(store, adapter, ids);
      const suffix = intakeCase.replaceAll("-", "_");
      const runId = asRunId(`run_intake_${suffix}`);
      const taskId = asTaskId(`task_intake_${suffix}`);
      const decision = createPhase2PlanningDecision({
        decisionId: `decision_intake_${suffix}`,
        runId,
        taskId,
        objective: "intake must stop before execution",
        acceptance: ["checkout ambiguity is durably gated"],
        positiveScope: ["result.txt"],
        negativeScope: ["README.md"],
        model: "fixture-model",
        canonicalContext: "intake gate fixture",
      });
      const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids);
      const result = await loop.run({
        runId,
        taskId,
        objective: "intake ambiguity fixture",
        repositoryPath: repository.root,
        expectedBaseOid: intakeCase === "base-mismatch" ? "0".repeat(40) : repository.head,
        planningDecision: decision,
        focusedCheck: { name: "must not execute", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
        executionTimeoutMs: 5000,
      });
      assert.equal(result.verdict, "HUMAN_GATE");
      assert.equal(result.worktree, undefined);
      assert.equal(store.getWorktree(runId), undefined);
      const model = store.readModel(runId);
      assert.equal(model?.run.state, "HUMAN_GATE");
      assert.equal(model?.currentGate?.gate.status, "open");
      assert.equal(model?.currentGate?.gate.reasonCode, intakeCase === "base-mismatch" ? "BASE_OID_MISMATCH" : "ORIGINAL_CHECKOUT_DIRTY");
      assert.deepEqual(model?.currentGate?.gate.options.map((option) => option.target), ["CANCELLED", "FAILED"]);
      assert.equal(git(repository.root, ["status", "--porcelain"]), statusBefore);
      assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.head);
      assert.equal(readFileSync(join(repository.root, "README.md"), "utf8"), readmeBefore);
    } finally {
      store.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    }
  });
}

for (const expected of [
  { scenario: "failure", state: "HUMAN_GATE", verdict: "HUMAN_GATE" },
  { scenario: "architecture-ambiguity", state: "HUMAN_GATE", verdict: "HUMAN_GATE" },
  { scenario: "scope-violation", state: "HUMAN_GATE", verdict: "HUMAN_GATE" },
  { scenario: "gate", state: "HUMAN_GATE", verdict: "HUMAN_GATE" },
  { scenario: "malformed-result", state: "RECOVERY", verdict: "RECOVERY" },
] as const) {
  test(`synthetic ${expected.scenario} reaches ${expected.state} without trusting process exit alone`, async () => {
    const repository = createGitRepository();
    const runtime = mkdtempSync(join(tmpdir(), `kerbsflow-${expected.scenario}-`));
    const ids = new SequenceIdSource(expected.scenario);
    const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
    try {
      const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
      const gitManager = new GitWorktreeManager(join(runtime, "owned"));
      const core = codexCore(store, adapter, ids);
      const runId = asRunId(`run_${expected.scenario.replaceAll("-", "_")}`);
      const taskId = asTaskId(`task_${expected.scenario.replaceAll("-", "_")}`);
      const decision = createPhase2PlanningDecision({
        decisionId: `decision_${expected.scenario.replaceAll("-", "_")}`,
        runId,
        taskId,
        objective: `SCENARIO=${expected.scenario} exercise the ${expected.state} path`,
        acceptance: ["the expected conservative state is persisted"],
        positiveScope: ["result.txt"],
        negativeScope: ["README.md"],
        model: "fixture-model",
        canonicalContext: expected.scenario,
      });
      const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new VerificationSandbox(new ProcessSupervisor()), ids), ids);
      const result = await loop.run({
        runId,
        taskId,
        objective: expected.scenario,
        repositoryPath: repository.root,
        planningDecision: decision,
        focusedCheck: { name: "synthetic content check", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
        executionTimeoutMs: 5000,
      });
      assert.equal(result.verdict, expected.verdict);
      assert.equal(store.readModel(runId)?.run.state, expected.state);
      if (expected.scenario === "failure") {
        assert.equal(result.attempts, 2);
        assert.equal(store.countTaskAttempts(runId, taskId), 2);
      }
      if (expected.scenario === "failure" || expected.scenario === "architecture-ambiguity" || expected.scenario === "scope-violation") {
        assert.equal(store.listFailureOccurrences(runId, taskId).length, expected.scenario === "failure" ? 2 : 1);
      }
      assert.equal(git(repository.root, ["status", "--porcelain"]), "");
    } finally {
      store.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    }
  });
}

test("restart preserves real process identity, prevents duplicate dispatch, and accepts durable cancellation proof", async () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-restart-"));
  const ids = new SequenceIdSource("restart");
  const dbPath = join(runtime, "state.sqlite");
  let store = StateStore.open(dbPath, { ids });
  const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
  try {
    const gitManager = new GitWorktreeManager(join(runtime, "owned"));
    const intake = gitManager.intake(repository.root);
    const worktree = gitManager.create(intake, "run_restart");
    let core = codexCore(store, adapter, ids);
    const runId = asRunId("run_restart");
    const taskId = asTaskId("task_restart");
    const decision = createPhase2PlanningDecision({
      decisionId: "decision_restart",
      runId,
      taskId,
      objective: "SCENARIO=cancel-output remain active across restart",
      acceptance: ["restart never redispatches the attempt"],
      positiveScope: ["partial.txt"],
      negativeScope: ["README.md"],
      model: "fixture-model",
      canonicalContext: "restart test",
    });
    core.startRun(runId, "restart fixture", "restart:start");
    core.completeIntake(runId, 1, "restart:intake");
    core.plan(runId, 2, "restart:plan", decision);
    core.prepareExecution(runId, 3, "restart:prepare");
    await core.beginAttempt(runId, 4, "restart:begin", worktree.path, { prompt: "SCENARIO=cancel-output", timeoutMs: 5000 });
    const before = core.readModel(runId)?.activeAttempt;
    assert.ok(before);
    assert.ok(before.providerIdentityJson?.includes("process:"));
    const attemptId = before.attemptId;
    store.close();
    store = StateStore.open(dbPath, { ids });
    core = codexCore(store, adapter, ids);
    assert.equal(core.readModel(runId)?.run.state, "RECOVERY");
    assert.equal(core.readModel(runId)?.activeAttempt?.attemptId, attemptId);
    await assert.rejects(() => core.beginAttempt(runId, 5, "restart:duplicate", worktree.path), /requires EXECUTE|PREPARED|RUNNING/);
    adapter.cancel({ schemaVersion: CONTRACT_VERSIONS.attemptHandle, runId, taskId, attemptId }, "fixture cleanup");
    await adapter.processEvidence(attemptId);
    const recoveryAdapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
    core = codexCore(store, recoveryAdapter, ids);
    core.requestRealCancellation(runId, 5, "restart:cancel-intent", "reconcile missing process after restart");
    core.signalRealCancellation(runId, 5, "restart:cancel-signal");
    const cancelled = await core.reconcileRealCancellation(runId, 5, "restart:cancel-reconcile");
    assert.equal(cancelled.to, "CANCELLED");
    assert.equal(cancelled.stateVersion, 6);
    assert.equal(store.getCancellationIntent(attemptId)?.status, "CANCELLED");
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

function codexCore(store: StateStore, adapter: ExecutorAdapter, ids: SequenceIdSource): KerbsFlowCore {
  return new KerbsFlowCore(store, adapter, new FileArtifactStore(join(adapterRuntimeRoot(store), "artifacts"), ids), {
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["codex", "opencode"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    },
  });
}

function invariantOpenCodeAdapter(): ExecutorAdapter {
  const requests = new Map<string, ExecutionRequest>();
  return {
    probe: () => ({
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "opencode",
      provider: "provider-selected",
      adapterVersion: "fixture",
      capabilities: {
        eventTransport: "async_iterable", finalJsonSchema: false, modelSelection: true, reasoningEffort: [], agentSelection: true,
        filesystemEnforcement: "tool_policy_only", network: { providerControlPlane: "provider_owned", workload: "tool_policy_only" },
        cancellation: "native", resumableSession: true, authentication: { owner: "provider", mode: "provider-owned" }, healthProbe: true,
      },
    }),
    routingReadiness: async () => ({ ready: true, models: [{ provider: "opencode", model: "opencode/muse-fixture", aliases: ["muse-fixture"], reasoning: [] }], reason: "synthetic Muse is ready" }),
    start: (request) => {
      requests.set(request.attemptId, request);
      return { schemaVersion: CONTRACT_VERSIONS.attemptHandle, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, providerSessionId: `synthetic:${request.attemptId}` };
    },
    events: async function* () { /* no provider events are needed for this bounded fixture */ },
    wait: async (handle) => {
      const request = requests.get(handle.attemptId);
      if (request === undefined) throw new Error("missing synthetic OpenCode request");
      return {
        schemaVersion: CONTRACT_VERSIONS.executorResult,
        runId: request.runId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        executor: { adapter: "opencode", adapterVersion: "fixture", provider: "opencode", model: "opencode/muse-fixture" },
        outcome: "failed",
        failureClass: "invariant_violation",
        scopeClaim: "within_scope",
        summary: "synthetic OpenCode invariant failure",
        filesChanged: [], checks: [], evidence: [], invariantViolations: ["synthetic invariant failure"], risks: [], warnings: [], artifacts: [], humanGate: null,
        recommendedNext: "rework",
        exit: { kind: "normal", code: 1 },
      } satisfies ExecutorResult;
    },
    cancel: () => ({ outcome: "unknown", summary: "not used" }),
    reconcile: async () => ({ outcome: "not_found", summary: "not used" }),
  };
}

function adapterRuntimeRoot(store: StateStore): string {
  return dirname(store.databasePath);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`fixture did not create ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function integratedLoopFixture(scenario: string, failurePolicy?: Phase2LoopRequest["failurePolicy"]) {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), `kerbsflow-integrated-${scenario}-`));
  const ids = new SequenceIdSource(`integrated_${scenario}`);
  const store = StateStore.open(join(runtime, "state.sqlite"), { ids });
  const adapter = new CodexAdapter({ cliPath: createFakeCodex(runtime), runtimeRoot: runtime, environment: { PATH: process.env.PATH, HOME: runtime } });
  const gitManager = new GitWorktreeManager(join(runtime, "owned"));
  const runId = asRunId(`run_integrated_${scenario.replaceAll("-", "_")}`);
  const taskId = asTaskId(`task_integrated_${scenario.replaceAll("-", "_")}`);
  const decision = createPhase2PlanningDecision({
    decisionId: `decision_integrated_${scenario.replaceAll("-", "_")}`,
    runId,
    taskId,
    objective: `SCENARIO=${scenario} exercise the integrated Phase 3 path`,
    acceptance: ["the bounded policy outcome is durably persisted"],
    positiveScope: ["result.txt", "test/example.test.ts"],
    negativeScope: ["README.md"],
    model: "fixture-model",
    reasoning: "medium",
    canonicalContext: `integrated-${scenario}`,
  });
  return {
    repository,
    runtime,
    ids,
    store,
    adapter,
    gitManager,
    runId,
    taskId,
    decision,
    run: ({ reviewer, sandbox }: { reviewer?: IndependentSemanticReviewer; sandbox?: VerificationSandbox }) => new Phase2Loop(
      codexCore(store, adapter, ids),
      store,
      gitManager,
      new FocusedVerifier(gitManager, sandbox ?? new VerificationSandbox(new ProcessSupervisor()), ids),
      ids,
      reviewer,
    ).run({
      runId,
      taskId,
      objective: `integrated ${scenario}`,
      repositoryPath: repository.root,
      expectedBaseOid: repository.head,
      planningDecision: decision,
      focusedCheck: { name: "focused content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      phaseCheck: { level: "phase", commandId: `phase-${scenario}`, name: "phase content", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
      ...(failurePolicy === undefined ? {} : { failurePolicy }),
      semanticReview: { model: "fixture-review", canonicalContract: "synthetic canonical contract" },
    }),
    close() {
      store.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    },
  };
}

function verificationFixture(suffix: string): {
  repository: ReturnType<typeof createGitRepository>;
  runtime: string;
  intake: ReturnType<GitWorktreeManager["intake"]>;
  worktree: ReturnType<GitWorktreeManager["create"]>;
  decision: ReturnType<typeof createPhase2PlanningDecision>;
  executorResult: ExecutorResult;
  verifier: FocusedVerifier;
  close: () => void;
} {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-verifier-mutation-"));
  const ids = new SequenceIdSource(suffix);
  const manager = new GitWorktreeManager(runtime);
  const intake = manager.intake(repository.root);
  const worktree = manager.create(intake, `run_${suffix}`);
  const runId = asRunId(`run_${suffix}`);
  const taskId = asTaskId(`task_${suffix}`);
  const attemptId = asAttemptId(`attempt_${suffix}`);
  writeFileSync(join(worktree.path, "result.txt"), "done\n", "utf8");
  const decision = createPhase2PlanningDecision({
    decisionId: `decision_${suffix}`,
    runId,
    taskId,
    objective: "create result.txt",
    acceptance: ["result.txt contains done"],
    positiveScope: ["result.txt"],
    negativeScope: ["README.md", "check.mjs"],
    model: "fixture-model",
    canonicalContext: "focused verifier mutation fixture",
  });
  const executorResult: ExecutorResult = {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId,
    taskId,
    attemptId,
    executor: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model: "fixture-model" },
    outcome: "succeeded",
    failureClass: null,
    scopeClaim: "within_scope",
    summary: "synthetic executor change",
    filesChanged: [{ path: "result.txt", change: "added" }],
    checks: [],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "verify_focused",
    exit: { kind: "normal", code: 0 },
  };
  return {
    repository,
    runtime,
    intake,
    worktree,
    decision,
    executorResult,
    verifier: new FocusedVerifier(manager, new VerificationSandbox(new ProcessSupervisor()), ids),
    close: () => {
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    },
  };
}
