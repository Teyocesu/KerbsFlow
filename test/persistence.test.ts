import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

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
    const nextVersion = (MIGRATIONS.at(-1)?.version ?? 0) + 1;
    const brokenMigrations = [
      ...MIGRATIONS,
      { version: nextVersion, name: "broken", sql: "CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);" },
    ];
    assert.throws(() => applyMigrations(db, brokenMigrations, clock));
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get() as unknown), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, MIGRATIONS.length);
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
    const targetVersion = MIGRATIONS.at(-1)?.version ?? 9;
    assert.match(databaseBackup, new RegExp(`v8-to-v${targetVersion}`));
    assert.equal(lstatSync(dbPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, "backups")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, "backups", databaseBackup)).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, "backups", metadataBackup)).mode & 0o777, 0o600);
    const metadata = JSON.parse(readFileSync(join(root, "backups", metadataBackup), "utf8")) as { sourceVersion: number; targetVersion: number; sha256: string };
    assert.deepEqual({ sourceVersion: metadata.sourceVersion, targetVersion: metadata.targetVersion, hashLength: metadata.sha256.length }, { sourceVersion: 8, targetVersion, hashLength: 64 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward migration retains the external identity and precondition of an unfinished cancellation intent", () => {
  const db = new DatabaseSync(":memory:");
  const clock = new FixedClock("2026-09-22T12:34:56.789Z");
  const runId = asRunId("run_legacy_cancel_intent");
  const taskId = asTaskId("task_legacy_cancel_intent");
  const attemptId = asAttemptId("attempt_legacy_cancel_intent");
  const commandId = asCommandId("command_legacy_cancel_intent");
  const idempotencyKey = "cancel:legacy:exact-request";
  const expectedStateVersion = 4;
  try {
    applyMigrations(db, MIGRATIONS.slice(0, 11), clock);
    db.prepare("INSERT INTO runs (run_id, objective, state, state_version, current_task_id, active_attempt_id, created_at, updated_at) VALUES (?, ?, 'EXECUTE', ?, ?, ?, ?, ?)")
      .run(runId, "legacy cancellation fixture", expectedStateVersion, taskId, attemptId, clock.now(), clock.now());
    db.prepare("INSERT INTO tasks (task_id, run_id, status, decision_json, created_at, updated_at) VALUES (?, ?, 'active', '{}', ?, ?)")
      .run(taskId, runId, clock.now(), clock.now());
    db.prepare("INSERT INTO attempts (attempt_id, run_id, task_id, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'RUNNING', ?, ?)")
      .run(attemptId, runId, taskId, clock.now(), clock.now());
    const request = {
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId,
      idempotencyKey,
      runId,
      expectedStateVersion,
      kind: "cancel",
      reason: "preserve pending request identity",
    };
    db.prepare("INSERT INTO commands (idempotency_key, command_id, run_id, request_hash, request_json, result_json, transition_id, state_version_before, state_version_after, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(idempotencyKey, commandId, runId, requestHash(request), JSON.stringify(request), "{}", expectedStateVersion, expectedStateVersion, clock.now());
    db.prepare("INSERT INTO cancellation_intents (attempt_id, run_id, reason, status, request_command_id, requested_at, updated_at) VALUES (?, ?, ?, 'REQUESTED', ?, ?, ?)")
      .run(attemptId, runId, request.reason, commandId, clock.now(), clock.now());

    applyMigrations(db, MIGRATIONS, clock);
    const intent = db.prepare("SELECT request_command_id, request_idempotency_key, request_expected_state_version FROM cancellation_intents")
      .get() as { request_command_id: string; request_idempotency_key: string; request_expected_state_version: number };
    assert.deepEqual({ ...intent }, {
      request_command_id: commandId,
      request_idempotency_key: idempotencyKey,
      request_expected_state_version: expectedStateVersion,
    });
  } finally {
    db.close();
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

test("schema 12 upgrade preserves old checksums and new migration failure rolls back", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-schema12-"));
  const path = join(root, "state.sqlite");
  try {
    const db = new DatabaseSync(path);
    applyMigrations(db, MIGRATIONS.slice(0, 12));
    const old = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
    assert.throws(() => applyMigrations(db, [...MIGRATIONS.slice(0, 12), { version: 13, name: "synthetic-failure", sql: "CREATE TABLE rollback_13 (id INTEGER); INSERT INTO no_such_table VALUES (1);" }]));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_13'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all(), old);
    db.close();
    const upgraded = StateStore.open(path);
    upgraded.close();
    const inspect = new DatabaseSync(path);
    assert.deepEqual(inspect.prepare("SELECT version, checksum FROM schema_migrations WHERE version <= 12 ORDER BY version").all(), old);
    assert.equal(inspect.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, 14);
    inspect.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit original database owner recovery proves dead macOS owner after SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-owner-crash-"));
  const path = join(root, "state.sqlite");
  const moduleUrl = new URL("../src/persistence.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { StateStore } from ${JSON.stringify(moduleUrl)}; StateStore.open(${JSON.stringify(path)}); console.log('READY'); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("owner exited before readiness"))); });
    assert.throws(() => StateStore.open(path, { recoverOwner: true }), /owner is still live/);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const original = readFileSync(path);
    assert.throws(() => StateStore.open(path), /explicit recovery/);
    const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8"));
    assert.equal(owner.schemaVersion, "kerbsflow.database-owner/v2");
    const reopened = StateStore.open(path, { recoverOwner: true });
    assert.deepEqual(readFileSync(path), original, "owner recovery must preserve the original database bytes");
    reopened.close();
  } finally { child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

for (const variant of ["host", "boot", "legacy", "pid-reuse"] as const) {
  test(`explicit owner recovery fails closed on ambiguity or proves PID reuse: ${variant}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kerbsflow-owner-identity-"));
    const path = join(root, "state.sqlite");
    try {
      const store = StateStore.open(path);
      const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8"));
      store.close();
      if (variant === "host") owner.host = "different-host";
      if (variant === "boot") owner.boot = "different-boot";
      if (variant === "legacy") owner.schemaVersion = "kerbsflow.database-owner/v1";
      if (variant === "pid-reuse") owner.birth = "Fri Jan  1 00:00:00 1999";
      writeFileSync(`${path}.owner`, JSON.stringify(owner), { mode: 0o600 });
      const before = readFileSync(path);
      if (variant === "pid-reuse") {
        const recovered = StateStore.open(path, { recoverOwner: true });
        recovered.close();
      } else {
        assert.throws(() => StateStore.open(path, { recoverOwner: true }), /ambiguous|legacy|foreign/i);
        assert.deepEqual(JSON.parse(readFileSync(`${path}.owner`, "utf8")), owner);
      }
      assert.deepEqual(readFileSync(path), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("concurrent explicit recoverers cannot both acquire the original database and an ordinary opener cannot steal it", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-owner-race-"));
  const path = join(root, "state.sqlite");
  const store = StateStore.open(path);
  const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8"));
  store.close();
  owner.birth = "Fri Jan  1 00:00:00 1999";
  writeFileSync(`${path}.owner`, JSON.stringify(owner), { mode: 0o600 });
  const moduleUrl = new URL("../src/persistence.js", import.meta.url).href;
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, ["--input-type=module", "-e", `import { StateStore } from ${JSON.stringify(moduleUrl)}; console.log('READY'); process.stdin.once('data', () => { try { const store = StateStore.open(${JSON.stringify(path)}, {recoverOwner:true}); console.log('ACQUIRED'); process.stdin.once('data', () => { store.close(); process.exit(0); }); } catch(error) { console.log('REJECTED:' + error.code); process.exit(0); } });`], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); })));
    const responses = children.map(child => new Promise<string>((resolve, reject) => { child.stdout!.once("data", chunk => resolve(chunk.toString().trim())); child.once("error", reject); }));
    children.forEach(child => child.stdin!.write("GO\n"));
    const values = await Promise.all(responses);
    assert.equal(values.filter(value => value === "ACQUIRED").length, 1, values.join(","));
    assert.equal(values.filter(value => value.startsWith("REJECTED:")).length, 1);
    assert.throws(() => StateStore.open(path), /owner record already exists|already in progress/);
    assert.throws(() => StateStore.open(path, { recoverOwner: true }), /owner is still live|already in progress/);
    const winner = children[values.indexOf("ACQUIRED")]!;
    const exit = new Promise<void>(resolve => winner.once("exit", () => resolve()));
    winner.stdin!.write("CLOSE\n");
    await exit;
    StateStore.open(path).close();
  } finally { children.forEach(child => child.kill("SIGKILL")); rmSync(root, { recursive: true, force: true }); }
});

test("explicit owner recovery retains an owner changed after actual OS observation", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-owner-changed-"));
  const path = join(root, "state.sqlite");
  const originalExec = childProcess.execFileSync;
  try {
    const store = StateStore.open(path);
    const owner = JSON.parse(readFileSync(`${path}.owner`, "utf8"));
    store.close();
    owner.birth = "Fri Jan  1 00:00:00 1999";
    writeFileSync(`${path}.owner`, JSON.stringify(owner), { mode: 0o600 });
    const changed = { ...owner, nonce: "00000000-0000-0000-0000-000000000000" };
    const before = readFileSync(path);
    const observation = test.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof originalExec>) => {
      const result = originalExec(...args);
      if (args[0] === "/bin/ps") writeFileSync(`${path}.owner`, JSON.stringify(changed), { mode: 0o600 });
      return result;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => StateStore.open(path, { recoverOwner: true }), (error: unknown) => error instanceof KerbsFlowError && error.code === "DATABASE_OWNER_CHANGED");
      assert.deepEqual(JSON.parse(readFileSync(`${path}.owner`, "utf8")), changed);
      assert.deepEqual(readFileSync(path), before);
    } finally { observation.mock.restore(); syncBuiltinESMExports(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
