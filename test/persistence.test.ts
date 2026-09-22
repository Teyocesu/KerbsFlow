import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyMigrations, MIGRATIONS, StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { KerbsFlowError } from "../src/errors.js";
import { CONTRACT_VERSIONS, asAttemptId, asReviewId, asRunId, asTaskId, requestHash, type SemanticReviewRequest } from "../src/contracts.js";

test("migration application records checksums and uses rollback journaling", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-migration-"));
  const dbPath = join(root, "state.sqlite");
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  const store = StateStore.open(dbPath, { clock, ids: new SequenceIdSource("migration") });
  store.close();
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
    const migration = db.prepare("SELECT version, checksum FROM schema_migrations").get() as { version: number; checksum: string };
    assert.equal(migration.version, 1);
    assert.equal(migration.checksum.length, 64);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed migration rolls back its DDL and preserves the prior schema", () => {
  const db = new DatabaseSync(":memory:");
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  try {
    const brokenMigrations = [
      ...MIGRATIONS,
      { version: 6, name: "broken", sql: "CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);" },
    ];
    assert.throws(() => applyMigrations(db, brokenMigrations, clock));
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get() as unknown), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 5);
  } finally {
    db.close();
  }
});

test("migration checksum drift fails closed", () => {
  const db = new DatabaseSync(":memory:");
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  try {
    applyMigrations(db, MIGRATIONS, clock);
    const drifted = [{ ...MIGRATIONS[0]!, sql: `${MIGRATIONS[0]!.sql}\n-- drift` }];
    assert.throws(() => applyMigrations(db, drifted, clock), KerbsFlowError);
  } finally {
    db.close();
  }
});

test("the forward migration removes legacy semantic-review prompt content", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-migration-review-"));
  const dbPath = join(root, "state.sqlite");
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  const request: SemanticReviewRequest = {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewRequest,
    reviewAttemptId: asReviewId("review_legacy"),
    runId: asRunId("run_legacy"),
    taskId: asTaskId("task_legacy"),
    attemptId: asAttemptId("attempt_legacy"),
    role: "review",
    workingDirectory: "/synthetic/worktree",
    promptSummary: "legacy raw bounded diff that must not remain in SQLite",
    model: "fixture",
    permissionPolicy: { filesystem: "read_only", network: "denied" },
    canonicalContextHash: "canonical",
    diffHash: "diff",
    validationIds: [],
    expectedResultSchema: CONTRACT_VERSIONS.semanticReviewResult,
  };
  const legacy = new DatabaseSync(dbPath);
  try {
    applyMigrations(legacy, MIGRATIONS.slice(0, 3), clock);
    legacy.prepare("INSERT INTO runs (run_id, objective, state, state_version, recovery_required, created_at, updated_at) VALUES (?, ?, 'DONE', 1, 0, ?, ?)").run(request.runId, "legacy", clock.now(), clock.now());
    legacy.prepare("INSERT INTO tasks (task_id, run_id, status, decision_json, created_at, updated_at) VALUES (?, ?, 'complete', '{}', ?, ?)").run(request.taskId, request.runId, clock.now(), clock.now());
    legacy.prepare("INSERT INTO attempts (attempt_id, run_id, task_id, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'SUCCEEDED', ?, ?)").run(request.attemptId, request.runId, request.taskId, clock.now(), clock.now());
    legacy.prepare("INSERT INTO semantic_review_attempts (review_attempt_id, run_id, task_id, attempt_id, lifecycle, request_json, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?)").run(request.reviewAttemptId, request.runId, request.taskId, request.attemptId, JSON.stringify(request), requestHash(request), clock.now(), clock.now());
  } finally {
    legacy.close();
  }

  const store = StateStore.open(dbPath, { clock, ids: new SequenceIdSource("migration-review") });
  try {
    const migrated = store.getSemanticReviewAttempt(request.reviewAttemptId);
    assert.match(migrated?.request.promptSummary ?? "", /context omitted from SQLite/);
    assert.doesNotMatch(migrated?.request.promptSummary ?? "", /legacy raw bounded diff/);
    const check = new DatabaseSync(dbPath);
    try {
      const row = check.prepare("SELECT request_json, stored_request_hash FROM semantic_review_attempts WHERE review_attempt_id = ?").get(request.reviewAttemptId) as { request_json: string; stored_request_hash: string };
      assert.equal(row.request_json.includes("legacy raw bounded diff"), false);
      assert.equal(row.stored_request_hash.length, 64);
    } finally {
      check.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
