import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileArtifactStore } from "../src/artifacts.js";
import { asArtifactId, asRunId } from "../src/contracts.js";
import { SequenceIdSource } from "../src/runtime.js";

test("artifact store resolves only allocated IDs and verifies content metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-artifacts-"));
  try {
    const store = new FileArtifactStore(root, new SequenceIdSource("artifact"));
    const artifact = store.put(asRunId("run_artifact"), "verification", "synthetic evidence\n");
    assert.equal(store.get(artifact.artifactId), "synthetic evidence\n");
    assert.throws(() => store.get(asArtifactId("artifact_wrong")), /missing|unreadable/i);

    writeFileSync(join(root, artifact.relativePath), "corrupted evidence\n", "utf8");
    assert.throws(() => store.get(artifact.artifactId), /size|hash/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact store rejects symlink replacement, oversized content, malformed IDs, and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-artifacts-"));
  const outside = join(root, "outside.txt");
  try {
    const store = new FileArtifactStore(root, new SequenceIdSource("artifact"), { maximumBytes: 32 });
    const artifact = store.put(asRunId("run_artifact"), "verification", "synthetic evidence\n");
    writeFileSync(outside, "synthetic evidence\n", "utf8");
    unlinkSync(join(root, artifact.relativePath));
    symlinkSync(outside, join(root, artifact.relativePath));
    assert.throws(() => store.get(artifact.artifactId), /symbolic link|linked/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "verification", "x".repeat(33)), /too large|exceeds/i);
    assert.throws(() => store.get("../artifact_escape" as ReturnType<typeof asArtifactId>), /artifactId|identifier/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "verification", "Bearer synthetic-secret-value"), /sensitive .*material/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "verification", "synthetic", undefined, "unknown" as never), /retention/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact runtime paths and files use owner-only POSIX modes and public fixtures stay synthetic", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "kerbsflow-artifacts-"));
  const root = join(parent, "runtime");
  try {
    const store = new FileArtifactStore(root, new SequenceIdSource("artifact"));
    const artifact = store.put(asRunId("run_artifact"), "fixture", "synthetic fixture\n", undefined, "public_synthetic_fixture");
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(dirname(join(root, artifact.relativePath))).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, artifact.relativePath)).mode & 0o777, 0o600);
    assert.throws(() => store.put(asRunId("run_artifact"), "fixture", "/Users/real-person/private.txt", undefined, "public_synthetic_fixture"), /user-home/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "fixture", "Cookie: session=synthetic-cookie-value", undefined, "public_synthetic_fixture"), /credential|cookie/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "fixture", "SQLite format 3\0synthetic", undefined, "public_synthetic_fixture"), /SQLite/i);
    assert.throws(() => store.put(asRunId("run_artifact"), "fixture", ".git/worktrees/private-checkout", undefined, "public_synthetic_fixture"), /worktree/i);
    const privatePath = store.put(asRunId("run_artifact"), "fixture", "/Users/real-person/private.txt");
    assert.throws(() => store.setRetention(privatePath.artifactId, "public_synthetic_fixture"), /user-home/i);
    const metadataPath = join(root, "metadata", `${artifact.artifactId}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, unexpected: true }), "utf8");
    assert.throws(() => store.get(artifact.artifactId), /metadata/i);
    writeFileSync(metadataPath, '{"contentHash":"ghp_synthetic123456"', "utf8");
    for (const operation of [() => store.get(artifact.artifactId), () => store.setRetention(artifact.artifactId, "active_run")]) {
      assert.throws(operation, (error: unknown) => error instanceof Error && /metadata/i.test(error.message) && !error.message.includes("ghp_synthetic123456"));
    }
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});
