import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KerbsFlowError } from "../src/errors.js";
import { GitWorktreeManager } from "../src/git.js";
import { createGitRepository, git } from "./phase2-helpers.js";

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
