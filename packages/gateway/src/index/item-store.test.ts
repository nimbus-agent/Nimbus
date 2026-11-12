import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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
      { db, depth },
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

test("upsertIndexedItemForSync schedules an embedding for a pr row and never for a cost_allocation row", () => {
  const db = freshIndexedDb();
  const scheduled: string[] = [];
  const deps = {
    db,
    depth: "full" as const,
    scheduleItemEmbedding: (id: string) => scheduled.push(id),
  };
  const base = { title: "t", bodyPreview: "b", modifiedAt: 1, syncedAt: 1 };
  upsertIndexedItemForSync(deps, { ...base, service: "github", type: "pr", externalId: "1" });
  upsertIndexedItemForSync(deps, {
    ...base,
    service: "vantage",
    type: "cost_allocation",
    externalId: "default:abc:2026-11-01",
  });
  upsertIndexedItemForSync(deps, {
    ...base,
    service: "vantage",
    type: "cost_recommendation",
    externalId: "rec_1",
  });
  expect(scheduled).toEqual(["github:1", "vantage:rec_1"]);
  expect((db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(3);
  db.close();
});

// ── Item history (Phase 10 IC1, schema V94) ─────────────────────────────────────────────────────

import { describe } from "bun:test";
import { replaceItemSetRows } from "./item-set-store.ts";
import {
  deleteAllItemsForService,
  deleteItemByPrimaryKey,
  deleteItemByServiceExternal,
  upsertNimbusItemIntoItemTable,
} from "./item-store.ts";

function prRow(state: string, syncedAt: number, extra: Record<string, unknown> = {}) {
  return {
    service: "github",
    type: "pr",
    externalId: "o/r#1",
    title: "t",
    modifiedAt: syncedAt,
    syncedAt,
    metadata: { state, merged: state === "merged", ...extra },
  };
}

function historyKeys(db: Database): string[] {
  return (db.query("SELECT key FROM item_history ORDER BY id").all() as { key: string }[]).map(
    (r) => r.key,
  );
}

/** The existence markers only: a deletion also writes `key -> NULL` rows for the tracked values it carried. */
function lifecycleKeys(db: Database): string[] {
  return historyKeys(db).filter((k) => k.startsWith("__"));
}

describe("item history writer wiring", () => {
  test("a tracked pair writes __created, then the change row", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    expect(historyKeys(db)).toEqual(["__created"]);
    upsertIndexedItem(db, prRow("closed", 20));
    expect(historyKeys(db)).toEqual(["__created", "state"]);
    db.close();
  });

  test("the item and its change row are one unit: a failing history insert rolls the item back", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    db.run(
      `CREATE TRIGGER boom BEFORE INSERT ON item_history
       BEGIN SELECT RAISE(ABORT, 'history down'); END`,
    );
    expect(() => upsertIndexedItem(db, prRow("closed", 20))).toThrow();
    const row = db.query("SELECT metadata, synced_at FROM item WHERE id='github:o/r#1'").get() as {
      metadata: string;
      synced_at: number;
    };
    expect(JSON.parse(row.metadata).state).toBe("open");
    expect(row.synced_at).toBe(10);
    db.close();
  });

  test("an untracked pair writes no history and runs no extra statement", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "t",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { state: "a" },
    });
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "t",
      modifiedAt: 2,
      syncedAt: 2,
      metadata: { state: "b" },
    });
    expect(historyKeys(db)).toEqual([]);
    db.close();
  });

  test("upsertIndexedItemForSync and upsertNimbusItemIntoItemTable reach the writer", () => {
    const db = freshIndexedDb();
    upsertIndexedItemForSync({ db, depth: "full" }, { ...prRow("open", 10), bodyPreview: "b" });
    expect(historyKeys(db)).toEqual(["__created"]);
    upsertNimbusItemIntoItemTable(
      db,
      {
        id: "github:o/r#2",
        service: "github",
        itemType: "pr",
        name: "n",
        modifiedAt: 5,
        rawMeta: { state: "open" },
      } as unknown as Parameters<typeof upsertNimbusItemIntoItemTable>[1],
      5,
    );
    expect(historyKeys(db)).toEqual(["__created", "__created"]);
    db.close();
  });

  test("deleteItemByPrimaryKey writes __deleted for a tracked item, nothing for others", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "t",
      modifiedAt: 1,
      syncedAt: 1,
    });
    deleteItemByPrimaryKey(db, "slack:m1");
    deleteItemByPrimaryKey(db, "missing:id");
    expect(historyKeys(db)).toEqual(["__created"]);
    deleteItemByPrimaryKey(db, "github:o/r#1", 77);
    const last = db
      .query("SELECT key, observed_at_ms FROM item_history WHERE key = '__deleted'")
      .get();
    expect(last).toEqual({ key: "__deleted", observed_at_ms: 77 });
    expect(
      db.query("SELECT key, old_value, new_value FROM item_history WHERE key = 'state'").get(),
    ).toEqual({ key: "state", old_value: "open", new_value: null });
    db.close();
  });

  test("a failing item delete leaves no __deleted row and keeps the graph entity (one transaction)", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    db.run(
      "INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service) VALUES ('g1','pr','github:o/r#1','l','github')",
    );
    db.run(
      "CREATE TRIGGER no_item_delete BEFORE DELETE ON item BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    expect(() => deleteItemByPrimaryKey(db, "github:o/r#1", 77)).toThrow();
    expect(historyKeys(db)).toEqual(["__created"]);
    expect(
      db.query("SELECT count(*) AS n FROM graph_entity WHERE external_id = 'github:o/r#1'").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("a failing history erasure rolls back the whole service erasure, graph entities included", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    db.run(
      "INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service) VALUES ('g1','pr','github:o/r#1','l','github')",
    );
    db.run(
      "CREATE TRIGGER no_hist_delete BEFORE DELETE ON item_history BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    expect(() => deleteAllItemsForService(db, "github")).toThrow();
    expect(db.query("SELECT count(*) AS n FROM item").get()).toEqual({ n: 1 });
    expect(
      db.query("SELECT count(*) AS n FROM graph_entity WHERE external_id = 'github:o/r#1'").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("deleteItemByServiceExternal inherits the __deleted row", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    deleteItemByServiceExternal(db, "github", "o/r#1");
    expect(lifecycleKeys(db)).toEqual(["__created", "__deleted"]);
    db.close();
  });

  test("replaceItemSetRows reaches the delete path; its swept types are untracked, so no rows", () => {
    // No type replaceItemSetRows may sweep is in the tracked set today; if one is added, the sweep
    // writes __deleted through deleteItemByPrimaryKey with no further change.
    const db = freshIndexedDb();
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "oncall_shift",
      externalId: "s1",
      title: "t",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(replaceItemSetRows(db, "pagerduty", "oncall_shift", [])).toBe(1);
    expect(historyKeys(db)).toEqual([]);
    db.close();
  });

  test("deleteAllItemsForService is an erasure: the service's history goes, no __deleted rows", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "J-1",
      title: "t",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { status: "Open" },
    });
    deleteAllItemsForService(db, "github");
    expect(db.query("SELECT service FROM item_history").all()).toEqual([{ service: "jira" }]);
    db.close();
  });

  test("a re-created item yields __created, __deleted, __created", () => {
    const db = freshIndexedDb();
    upsertIndexedItem(db, prRow("open", 10));
    deleteItemByPrimaryKey(db, "github:o/r#1", 20);
    upsertIndexedItem(db, prRow("open", 30));
    expect(lifecycleKeys(db)).toEqual(["__created", "__deleted", "__created"]);
    db.close();
  });
});
