import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileArtifactStore } from "../src/artifacts.js";
import { asArtifactId, asRunId } from "../src/contracts.js";
import { SequenceIdSource } from "../src/runtime.js";

test("artifact store binds reads to the allocated ID and runtime root", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-artifacts-"));
  try {
    const store = new FileArtifactStore(root, new SequenceIdSource("artifact"));
    const artifact = store.put(asRunId("run_artifact"), "verification", "synthetic evidence\n");

    assert.equal(store.get(artifact.artifactId, artifact.relativePath), "synthetic evidence\n");
    assert.throws(
      () => store.get(asArtifactId("artifact_wrong"), artifact.relativePath),
      /does not match/i,
    );
    assert.throws(
      () => store.get(artifact.artifactId, `../${artifact.artifactId}.json`),
      /escapes/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
