import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { SCHEMA_READ_ROW_CAP } from "../../index/schema-diff.ts";
import { recordSchemaObservation } from "../../index/schema-history.ts";
import type { SchemaColumn } from "../../index/schema-history-source.ts";
import type { DataLineageView } from "../incident-record-types.ts";
import { SCHEMA_KEY_CAP, schemaLane } from "./data-schema.ts";

/** The schema lane's rarer paths: nullability text, de-duplicated keys, a cut history and the key cap. */

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const H = 3_600_000;
const OPEN = 1_000 * H;
const MODEL = "analytics.payments.orders";
const UP = "raw.payments.orders_raw";
const col = (name: string, type: string | null, nullable: boolean | null): SchemaColumn => ({
  name,
  type,
  nullable,
});
const observe = (d: Database, key: string, columns: SchemaColumn[], at: number): void => {
  recordSchemaObservation(d, { service: "snowflake", key, columns }, at);
};
const lineage = (to: string): DataLineageView => ({ model: MODEL, to, rule: "data:derived_from" });
const run = (d: Database, models: string[], lin: DataLineageView[] = []) =>
  schemaLane(d, { models, lineage: lin, openedAtMs: OPEN, nowMs: OPEN, lookbackHours: 24 });

describe("schemaLane branches", () => {
  test("a nullability change reads unknown, nullable and required", () => {
    const d = db();
    observe(d, MODEL, [col("x", "NUMBER", null)], OPEN - 5 * H);
    observe(d, MODEL, [col("x", "NUMBER", true)], OPEN - 4 * H);
    observe(d, MODEL, [col("x", "NUMBER", false)], OPEN - 3 * H);
    const r = run(d, [MODEL]);
    expect(r.lane?.changes.map((c) => `${c.kind}:${String(c.from)}>${String(c.to)}`)).toEqual([
      "nullability_changed:nullable>required",
      "nullability_changed:unknown>nullable",
    ]);
    expect(r.gaps).toEqual([]);
  });

  test("a type the source never gave stays null", () => {
    const d = db();
    observe(d, MODEL, [col("x", null, true)], OPEN - 5 * H);
    observe(d, MODEL, [col("x", "TEXT", true)], OPEN - 4 * H);
    expect(run(d, [MODEL]).lane?.changes[0]).toMatchObject({
      kind: "type_changed",
      from: null,
      to: "TEXT",
    });
  });

  test("a table named twice is examined once, and same-time changes sort by model", () => {
    const d = db();
    for (const key of [UP, MODEL]) {
      observe(d, key, [col("a", "NUMBER", true)], OPEN - 5 * H);
      observe(d, key, [col("a", "NUMBER", true), col("b", "TEXT", true)], OPEN - 2 * H);
    }
    const r = run(d, [MODEL, MODEL], [lineage(MODEL), lineage(UP), lineage(UP)]);
    expect(r.lane?.changes.map((c) => `${c.via}:${c.model}:${c.column}`)).toEqual([
      `monitored:${MODEL}:b`,
      `upstream:${UP}:b`,
    ]);
    expect(r.lane?.total).toBe(2);
  });

  test("a table with more observations than are read is a cut gap", () => {
    const d = db();
    for (let i = 0; i < SCHEMA_READ_ROW_CAP + 1; i++) {
      const columns = [col("a", "NUMBER", true)];
      if (i % 2 === 1) columns.push(col("b", "TEXT", true));
      observe(d, MODEL, columns, OPEN - 10 * H + i);
    }
    const r = run(d, [MODEL]);
    const cut = r.gaps.find((g) => g.detail.includes("more recorded schema observations"));
    expect(cut?.detail).toContain(MODEL);
    expect(r.lane?.total).toBeGreaterThan(0);
  });

  test("more tables than the key cap examines only the first ones and says so", () => {
    const d = db();
    const ups = Array.from({ length: SCHEMA_KEY_CAP + 5 }, (_, i) =>
      lineage(`raw.s.t${String(i)}`),
    );
    const r = run(d, [MODEL], ups);
    const capGap = r.gaps.find((g) =>
      g.detail.includes(`only the first ${String(SCHEMA_KEY_CAP)}`),
    );
    expect(capGap?.detail).toContain(`${String(SCHEMA_KEY_CAP + 6)} monitored and upstream tables`);
    const none = r.gaps.find((g) => g.detail.includes("No schema history"));
    expect(none?.detail).toContain(`${String(SCHEMA_KEY_CAP)} of ${String(SCHEMA_KEY_CAP)} tables`);
    expect(none?.detail).toContain(`and ${String(SCHEMA_KEY_CAP - 3)} more`);
  });
});
