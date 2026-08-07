import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItem } from "./item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function freshIndexedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("upsertIndexedItem derives resolve_key from canonicalUrl", () => {
  const db = freshIndexedDb();
  upsertIndexedItem(db, {
    service: "github",
    type: "pull_request",
    externalId: "pr-1",
    title: "t",
    bodyPreview: "b",
    url: "https://github.com/o/r/pull/1#discussion",
    canonicalUrl: "https://github.com/o/r/pull/1",
    modifiedAt: 1,
    syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='github:pr-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe("https://github.com/o/r/pull/1");
  db.close();
});

test("upsertIndexedItem falls back to url when canonicalUrl is absent", () => {
  const db = freshIndexedDb();
  upsertIndexedItem(db, {
    service: "jenkins",
    type: "build",
    externalId: "b-1",
    title: "t",
    bodyPreview: "b",
    url: "https://ci.example.com/job/x/12/?utm_source=mail",
    modifiedAt: 1,
    syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='jenkins:b-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe("https://ci.example.com/job/x/12");
  db.close();
});

test("upsertIndexedItem leaves resolve_key NULL when both urls are null", () => {
  const db = freshIndexedDb();
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "research_brief",
    externalId: "brief-1",
    title: "t",
    body: "b",
    url: null,
    canonicalUrl: null,
    modifiedAt: 1,
    syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='nimbus:brief-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBeNull();
  db.close();
});
