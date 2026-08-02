import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { ftsMatchQuery } from "../search/hybrid-internal.ts";
import { buildItemListSql } from "./item-list-query.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function seeded(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: "b".repeat(4000),
    modifiedAt: 1,
    syncedAt: 1,
  });
  return d;
}

test("the item list read does not carry the full body", () => {
  const d = seeded();
  const { sql, vals } = buildItemListSql({ limit: 10 });
  const rows = d.query(sql).all(...vals) as Array<Record<string, unknown>>;

  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("body");
  expect(rows[0]?.["body_preview"]).toHaveLength(512);
  d.close();
});

test("a full body is findable through the hybrid fts match past 512 chars", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: `${"filler ".repeat(600)}kumquat`,
    modifiedAt: 1,
    syncedAt: 1,
  });

  // ftsMatchQuery builds a column-qualified MATCH; an unknown column throws.
  const rows = d
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH ?")
    .all(ftsMatchQuery("kumquat")) as Array<{ rowid: number }>;

  expect(rows).toHaveLength(1);
  d.close();
});
