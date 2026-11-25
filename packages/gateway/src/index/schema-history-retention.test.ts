import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { recordSchemaObservation } from "./schema-history.ts";
import { runSchemaHistoryPrune, SCHEMA_HISTORY_PRUNE_BATCH } from "./schema-history-retention.ts";
import type { SchemaColumn } from "./schema-history-source.ts";

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
const H = 3_600_000;
const count = (d: Database): number =>
  (d.query("SELECT COUNT(*) AS n FROM schema_history").get() as { n: number }).n;

describe("runSchemaHistoryPrune", () => {
  test("a backlog larger than one batch is drained over several batches, yielding between them", async () => {
    const d = db();
    // Alternate two column sets so every observation is a change and writes a row.
    const rows = SCHEMA_HISTORY_PRUNE_BATCH + 2;
    for (let i = 0; i < rows; i++) {
      const columns: SchemaColumn[] = [{ name: "a", type: "NUMBER", nullable: true }];
      if (i % 2 === 1) columns.push({ name: "b", type: "TEXT", nullable: false });
      recordSchemaObservation(d, { service: "snowflake", key: KEY, columns }, i + 1);
    }
    expect(count(d)).toBe(rows);
    let yields = 0;
    const deleted = await runSchemaHistoryPrune(d, {
      retentionDays: 1,
      nowMs: 10 * 24 * H,
      yieldToEventLoop: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    // every row but the newest (the baseline the next diff is taken against) is older than the cutoff
    expect(deleted).toBe(rows - 1);
    expect(yields).toBe(1);
    expect(count(d)).toBe(1);
  });

  test("nothing older than the cutoff deletes nothing and never yields", async () => {
    const d = db();
    recordSchemaObservation(
      d,
      { service: "snowflake", key: KEY, columns: [{ name: "a", type: null, nullable: null }] },
      5 * H,
    );
    let yields = 0;
    const deleted = await runSchemaHistoryPrune(d, {
      retentionDays: 1,
      nowMs: 6 * H,
      yieldToEventLoop: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(deleted).toBe(0);
    expect(yields).toBe(0);
    expect(count(d)).toBe(1);
  });
});
