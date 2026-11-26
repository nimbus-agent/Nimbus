import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

const COLUMNS = [
  "billed_cost",
  "billing_account_id",
  "billing_period",
  "charge_category",
  "charge_day",
  "currency",
  "effective_cost",
  "grain_hash",
  "id",
  "import_id",
  "model",
  "provider",
  "region_id",
  "repo",
  "resource_id",
  "resource_name",
  "service_category",
  "service_name",
  "sku_id",
  "source",
  "sub_account_id",
  "sub_account_name",
  "tags_json",
  "workflow",
];

describe("V109 cost lines (Phase 7)", () => {
  test("the schema constant and the registered chain reach 109", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(109);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("a fresh database has the table, its columns, the unique grain key and two read indexes", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const cols = db.query("PRAGMA table_info(cost_line)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(COLUMNS);
    const idx = db.query("PRAGMA index_list(cost_line)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const named = idx.filter((i) => !i.name.startsWith("sqlite_autoindex"));
    expect(named.map((i) => i.name).sort()).toEqual([
      "cost_line_grain",
      "cost_line_source_account_day",
      "cost_line_source_day",
    ]);
    expect(named.find((i) => i.name === "cost_line_grain")?.unique).toBe(1);
    const grainCols = db.query("PRAGMA index_info(cost_line_grain)").all() as Array<{
      name: string;
    }>;
    expect(grainCols.map((c) => c.name)).toEqual([
      "source",
      "provider",
      "billing_account_id",
      "charge_day",
      "grain_hash",
    ]);
    // No foreign key and no trigger: an owner erasure goes through the store.
    expect(db.query("PRAGMA foreign_key_list(cost_line)").all()).toEqual([]);
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'cost_line'")
        .all(),
    ).toEqual([]);
    db.close();
  });

  test("the unique grain key refuses a second row of the same grain", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const insert = `INSERT INTO cost_line (source, provider, billing_account_id, billing_period, charge_day,
      service_name, charge_category, billed_cost, currency, tags_json, import_id, grain_hash)
      VALUES ('focus','aws','111','2026-11','2026-11-01','S3','usage',1.5,'USD','{}','imp1','g1')`;
    db.run(insert);
    expect(() => db.run(insert)).toThrow();
    db.close();
  });

  test("an upgrade from V108 keeps data and is re-runnable", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 108);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'cost_line'").all()).toEqual([]);
    runIndexedSchemaMigrations(db, 109);
    db.run(
      `INSERT INTO cost_line (source, provider, billing_account_id, billing_period, charge_day,
        service_name, charge_category, billed_cost, currency, tags_json, import_id, grain_hash)
        VALUES ('focus','aws','111','2026-11','2026-11-01','S3','usage',1.5,'USD','{}','imp1','g1')`,
    );
    db.run("PRAGMA user_version = 108");
    runIndexedSchemaMigrations(db, 109);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 109 });
    expect(db.query("SELECT COUNT(*) AS n FROM cost_line").get()).toEqual({ n: 1 });
    db.close();
  });
});
