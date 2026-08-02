import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { collectIndexMetrics } from "./metrics.ts";

test("body and fts index bytes grow with indexed prose", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);

  const empty = collectIndexMetrics(d);
  expect(empty.bodyBytes).toBe(0);
  // FTS5's shadow `_data` table always carries a small fixed-size structure
  // record (segment/config bookkeeping) even with zero indexed rows, so an
  // empty index is a small constant, not exactly 0 bytes.
  expect(empty.ftsIndexBytes).toBeGreaterThanOrEqual(0);
  expect(empty.ftsIndexBytes).toBeLessThan(1_000);

  for (let i = 0; i < 50; i++) {
    upsertIndexedItem(d, {
      service: "slack",
      type: "message",
      externalId: String(i),
      title: `t${String(i)}`,
      body: `word${String(i)} `.repeat(400),
      modifiedAt: 1,
      syncedAt: 1,
    });
  }

  const filled = collectIndexMetrics(d);
  expect(filled.bodyBytes).toBeGreaterThan(50_000);
  expect(filled.ftsIndexBytes).toBeGreaterThan(empty.ftsIndexBytes);
  d.close();
});
