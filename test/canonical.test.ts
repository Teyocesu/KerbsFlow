import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CanonicalIntentGuard } from "../src/canonical.js";
import { StateStore } from "../src/persistence.js";
import { createFixture } from "./helpers.js";

test("canonical hashes are captured once and drift cannot be silently refreshed", () => {
  const fixture = createFixture();
  const repository = canonicalRepository();
  try {
    fixture.core.startRun(fixture.runId, "canonical fixture", "canonical:start");
    const guard = new CanonicalIntentGuard(fixture.store);
    const captured = guard.capture(fixture.runId, repository, "a".repeat(40));
    assert.equal(Object.keys(captured.hashes).length, 4);
    assert.equal(guard.verify(fixture.runId).current, true);

    writeFileSync(join(repository, "docs", "PLAN-v0.1.0.md"), "changed unexpectedly\n", "utf8");
    const drift = guard.verify(fixture.runId);
    assert.equal(drift.current, false);
    assert.deepEqual(drift.changed, ["docs/PLAN-v0.1.0.md"]);
    assert.throws(() => guard.capture(fixture.runId, repository, "a".repeat(40)), /cannot be silently refreshed/i);
    assert.throws(() => guard.preparePhaseBoundary("boundary_drift", fixture.runId), /drift|changed unexpectedly/i);
  } finally {
    fixture.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("phase boundary permits only explicit PLAN/HANDOFF updates and persists crash boundaries", () => {
  const fixture = createFixture();
  const repository = canonicalRepository();
  try {
    fixture.core.startRun(fixture.runId, "canonical fixture", "canonical:start");
    let guard = new CanonicalIntentGuard(fixture.store);
    guard.capture(fixture.runId, repository, "b".repeat(40));
    const prepared = guard.preparePhaseBoundary("boundary_phase3", fixture.runId);
    assert.equal(prepared.status, "PREPARED");
    fixture.store.close();
    fixture.store = StateStore.open(fixture.dbPath, { clock: fixture.clock, ids: fixture.ids });
    guard = new CanonicalIntentGuard(fixture.store);
    assert.equal(fixture.store.getPhaseBoundary("boundary_phase3")?.status, "PREPARED", "a restart before document update preserves the explicit boundary");

    writeFileSync(join(repository, "docs", "PLAN-v0.1.0.md"), "phase complete\n", "utf8");
    writeFileSync(join(repository, "docs", "HANDOFF.md"), "audit next\n", "utf8");
    const completed = guard.completePhaseBoundary("boundary_phase3", fixture.runId);
    assert.equal(completed.status, "APPLIED");
    assert.equal(guard.verify(fixture.runId).current, true, "an explicit applied boundary advances the canonical hash snapshot");
    assert.equal(guard.completePhaseBoundary("boundary_phase3", fixture.runId).status, "APPLIED", "completion is idempotent");
  } finally {
    fixture.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("phase boundary rejects SPEC mutation", () => {
  const fixture = createFixture();
  const repository = canonicalRepository();
  try {
    fixture.core.startRun(fixture.runId, "canonical fixture", "canonical:start");
    const guard = new CanonicalIntentGuard(fixture.store);
    guard.capture(fixture.runId, repository, "c".repeat(40));
    guard.preparePhaseBoundary("boundary_spec", fixture.runId);
    writeFileSync(join(repository, "docs", "SPEC-v0.1.0.md"), "mutated spec\n", "utf8");
    assert.throws(() => guard.completePhaseBoundary("boundary_spec", fixture.runId), /cannot change/i);
    assert.equal(fixture.store.getPhaseBoundary("boundary_spec")?.status, "PREPARED");
  } finally {
    fixture.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

function canonicalRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-canonical-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "AGENTS.md"), "rules\n", "utf8");
  writeFileSync(join(root, "docs", "SPEC-v0.1.0.md"), "spec\n", "utf8");
  writeFileSync(join(root, "docs", "PLAN-v0.1.0.md"), "plan\n", "utf8");
  writeFileSync(join(root, "docs", "HANDOFF.md"), "handoff\n", "utf8");
  return root;
}
