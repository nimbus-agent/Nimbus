import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "./runner.ts";

const dbs: Database[] = [];

afterEach(() => {
  while (dbs.length > 0) {
    const d = dbs.pop();
    if (d) d.close();
  }
});

function newDb(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}

test("V23 adds dry_run and params_override_json to workflow_run", () => {
  const db = newDb();
  runIndexedSchemaMigrations(db, 23);
  expect(readIndexedUserVersion(db)).toBeGreaterThanOrEqual(23);

  const info = db.query(`PRAGMA table_info(workflow_run)`).all() as Array<{
    name: string;
    type: string;
    dflt_value: string | null;
    notnull: number;
  }>;

  const dryRun = info.find((c) => c.name === "dry_run");
  expect(dryRun).toBeDefined();
  expect(dryRun?.type.toUpperCase()).toBe("INTEGER");
  expect(dryRun?.notnull).toBe(1);
  expect(dryRun?.dflt_value).toBe("0");

  const paramsOverride = info.find((c) => c.name === "params_override_json");
  expect(paramsOverride).toBeDefined();
  expect(paramsOverride?.type.toUpperCase()).toBe("TEXT");
});

test("V23 is idempotent on re-apply", () => {
  const db = newDb();
  runIndexedSchemaMigrations(db, 23);
  runIndexedSchemaMigrations(db, 23);
  expect(readIndexedUserVersion(db)).toBeGreaterThanOrEqual(23);
});

test("V23 backfills existing rows with defaults", () => {
  const db = newDb();
  runIndexedSchemaMigrations(db, 23);
  db.run(
    `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
     VALUES ('wf1', 'n', NULL, '[]', 0, 0)`,
  );
  db.run(
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at)
     VALUES ('r1', 'wf1', 'user', 'done', 1)`,
  );
  const row = db
    .query(`SELECT dry_run, params_override_json FROM workflow_run WHERE id = 'r1'`)
    .get() as { dry_run: number; params_override_json: string | null };
  expect(row.dry_run).toBe(0);
  expect(row.params_override_json).toBeNull();
});
