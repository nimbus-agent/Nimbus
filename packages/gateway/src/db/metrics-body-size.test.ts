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

test("bodyBytes measures UTF-8 bytes, not characters", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);

  const multiByteBody = "héllo wörld 日本語";
  // Sanity-check the fixture itself: this string must actually differ in
  // char-length vs. byte-length, or the assertion below would pass for the
  // wrong reason.
  expect(multiByteBody.length).toBeLessThan(Buffer.byteLength(multiByteBody, "utf8"));

  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "mb1",
    title: "multi-byte",
    body: multiByteBody,
    modifiedAt: 1,
    syncedAt: 1,
  });

  const m = collectIndexMetrics(d);
  expect(m.bodyBytes).toBe(Buffer.byteLength(multiByteBody, "utf8"));
  expect(m.bodyBytes).not.toBe(multiByteBody.length);
  d.close();
});
