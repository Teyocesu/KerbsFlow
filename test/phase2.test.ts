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
  asAttemptId,
  asRunId,
  asTaskId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { GitWorktreeManager } from "../src/git.js";
import { Phase2Loop } from "../src/phase2.js";
import { createPhase2PlanningDecision } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { ProcessSupervisor } from "../src/process.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { FocusedVerifier } from "../src/verifier.js";
import { createFakeCodex, createGitRepository, git } from "./phase2-helpers.js";
import { createFixture, primeExecute } from "./helpers.js";

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
    const verification = await new FocusedVerifier(manager, new ProcessSupervisor(), ids).verify(
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
      assert.equal(verification.checkResult.exitCode, 0);
      assert.equal(verification.bundle.outcome, "failed");
      assert.deepEqual(verification.verifierMutations, ["focused check mutated managed worktree source evidence"]);
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
    assert.equal(verification.checkResult.exitCode, 0);
    assert.equal(verification.bundle.outcome, "failed");
    assert.deepEqual(verification.verifierMutations, ["focused check mutated the original human-owned checkout"]);
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
    const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new ProcessSupervisor(), ids), ids);
    const result = await loop.run({
      runId,
      taskId,
      objective: "make a synthetic isolated change",
      repositoryPath: repository.root,
      expectedBaseOid: repository.head,
      planningDecision: decision,
      focusedCheck: { name: "synthetic content check", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5000 },
      executionTimeoutMs: 5000,
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(store.readModel(runId)?.run.state, "VERIFY_PHASE");
    assert.equal(result.verification?.bundle.outcome, "passed");
    assert.deepEqual(result.verification?.verifierMutations, []);
    assert.equal(git(repository.root, ["status", "--porcelain"]), "");
    assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.head);
    assert.deepEqual(result.verification?.inspection.changedPaths, ["result.txt"]);
    assert.ok(result.worktree);
    assert.equal(store.getWorktree(runId)?.worktreePath, result.worktree.path);
    assert.match(store.readModel(runId)?.activeAttempt?.providerIdentityJson ?? "", /process:.*:thread:fixture-thread/);
  } finally {
    store.close();
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
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
      const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new ProcessSupervisor(), ids), ids);
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
  { scenario: "failure", state: "REWORK", verdict: "REWORK" },
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
      const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new ProcessSupervisor(), ids), ids);
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

function codexCore(store: StateStore, adapter: CodexAdapter, ids: SequenceIdSource): KerbsFlowCore {
  return new KerbsFlowCore(store, adapter, new FileArtifactStore(join(adapterRuntimeRoot(store), "artifacts"), ids), {
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    },
  });
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
    verifier: new FocusedVerifier(manager, new ProcessSupervisor(), ids),
    close: () => {
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    },
  };
}
