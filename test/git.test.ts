import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { KerbsFlowError } from "../src/errors.js";
import { GitWorktreeManager, gitEnvironment, type WorktreeRecord } from "../src/git.js";
import { createGitRepository, git } from "./phase2-helpers.js";
import { StateStore, type WorktreeCleanupAuthority } from "../src/persistence.js";
import { CONTRACT_VERSIONS, asCommandId, asRunId, parseCommand } from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { FakeAdapter, FakeArtifactStore } from "../src/fake.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

test("Git subprocess environment excludes credential and repository override variables", () => {
  assert.deepEqual(gitEnvironment({
    PATH: "/bin",
    HOME: "/synthetic/home",
    GIT_CONFIG_GLOBAL: "/synthetic/override",
    GIT_ASKPASS: "synthetic-secret",
    GITHUB_TOKEN: "synthetic-secret",
    AWS_SECRET_ACCESS_KEY: "synthetic-secret",
  }), { PATH: "/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_PAGER: "cat" });
});

test("owned Git worktree checkout never executes a post-checkout hook", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-hook-runtime-"));
  const sentinelRoot = mkdtempSync(join(tmpdir(), "kerbsflow-hook-sentinel-"));
  try {
    const sentinel = join(sentinelRoot, "executed");
    const hook = join(repository.root, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\n`);
    chmodSync(hook, 0o700);
    const manager = new GitWorktreeManager(runtime);
    const worktree = manager.create(manager.intake(repository.root), "hook_probe");
    assert.equal(existsSync(sentinel), false);
    assert.equal(manager.inspect(worktree).dirty, false);
  } finally {
    rmSync(sentinelRoot, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("repository filters and executable Git configuration gate before any sentinel side effect", () => {
  for (const key of ["filter.synthetic.smudge", "filter.synthetic.process", "core.fsmonitor", "diff.synthetic.command", "merge.synthetic.driver"]) {
    const repository = createGitRepository();
    const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-config-runtime-"));
    const sentinelRoot = mkdtempSync(join(tmpdir(), "kerbsflow-config-sentinel-"));
    try {
      const sentinel = join(sentinelRoot, "executed");
      git(repository.root, ["config", "--local", key, `touch '${sentinel}'`]);
      const manager = new GitWorktreeManager(runtime);
      assert.throws(() => manager.intake(repository.root), (error: unknown) => error instanceof KerbsFlowError && error.code === "GIT_EXECUTABLE_CONFIG_GATE", key);
      assert.equal(existsSync(sentinel), false, key);
    } finally {
      rmSync(sentinelRoot, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    }
  }
});

test("tracked checkout filter attributes gate even when the driver is not locally configured", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-attributes-runtime-"));
  try {
    writeFileSync(join(repository.root, ".gitattributes"), "*.txt filter=required-tool\n");
    git(repository.root, ["add", ".gitattributes"]);
    git(repository.root, ["commit", "--quiet", "-m", "synthetic filter attribute"]);
    const manager = new GitWorktreeManager(runtime);
    assert.throws(() => manager.intake(repository.root), (error: unknown) => error instanceof KerbsFlowError && error.code === "GIT_CHECKOUT_FILTER_GATE");
    assert.equal(git(repository.root, ["worktree", "list", "--porcelain"]).includes(join(runtime, "worktrees")), false);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("repository intake captures the exact clean base and rejects ambiguous original state", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const intake = manager.intake(repository.root, { expectedBaseOid: repository.head });
    assert.equal(intake.baseOid, repository.head);
    assert.equal(intake.status.length, 0);
    assert.equal(intake.repositoryPath, realpathSync(repository.root));

    writeFileSync(join(repository.root, "untracked.txt"), "user work\n", "utf8");
    assert.throws(() => manager.intake(repository.root), (error: unknown) => error instanceof KerbsFlowError && error.code === "ORIGINAL_CHECKOUT_DIRTY");
    assert.doesNotThrow(() => manager.intake(repository.root, { allowUntracked: true }));
    assert.throws(() => manager.intake(repository.root, { expectedBaseOid: "0".repeat(40), allowUntracked: true }), /expected/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("owned worktree uses the recorded base, detects collisions, and retains dirty evidence", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const intake = manager.intake(repository.root);
    const worktree = manager.create(intake, "run_owned");
    assert.equal(git(worktree.path, ["rev-parse", "HEAD"]), repository.head);
    assert.match(worktree.branch, /^kerbsflow\/run-/);
    assert.match(git(repository.root, ["worktree", "list", "--porcelain"]), /locked kerbsflow run run_owned/);
    assert.equal(manager.discover("run_owned")?.path, worktree.path);
    assert.throws(() => manager.create(intake, "run_owned"), /already exists/);

    writeFileSync(join(worktree.path, "result.txt"), "isolated\n", "utf8");
    const inspection = manager.inspect(worktree);
    assert.equal(inspection.dirty, true);
    assert.deepEqual(inspection.changedPaths, ["result.txt"]);
    assert.match(inspection.diff, /\+isolated/);
    assert.equal(git(repository.root, ["status", "--porcelain"]), "");
    assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.head);
    assert.equal(manager.discover("run_owned")?.path, worktree.path, "dirty worktree remains discoverable and retained");

    git(worktree.path, ["mv", "README.md", "renamed.md"]);
    assert.deepEqual(manager.inspect(worktree).changedPaths, ["README.md", "renamed.md", "result.txt"], "rename inspection retains the removed source path");
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("runtime root inside the human-owned repository is rejected", () => {
  const repository = createGitRepository();
  try {
    const manager = new GitWorktreeManager(join(repository.root, ".runtime"));
    assert.throws(() => manager.intake(repository.root), /outside the human-owned repository/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("failed worktree creation leaves a durable uncertainty marker instead of replaying", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const intake = manager.intake(repository.root);
    assert.throws(() => manager.create({ ...intake, baseOid: "0".repeat(40) }, "run_uncertain"), /git worktree failed/);
    assert.throws(() => manager.discover("run_uncertain"), (error: unknown) => error instanceof KerbsFlowError && error.code === "WORKTREE_CREATION_UNCERTAIN");
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("worktree creation rejects branch and unknown path collisions", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const intake = manager.intake(repository.root);
    git(repository.root, ["branch", "kerbsflow/run-run_branch"]);
    assert.throws(() => manager.create(intake, "run_branch"), /branch.*already exists/i);
    mkdirSync(join(runtime, "worktrees", "run_unknown"), { recursive: true });
    assert.throws(() => manager.create(intake, "run_unknown"), /already exists/i);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("clean terminal worktree cleanup is durable, idempotent, and never removes the original checkout", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const worktree = manager.create(manager.intake(repository.root), "run_cleanup");
    assert.equal(manager.prepareCleanup(worktree, cleanupAuthorityFor(worktree, runtime)).outcome, "cleanup_prepared");
    assert.throws(() => manager.discover("run_cleanup"), /cleanup.*reconciled/i);
    assert.equal(manager.reconcileCleanup("run_cleanup").outcome, "cleaned");
    assert.equal(manager.reconcileCleanup("run_cleanup").outcome, "cleaned");
    assert.equal(existsSync(worktree.path), false);
    assert.equal(manager.discover("run_cleanup"), undefined);
    assert.equal(existsSync(join(repository.root, "README.md")), true);
    assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.head);
    const markerPath = join(runtime, "worktree-records", "run_cleanup.json");
    const complete = JSON.parse(readFileSync(markerPath, "utf8")) as { record: Record<string, unknown> };
    complete.record.runKey = "run_other";
    writeFileSync(markerPath, JSON.stringify(complete), "utf8");
    assert.throws(() => manager.reconcileCleanup("run_cleanup"), /requested run identity/i);
    assert.throws(() => manager.discover("run_cleanup"), /requested run identity/i);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("dirty and non-clean terminal worktrees are retained without force removal", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const dirty = manager.create(manager.intake(repository.root), "run_dirty_cleanup");
    writeFileSync(join(dirty.path, "evidence.txt"), "retain\n", "utf8");
    assert.deepEqual(manager.prepareCleanup(dirty, cleanupAuthorityFor(dirty, runtime)), { outcome: "retained", record: dirty, reason: "dirty" });
    assert.equal(existsSync(dirty.path), true);

    const failed = manager.create(manager.intake(repository.root), "run_failed_cleanup");
    assert.throws(() => cleanupAuthorityFor(failed, runtime, "FAILED"), /requires durable DONE state/u);
    assert.equal(existsSync(failed.path), true);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("durable non-success states cannot mint cleanup authority and fabricated authority is rejected", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-cleanup-states-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    for (const state of ["READY", "EXECUTE", "RECOVERY", "FAILED", "CANCELLED", "HUMAN_GATE", "HUMAN_RELEASE_GATE"]) {
      const worktree = manager.create(manager.intake(repository.root), `run_${state.toLowerCase()}`);
      assert.throws(() => cleanupAuthorityFor(worktree, runtime, state), (error: unknown) => error instanceof KerbsFlowError && error.code === "WORKTREE_CLEANUP_INELIGIBLE", state);
      assert.equal(existsSync(worktree.path), true, state);
    }
    const success = manager.create(manager.intake(repository.root), "run_forged");
    assert.throws(() => manager.prepareCleanup(success, {
      runId: asRunId(success.runKey), stateVersion: 99, worktreePath: success.path,
      worktreeGitDirectory: success.worktreeGitDirectory, markerPath: success.markerPath,
    }), (error: unknown) => error instanceof KerbsFlowError && error.code === "WORKTREE_CLEANUP_AUTHORITY_REQUIRED");
    assert.equal(existsSync(success.path), true);
    assert.equal(existsSync(join(repository.root, "README.md")), true);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("core starts clean worktree cleanup only from reopened durable DONE state", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-core-cleanup-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const worktree = manager.create(manager.intake(repository.root), "run_core_cleanup");
    cleanupAuthorityFor(worktree, runtime);
    const store = StateStore.open(join(runtime, `${worktree.runKey}.sqlite`));
    try {
      const clock = new FixedClock("2026-09-22T12:00:00.000Z");
      const ids = new SequenceIdSource("cleanup");
      const core = new KerbsFlowCore(store, new FakeAdapter(clock, ids), new FakeArtifactStore(ids));
      assert.equal(core.prepareWorktreeCleanup(asRunId(worktree.runKey), manager).outcome, "cleanup_prepared");
    } finally { store.close(); }
    assert.equal(new GitWorktreeManager(runtime).reconcileCleanup(worktree.runKey).outcome, "cleaned");
    assert.equal(existsSync(join(repository.root, "README.md")), true);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("missing or moved cleanup targets require a human gate when Git registration remains", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const worktree = manager.create(manager.intake(repository.root), "run_interrupted_cleanup");
    manager.prepareCleanup(worktree, cleanupAuthorityFor(worktree, runtime));
    const moved = `${worktree.path}-moved`;
    renameSync(worktree.path, moved);
    const reconciliation = manager.reconcileCleanup("run_interrupted_cleanup");
    assert.equal(reconciliation.outcome, "human_gate");
    assert.match("reason" in reconciliation ? reconciliation.reason : "", /registers|prune.*prohibited/i);
    assert.equal(existsSync(moved), true);
    assert.equal(existsSync(join(repository.root, "README.md")), true);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("cleanup refuses tampered repository identity before any Git side effect", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const worktree = manager.create(manager.intake(repository.root), "run_tampered_cleanup");
    manager.prepareCleanup(worktree, cleanupAuthorityFor(worktree, runtime));
    const markerPath = join(runtime, "worktree-records", "run_tampered_cleanup.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { record: Record<string, unknown> };
    marker.record.repositoryPath = runtime;
    writeFileSync(markerPath, JSON.stringify(marker), "utf8");
    const outcome = manager.reconcileCleanup("run_tampered_cleanup");
    assert.equal(outcome.outcome, "human_gate");
    assert.match("reason" in outcome ? outcome.reason : "", /repository identity/i);
    assert.equal(existsSync(worktree.path), true);
    assert.equal(existsSync(join(repository.root, "README.md")), true);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("interrupted cleanup retains a branch that moved after worktree removal", () => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-runtime-"));
  const manager = new GitWorktreeManager(runtime);
  try {
    const worktree = manager.create(manager.intake(repository.root), "run_branch_moved");
    manager.prepareCleanup(worktree, cleanupAuthorityFor(worktree, runtime));
    git(repository.root, ["worktree", "unlock", worktree.path]);
    git(repository.root, ["worktree", "remove", worktree.path]);
    git(repository.root, ["commit", "--allow-empty", "-m", "synthetic later commit"]);
    git(repository.root, ["branch", "-f", worktree.branch, "HEAD"]);
    const outcome = manager.reconcileCleanup("run_branch_moved");
    assert.equal(outcome.outcome, "human_gate");
    assert.match("reason" in outcome ? outcome.reason : "", /branch moved/i);
    assert.equal(git(repository.root, ["rev-parse", worktree.branch]), git(repository.root, ["rev-parse", "HEAD"]));
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository.root, { recursive: true, force: true });
  }
});

function cleanupAuthorityFor(record: WorktreeRecord, runtime: string, state = "DONE"): WorktreeCleanupAuthority {
  const dbPath = join(runtime, `${record.runKey}.sqlite`);
  const runId = asRunId(record.runKey);
  const initial = StateStore.open(dbPath);
  try {
    const start = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command, commandId: asCommandId(`command_${record.runKey}`),
      idempotencyKey: `start_${record.runKey}`, runId, expectedStateVersion: 0,
      kind: "start", objective: "synthetic cleanup authority fixture",
    });
    if (start.kind !== "start") throw new Error("invalid cleanup fixture command");
    initial.createRun(start);
    initial.recordWorktree({
      runId, repositoryPath: record.repositoryPath, gitCommonDirectory: record.gitCommonDirectory,
      worktreeGitDirectory: record.worktreeGitDirectory, baseOid: record.baseOid,
      branch: record.branch, worktreePath: record.path, markerPath: record.markerPath,
      createdAt: record.createdAt,
    });
  } finally { initial.close(); }
  const fixtureDb = new DatabaseSync(dbPath);
  try { fixtureDb.prepare("UPDATE runs SET state = ? WHERE run_id = ?").run(state, runId); }
  finally { fixtureDb.close(); }
  const reopened = StateStore.open(dbPath);
  try { return reopened.issueWorktreeCleanupAuthority(runId); }
  finally { reopened.close(); }
}
