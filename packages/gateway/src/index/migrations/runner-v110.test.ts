import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

const INSERT_V109 = `INSERT INTO cost_line (source, provider, billing_account_id, billing_period, charge_day,
  service_name, charge_category, billed_cost, currency, tags_json, import_id, grain_hash)
  VALUES ('focus','aws','111','2026-11','2026-11-01','S3','usage',1.5,'USD','{}','imp1','g1')`;

describe("V110 cost line quantity and priced flag (Phase 7, slice 8)", () => {
  test("the schema constant and the registered chain reach 110", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(110);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(110);
  });

  test("a V109 line reads back priced, with no quantity", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 109);
    db.run(INSERT_V109);
    runIndexedSchemaMigrations(db, 110);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 110 });
    expect(
      db.query("SELECT consumed_quantity, consumed_unit, priced FROM cost_line").get(),
    ).toEqual({ consumed_quantity: null, consumed_unit: null, priced: 1 });
    db.close();
  });

  test("the step is re-runnable: a rewound version runs it again without error", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 110);
    db.run("PRAGMA user_version = 109");
    expect(() => runIndexedSchemaMigrations(db, 110)).not.toThrow();
    const cols = db.query("PRAGMA table_info(cost_line)").all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "priced")).toHaveLength(1);
    db.close();
  });

  test("the CHECKs refuse a priced value other than 0 or 1 and an empty or long unit", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 110);
    db.run(INSERT_V109);
    expect(() => db.run("UPDATE cost_line SET priced = 2")).toThrow();
    expect(() => db.run("UPDATE cost_line SET consumed_unit = ''")).toThrow();
    expect(() => db.run(`UPDATE cost_line SET consumed_unit = '${"x".repeat(33)}'`)).toThrow();
    expect(() => db.run("UPDATE cost_line SET consumed_unit = 'minute'")).not.toThrow();
    db.close();
  });

  test("the grain key is unchanged: quantity is a measure, not part of it", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 110);
    const grainCols = db.query("PRAGMA index_info(cost_line_grain)").all() as Array<{
      name: string;
    }>;
    expect(grainCols.map((c) => c.name)).not.toContain("consumed_quantity");
    db.close();
  });
});
