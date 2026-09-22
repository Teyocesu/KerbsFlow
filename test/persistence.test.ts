import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { applyMigrations, MIGRATIONS, StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { KerbsFlowError } from "../src/errors.js";
import { CONTRACT_VERSIONS, asAttemptId, asCommandId, asReviewId, asRunId, asTaskId, requestHash, type SemanticReviewRequest } from "../src/contracts.js";

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
      { version: 10, name: "broken", sql: "CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);" },
    ];
    assert.throws(() => applyMigrations(db, brokenMigrations, clock));
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get() as unknown), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 9);
  } finally {
    db.close();
  }
});

test("forward migration creates and verifies an owner-only bounded backup", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-backup-"));
  const dbPath = join(root, "state.sqlite");
  const clock = new FixedClock("2026-09-22T12:34:56.789Z");
  const legacy = new DatabaseSync(dbPath);
  applyMigrations(legacy, MIGRATIONS.slice(0, 8), clock);
  legacy.close();
  const store = StateStore.open(dbPath, { clock });
  store.close();
  try {
    const backups = readdirSync(join(root, "backups")).sort();
    assert.equal(backups.length, 2);
    const databaseBackup = backups.find((path) => path.endsWith(".sqlite"));
    const metadataBackup = backups.find((path) => path.endsWith(".json"));
    assert.ok(databaseBackup && metadataBackup);
    assert.match(databaseBackup, /v8-to-v9/);
    assert.equal(lstatSync(dbPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, "backups")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, "backups", databaseBackup)).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, "backups", metadataBackup)).mode & 0o777, 0o600);
    const metadata = JSON.parse(readFileSync(join(root, "backups", metadataBackup), "utf8")) as { sourceVersion: number; targetVersion: number; sha256: string };
    assert.deepEqual({ sourceVersion: metadata.sourceVersion, targetVersion: metadata.targetVersion, hashLength: metadata.sha256.length }, { sourceVersion: 8, targetVersion: 9, hashLength: 64 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup collision fails closed before retrying a failed migration", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-backup-failure-"));
  const dbPath = join(root, "state.sqlite");
  const clock = new FixedClock("2026-09-22T12:34:56.789Z");
  const base = new DatabaseSync(dbPath);
  applyMigrations(base, MIGRATIONS.slice(0, 8), clock);
  base.close();
  const broken = [...MIGRATIONS.slice(0, 8), { version: 9, name: "broken", sql: "CREATE TABLE rollback_me (id INTEGER); INSERT INTO absent VALUES (1);" }];
  assert.throws(() => StateStore.open(dbPath, { clock, migrations: broken }));
  assert.throws(() => StateStore.open(dbPath, { clock, migrations: broken }), (error: unknown) => error instanceof KerbsFlowError && error.code === "DATABASE_BACKUP_FAILED");
  const check = new DatabaseSync(dbPath);
  try {
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_me'").get(), undefined);
    assert.equal((check.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 8);
  } finally {
    check.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt and truncated databases fail closed without automatic reset", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-corrupt-"));
  const corruptPath = join(root, "corrupt.sqlite");
  const truncatedPath = join(root, "truncated.sqlite");
  writeFileSync(corruptPath, "not a sqlite database and must be retained", "utf8");
  const valid = StateStore.open(truncatedPath);
  valid.close();
  truncateSync(truncatedPath, 128);
  try {
    assert.throws(() => StateStore.open(corruptPath), /integrity|automatic reset|could not be opened/i);
    assert.equal(readFileSync(corruptPath, "utf8"), "not a sqlite database and must be retained");
    assert.throws(() => StateStore.open(truncatedPath), /integrity|automatic reset|could not be opened/i);
    assert.equal(lstatSync(truncatedPath).size, 128);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incompatible schema and simultaneous duplicate ownership fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-schema-"));
  const dbPath = join(root, "state.sqlite");
  const store = StateStore.open(dbPath);
  try {
    assert.throws(() => StateStore.open(dbPath), (error: unknown) => error instanceof KerbsFlowError && error.code === "DATABASE_OWNER_EXISTS");
  } finally {
    store.close();
  }
  try {
    assert.throws(() => StateStore.open(dbPath, { migrations: MIGRATIONS.slice(0, 8) }), (error: unknown) => error instanceof KerbsFlowError && error.code === "INCOMPATIBLE_SCHEMA_VERSION");
    const reopened = StateStore.open(dbPath);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database owner excludes an independent Node process and retains ambiguous stale records", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-cross-owner-"));
  const dbPath = join(root, "state.sqlite");
  const moduleUrl = new URL("../src/persistence.js", import.meta.url).href;
  const child = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { StateStore } from ${JSON.stringify(moduleUrl)};
    try { const store = StateStore.open(process.argv[1]); store.close(); console.log('opened'); }
    catch (error) { console.log(error.code ?? 'unknown'); process.exitCode = 2; }
  `, dbPath], { encoding: "utf8", timeout: 10000 });
  try {
    const first = StateStore.open(dbPath);
    try {
      const rejected = child();
      assert.equal(rejected.status, 2);
      assert.match(rejected.stdout, /DATABASE_OWNER_EXISTS/u);
    } finally { first.close(); }
    const accepted = child();
    assert.equal(accepted.status, 0);
    assert.match(accepted.stdout, /opened/u);
    writeFileSync(`${dbPath}.owner`, JSON.stringify({ schemaVersion: "kerbsflow.database-owner/v1", pid: 999999, nonce: "stale" }), { mode: 0o600 });
    const stale = child();
    assert.equal(stale.status, 2);
    assert.match(stale.stdout, /DATABASE_OWNER_EXISTS/u);
    assert.equal(lstatSync(`${dbPath}.owner`).mode & 0o777, 0o600);
    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try { assert.ok((unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count > 0); }
    finally { unchanged.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("credential-shaped command data is rejected before SQLite persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-persistence-secret-"));
  const dbPath = join(root, "state.sqlite");
  const store = StateStore.open(dbPath);
  const syntheticCredential = "AWS_SECRET_ACCESS_KEY=synthetic-credential-value";
  try {
    assert.throws(() => store.createRun({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: asCommandId("command_secret_rejection"),
      idempotencyKey: "secret-rejection",
      runId: asRunId("run_secret_rejection"),
      expectedStateVersion: 0,
      kind: "start",
      objective: syntheticCredential,
    }), /sensitive credential material/i);
  } finally {
    store.close();
  }
  try {
    assert.equal(readFileSync(dbPath).includes(Buffer.from(syntheticCredential)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
