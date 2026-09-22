import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePrivateDirectory, readPrivateFileWithin, resolveNewWithin } from "../src/paths.js";

test("allowed-root paths reject traversal and absolute escape", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-paths-"));
  try {
    assert.throws(() => resolveNewWithin(root, "../outside.txt"), /escape/i);
    assert.throws(() => resolveNewWithin(root, join(root, "absolute.txt")), /relative/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing non-private directories are rejected without changing their permissions", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "kerbsflow-paths-"));
  const existing = join(parent, "not-owned");
  mkdirSync(existing, { mode: 0o755 });
  try {
    assert.throws(() => ensurePrivateDirectory(existing), /owner-only|permissions/i);
    assert.equal(lstatSync(existing).mode & 0o777, 0o755);
  } finally {
    chmodSync(existing, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("allowed-root reads reject direct and nested symlink escape", () => {
  const parent = mkdtempSync(join(tmpdir(), "kerbsflow-paths-"));
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "secret.txt"), "synthetic outside data\n", { mode: 0o600 });
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "direct.txt"));
    symlinkSync(outside, join(root, "nested"));
    assert.throws(() => readPrivateFileWithin(root, "direct.txt", 1024), /linked|symbolic/i);
    assert.throws(() => readPrivateFileWithin(root, "nested/secret.txt", 1024), /outside|escape/i);
    writeFileSync(join(root, "oversized.txt"), "synthetic content", { mode: 0o600 });
    assert.throws(() => readPrivateFileWithin(root, "oversized.txt", 8), /exceeds|too large/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
