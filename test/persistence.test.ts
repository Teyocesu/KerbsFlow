import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyMigrations, MIGRATIONS, StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";
import { KerbsFlowError } from "../src/errors.js";

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
      { version: 2, name: "broken", sql: "CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);" },
    ];
    assert.throws(() => applyMigrations(db, brokenMigrations, clock));
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get() as unknown), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 1);
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
