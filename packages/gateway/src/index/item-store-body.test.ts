import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { BODY_MAX_PROSE } from "./body-caps.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function read(d: Database, id: string) {
  return d.query("SELECT body, body_preview, body_complete FROM item WHERE id = ?").get(id) as {
    body: string | null;
    body_preview: string | null;
    body_complete: number;
  };
}

const base = {
  service: "slack",
  type: "message",
  externalId: "1",
  title: "a title",
  modifiedAt: 1,
  syncedAt: 1,
};

test("a declared-full prose body is stored whole and marked complete", () => {
  const d = db();
  const body = "x".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body).toBe(body);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(1);
  d.close();
});

test("body_preview is always the first 512 code units of body", () => {
  const d = db();
  const body = "y".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body_preview).toBe(row.body?.slice(0, 512) ?? null);
  d.close();
});

test("a prose body over 16 KiB is clamped and marked incomplete", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "z".repeat(BODY_MAX_PROSE + 100) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(BODY_MAX_PROSE);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a non-prose type is still clamped at 512 even when declared full", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "aws",
    type: "resource",
    body: "w".repeat(4000),
  });

  const row = read(d, "aws:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("the legacy bodyPreview path clamps at 512 and never claims completeness", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, bodyPreview: "v".repeat(4000) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("an item with no body at all falls back to its title", () => {
  const d = db();
  upsertIndexedItem(d, base);

  const row = read(d, "slack:1");
  expect(row.body).toBe("a title");
  expect(row.body_preview).toBe("a title");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a full body is keyword-searchable past the 512-character mark", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    body: `${"filler ".repeat(600)}kumquat`,
  });

  const hits = d.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'kumquat'").all() as Array<{
    rowid: number;
  }>;
  expect(hits).toHaveLength(1);
  d.close();
});

test("re-upserting a shorter body shrinks both columns", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "q".repeat(4000) });
  upsertIndexedItem(d, { ...base, body: "short" });

  const row = read(d, "slack:1");
  expect(row.body).toBe("short");
  expect(row.body_preview).toBe("short");
  d.close();
});
