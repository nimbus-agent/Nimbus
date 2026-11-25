import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { deleteAllItemsForService, upsertIndexedItem } from "./item-store.ts";
import { diffColumns, readSchemaHistory } from "./schema-diff.ts";
import {
  deleteSchemaHistoryForService,
  pruneSchemaHistory,
  recordSchemaObservation,
} from "./schema-history.ts";
import { runSchemaHistoryPrune } from "./schema-history-retention.ts";
import {
  isSchemaTracked,
  SCHEMA_COLUMN_CAP,
  type SchemaColumn,
  schemaObservationOf,
} from "./schema-history-source.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const KEY = "analytics.public.orders";
const col = (name: string, type: string | null = "NUMBER", nullable: boolean | null = true) => ({
  name,
  type,
  nullable,
});
const obs = (columns: SchemaColumn[] | null, key = KEY, service = "snowflake") => ({
  service,
  key,
  columns,
});
const count = (d: Database): number =>
  (d.query("SELECT COUNT(*) AS n FROM schema_history").get() as { n: number }).n;
const H = 3_600_000;

describe("schemaObservationOf", () => {
  const meta = (o: Record<string, unknown>): string => JSON.stringify(o);

  test("only the two warehouse pairs are tracked", () => {
    expect(isSchemaTracked("snowflake", "data_model")).toBe(true);
    expect(isSchemaTracked("bigquery", "table")).toBe(true);
    expect(isSchemaTracked("looker", "data_model")).toBe(false);
    expect(schemaObservationOf("github", "pr", meta({ dataModelKey: "a" }))).toBeUndefined();
  });

  test("a Snowflake item is complete only when the connector said so, and is sorted by name", () => {
    const columns = [col("B"), col("A", "TEXT", false)];
    const done = schemaObservationOf(
      "snowflake",
      "data_model",
      meta({ dataModelKey: KEY, columns, columnsComplete: true }),
    );
    expect(done?.columns?.map((c) => c.name)).toEqual(["A", "B"]);
    for (const m of [{ columns }, { columns, columnsComplete: false }]) {
      const o = schemaObservationOf("snowflake", "data_model", meta({ dataModelKey: KEY, ...m }));
      expect(o).toEqual({ service: "snowflake", key: KEY, columns: null });
    }
  });

  test("a BigQuery item reads schemaFields and schemaComplete", () => {
    const o = schemaObservationOf(
      "bigquery",
      "table",
      meta({ dataModelKey: "p.d.t", schemaFields: [col("x", "STRING")], schemaComplete: true }),
    );
    expect(o?.columns).toEqual([col("x", "STRING")]);
    expect(
      schemaObservationOf(
        "bigquery",
        "table",
        meta({ dataModelKey: "p.d.t", schemaFields: [], schemaComplete: false }),
      )?.columns,
    ).toBeNull();
  });

  test("a missing key, bad JSON, a bad column, a duplicate name or a cut set", () => {
    expect(schemaObservationOf("snowflake", "data_model", meta({ columns: [] }))).toBeUndefined();
    expect(schemaObservationOf("snowflake", "data_model", "{not json")).toBeUndefined();
    expect(schemaObservationOf("snowflake", "data_model", "[1]")).toBeUndefined();
    const base = { dataModelKey: KEY, columnsComplete: true };
    for (const columns of [
      [{ type: "T" }],
      ["x"],
      [col("A"), col("A", "TEXT")],
      Array.from({ length: SCHEMA_COLUMN_CAP + 1 }, (_, i) => col(`c${String(i)}`)),
      "nope",
    ]) {
      expect(
        schemaObservationOf("snowflake", "data_model", meta({ ...base, columns }))?.columns,
      ).toBeNull();
    }
  });
});

describe("diffColumns", () => {
  test("added, dropped, type and nullability changes, in a stable order", () => {
    const before = [col("a", "INT", true), col("b", "TEXT", true), col("gone", "INT", false)];
    const after = [col("a", "BIGINT", false), col("b", "TEXT", true), col("new", "DATE", null)];
    const d = diffColumns(before, after);
    expect(d.map((c) => `${c.kind}:${c.column}`)).toEqual([
      "nullability_changed:a",
      "type_changed:a",
      "dropped:gone",
      "added:new",
    ]);
    expect(d.find((c) => c.kind === "type_changed")).toMatchObject({
      fromType: "INT",
      toType: "BIGINT",
    });
    expect(d.find((c) => c.kind === "dropped")).toMatchObject({ fromType: "INT", toType: null });
    expect(diffColumns(after, after)).toEqual([]);
  });
});

describe("recordSchemaObservation", () => {
  test("a first observation is a baseline row; an unchanged set writes nothing", () => {
    const d = db();
    expect(recordSchemaObservation(d, obs([col("a")]), 1)).toBe(true);
    expect(recordSchemaObservation(d, obs([col("a")]), 2)).toBe(false);
    expect(count(d)).toBe(1);
    expect(recordSchemaObservation(d, obs([col("a"), col("b")]), 3)).toBe(true);
    expect(count(d)).toBe(2);
  });

  test("an incomplete observation is one row, never repeated, and has no columns", () => {
    const d = db();
    expect(recordSchemaObservation(d, obs(null), 1)).toBe(true);
    expect(recordSchemaObservation(d, obs(null), 2)).toBe(false);
    expect(
      d.query("SELECT complete, columns_json, column_count FROM schema_history").all(),
    ).toEqual([{ complete: 0, columns_json: null, column_count: null }]);
    // the same set after an incomplete one is recorded again, so the gap is bracketed
    expect(recordSchemaObservation(d, obs([col("a")]), 3)).toBe(true);
    expect(recordSchemaObservation(d, obs(null), 4)).toBe(true);
  });

  test("tables of two services with one key do not share a latest row", () => {
    const d = db();
    recordSchemaObservation(d, obs([col("a")], KEY, "snowflake"), 1);
    expect(recordSchemaObservation(d, obs([col("a")], KEY, "bigquery"), 1)).toBe(true);
  });

  test("the table's CHECK refuses a complete row with no columns", () => {
    const d = db();
    expect(() =>
      d.run(
        "INSERT INTO schema_history (service, data_model_key, observed_at_ms, complete) VALUES ('s','k',1,1)",
      ),
    ).toThrow();
  });
});

describe("readSchemaHistory", () => {
  const seed = (d: Database): void => {
    recordSchemaObservation(d, obs([col("a", "INT")]), 1 * H);
    recordSchemaObservation(d, obs([col("a", "INT"), col("b", "TEXT")]), 10 * H);
    recordSchemaObservation(d, obs([col("b", "TEXT")]), 20 * H);
  };

  test("diffs adjacent complete observations whose newer one is inside the window", () => {
    const d = db();
    seed(d);
    const r = readSchemaHistory(d, KEY, { fromMs: 5 * H, toMs: 30 * H });
    expect(r.noHistory).toBe(false);
    expect(
      r.changes.map((c) => `${String(c.atMs / H)}:${c.change.kind}:${c.change.column}`),
    ).toEqual(["10:added:b", "20:dropped:a"]);
    const narrow = readSchemaHistory(d, KEY, { fromMs: 15 * H, toMs: 30 * H });
    expect(narrow.changes.map((c) => c.change.kind)).toEqual(["dropped"]);
    expect(readSchemaHistory(d, KEY, { fromMs: 5 * H, toMs: 15 * H }).changes).toHaveLength(1);
  });

  test("a table with no row reads noHistory; a lone baseline reads no change", () => {
    const d = db();
    expect(readSchemaHistory(d, KEY, { fromMs: 0, toMs: 9 * H }).noHistory).toBe(true);
    recordSchemaObservation(d, obs([col("a")]), 1 * H);
    const r = readSchemaHistory(d, KEY, { fromMs: 0, toMs: 9 * H });
    expect(r).toMatchObject({ noHistory: false, changes: [], incompleteAtMs: [] });
  });

  test("a column missing from an incomplete observation is NEVER reported dropped", () => {
    const d = db();
    recordSchemaObservation(d, obs([col("a"), col("b")]), 1 * H);
    recordSchemaObservation(d, obs(null), 5 * H);
    recordSchemaObservation(d, obs([col("a")]), 9 * H);
    const r = readSchemaHistory(d, KEY, { fromMs: 0, toMs: 20 * H });
    expect(r.changes).toEqual([]);
    expect(r.incompleteAtMs).toEqual([5 * H, 9 * H]);
  });

  test("a first observation that is itself incomplete is a gap", () => {
    const d = db();
    recordSchemaObservation(d, obs(null), 2 * H);
    expect(readSchemaHistory(d, KEY, { fromMs: 0, toMs: 9 * H }).incompleteAtMs).toEqual([2 * H]);
  });

  test("a table with more rows than the read cap says it was cut", () => {
    const d = db();
    for (let i = 0; i < 205; i++) {
      recordSchemaObservation(d, obs([col(`c${String(i)}`)]), i + 1);
    }
    const r = readSchemaHistory(d, KEY, { fromMs: 0, toMs: 1_000 });
    expect(r.cut).toBe(true);
    expect(r.changes.length).toBeGreaterThan(0);
  });
});

describe("the upsert records the observation in its own transaction", () => {
  const put = (d: Database, columns: unknown[], complete: boolean, at: number): void =>
    upsertIndexedItem(d, {
      service: "snowflake",
      type: "data_model",
      externalId: "snowflake:analytics.public.orders",
      title: "public.orders",
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: { dataModelKey: KEY, columns, columnsComplete: complete },
    });

  test("a change is recorded once; a repeated sync adds nothing; an untracked item adds nothing", () => {
    const d = db();
    put(d, [col("a")], true, 1);
    put(d, [col("a")], true, 2);
    put(d, [col("a"), col("b")], true, 3);
    expect(count(d)).toBe(2);
    upsertIndexedItem(d, {
      service: "looker",
      type: "data_model",
      externalId: "looker:x",
      title: "x",
      bodyPreview: "",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { dataModelKey: "x.y.z", columns: [], columnsComplete: true },
    });
    expect(count(d)).toBe(2);
  });

  test("an incomplete column list is recorded as a gap, never as a drop", () => {
    const d = db();
    put(d, [col("a"), col("b")], true, 1 * H);
    put(d, [col("a")], false, 2 * H);
    const r = readSchemaHistory(d, KEY, { fromMs: 0, toMs: 9 * H });
    expect(r.changes).toEqual([]);
    expect(r.incompleteAtMs).toEqual([2 * H]);
  });

  test("an owner erasure of the service removes its schema history", () => {
    const d = db();
    put(d, [col("a")], true, 1);
    put(d, [col("a"), col("b")], true, 2);
    recordSchemaObservation(d, obs([col("z")], "p.d.t", "bigquery"), 1);
    deleteAllItemsForService(d, "snowflake");
    expect(d.query("SELECT service FROM schema_history").all()).toEqual([{ service: "bigquery" }]);
    deleteSchemaHistoryForService(d, "bigquery");
    expect(count(d)).toBe(0);
  });
});

describe("retention", () => {
  test("old rows go, but the newest row of every table stays as the baseline", () => {
    const d = db();
    recordSchemaObservation(d, obs([col("a")]), 1 * H);
    recordSchemaObservation(d, obs([col("a"), col("b")]), 2 * H);
    recordSchemaObservation(d, obs([col("q")], "other.t.u"), 1 * H);
    recordSchemaObservation(d, obs([col("a"), col("b"), col("c")]), 100 * H);
    const r = pruneSchemaHistory(d, { cutoffMs: 50 * H, batchSize: 10, maxBatches: 3 });
    expect(r).toEqual({ deleted: 2, more: false });
    expect(
      d
        .query("SELECT data_model_key AS k, observed_at_ms AS t FROM schema_history ORDER BY id")
        .all(),
    ).toEqual([
      { k: "other.t.u", t: 1 * H },
      { k: KEY, t: 100 * H },
    ]);
  });

  test("a full batch reports more, and the daily pass drains the backlog", async () => {
    const d = db();
    for (let i = 0; i < 7; i++) recordSchemaObservation(d, obs([col(`c${String(i)}`)]), i + 1);
    expect(pruneSchemaHistory(d, { cutoffMs: 1_000, batchSize: 3, maxBatches: 1 })).toEqual({
      deleted: 3,
      more: true,
    });
    const deleted = await runSchemaHistoryPrune(d, {
      retentionDays: 1,
      nowMs: 10 * 24 * H,
      yieldToEventLoop: () => Promise.resolve(),
    });
    expect(deleted).toBe(3);
    expect(count(d)).toBe(1);
  });
});
