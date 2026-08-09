import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { EMPTY_NIMBUS_VAULT, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem, upsertIndexedItemForSync } from "./item-store.ts";
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

test("metadata survives every index depth", () => {
  // `applyDepth` strips only body fields. Metadata passing through at
  // `metadata_only` is correct by that depth's own name — that depth withholds
  // item TEXT, not the connector facts a consumer selects on — and it is the
  // first thing a reviewer will question, so assert it rather than explain it.
  //
  // This is a REGRESSION LOCK, not a driver: it passes on the code as written.
  // If it ever fails, `applyDepth` has started touching metadata and the
  // ticket-depth contract (status_category, meta_v, the lifecycle timestamps)
  // is silently gone below `full`.
  //
  // `depth` MUST come after the spread: `silentSyncContextExtras()` supplies
  // `depth: "full"`, so spreading it last would run all three iterations at
  // `full` and assert nothing.
  const db = freshIndexedDb();
  for (const depth of ["metadata_only", "summary", "full"] as const) {
    upsertIndexedItemForSync(
      { ...syncTestContext(db, EMPTY_NIMBUS_VAULT), depth },
      {
        service: "jira",
        type: "issue",
        externalId: `PROJ-${depth}`,
        title: "t",
        body: "some body text",
        modifiedAt: 1,
        syncedAt: 1,
        metadata: { key: `PROJ-${depth}`, status_category: "done", meta_v: 1 },
      },
    );
    const row = db
      .query("SELECT metadata FROM item WHERE external_id = ?")
      .get(`PROJ-${depth}`) as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["status_category"]).toBe("done");
    expect(meta["meta_v"]).toBe(1);
    expect(meta["key"]).toBe(`PROJ-${depth}`);
  }
  db.close();
});
