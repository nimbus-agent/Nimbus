import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  countIndexedItems,
  deleteAllItemsForService,
  deleteItemByServiceExternal,
  indexedItemExists,
  itemExternalIdFromInput,
  listDistinctMetadataValues,
  selectItemMetadataJson,
  upsertIndexedItem,
  upsertIndexedItemForSync,
  upsertNimbusItemIntoItemTable,
} from "./item-store.ts";
import { LocalIndex } from "./local-index.ts";

function openDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

type StoredRow = {
  body: string | null;
  body_preview: string | null;
  body_complete: number;
  pinned: number;
  modified_at: number;
  metadata: string | null;
  external_id: string;
};

function readRow(db: Database, id: string): StoredRow | null {
  return db
    .query(
      "SELECT body, body_preview, body_complete, pinned, modified_at, metadata, external_id FROM item WHERE id = ?",
    )
    .get(id) as StoredRow | null;
}

describe("itemExternalIdFromInput", () => {
  test("strips the service's own prefix", () => {
    expect(itemExternalIdFromInput("github", "github:acme/api#1")).toBe("acme/api#1");
  });

  test("leaves another service's prefix, and an unprefixed id, untouched", () => {
    expect(itemExternalIdFromInput("github", "gitlab:grp/api!2")).toBe("gitlab:grp/api!2");
    expect(itemExternalIdFromInput("github", "acme/api#1")).toBe("acme/api#1");
  });
});

describe("upsertIndexedItem", () => {
  test("pinned: true is stored as 1, and an omitted pin as 0", () => {
    const db = openDb();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "p1",
      title: "pinned one",
      modifiedAt: 1,
      syncedAt: 1,
      pinned: true,
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "p2",
      title: "unpinned one",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(readRow(db, "github:p1")?.pinned).toBe(1);
    expect(readRow(db, "github:p2")?.pinned).toBe(0);
    db.close();
  });

  test("metadata over the 64 KB cap is refused before anything is written", () => {
    const db = openDb();
    expect(() =>
      upsertIndexedItem(db, {
        service: "github",
        type: "pr",
        externalId: "huge",
        title: "huge",
        modifiedAt: 1,
        syncedAt: 1,
        metadata: { blob: "x".repeat(70_000) },
      }),
    ).toThrow('metadata for item "github:huge" exceeds 64 KB limit');
    expect(readRow(db, "github:huge")).toBeNull();
    db.close();
  });
});

describe("upsertIndexedItemForSync at summary depth", () => {
  const base = {
    service: "notion",
    type: "page",
    title: "Quarterly plan",
    modifiedAt: 5,
    syncedAt: 6,
  };

  test("a declared-full body is demoted to a preview that never claims completeness", () => {
    const db = openDb();
    upsertIndexedItemForSync(
      { db, depth: "summary" },
      { ...base, externalId: "full-body", body: "short complete body" },
    );
    const row = readRow(db, "notion:full-body");
    expect(row?.body).toBe("short complete body");
    expect(row?.body_preview).toBe("short complete body");
    expect(row?.body_complete).toBe(0);
    db.close();
  });

  test("a legacy preview passes through as the preview", () => {
    const db = openDb();
    upsertIndexedItemForSync(
      { db, depth: "summary" },
      { ...base, externalId: "preview", bodyPreview: "legacy preview text" },
    );
    const row = readRow(db, "notion:preview");
    expect(row?.body_preview).toBe("legacy preview text");
    expect(row?.body_complete).toBe(0);
    db.close();
  });

  test("no body input at all stores an empty body, not the title", () => {
    const db = openDb();
    upsertIndexedItemForSync({ db, depth: "summary" }, { ...base, externalId: "none" });
    const row = readRow(db, "notion:none");
    expect(row?.body).toBe("");
    expect(row?.body_preview).toBe("");
    expect(row?.body_complete).toBe(0);
    db.close();
  });

  test("the sync wrapper schedules the item's embedding by its primary key", () => {
    const db = openDb();
    const scheduled: string[] = [];
    upsertIndexedItemForSync(
      { db, depth: "full", scheduleItemEmbedding: (id) => scheduled.push(id) },
      { ...base, externalId: "embed-me", body: "x" },
    );
    expect(scheduled).toEqual(["notion:embed-me"]);
    db.close();
  });
});

describe("upsertNimbusItemIntoItemTable", () => {
  test("file facts are folded into metadata, and createdAt stands in for a missing modifiedAt", () => {
    const db = openDb();
    upsertNimbusItemIntoItemTable(
      db,
      {
        id: "filesystem:/notes/a.md",
        service: "filesystem",
        itemType: "file",
        name: "a.md",
        mimeType: "text/markdown",
        sizeBytes: 2048,
        parentId: "/notes",
        createdAt: 1_700_000_000_000,
        rawMeta: { encoding: "utf8" },
      },
      99,
    );
    const row = readRow(db, "filesystem:/notes/a.md");
    expect(row?.external_id).toBe("/notes/a.md");
    expect(row?.modified_at).toBe(1_700_000_000_000);
    expect(JSON.parse(row?.metadata ?? "null")).toEqual({
      encoding: "utf8",
      mime_type: "text/markdown",
      size_bytes: 2048,
      parent_id: "/notes",
      created_at: 1_700_000_000_000,
    });
    db.close();
  });

  test("an item with no times and no file facts stores modified_at 0 and empty metadata", () => {
    const db = openDb();
    upsertNimbusItemIntoItemTable(
      db,
      { id: "bare", service: "filesystem", itemType: "file", name: "bare.txt" },
      1,
    );
    const row = readRow(db, "filesystem:bare");
    expect(row?.modified_at).toBe(0);
    expect(JSON.parse(row?.metadata ?? "null")).toEqual({});
    db.close();
  });

  test("a url on the item is stored, and modifiedAt wins over createdAt", () => {
    const db = openDb();
    upsertNimbusItemIntoItemTable(
      db,
      {
        id: "doc-1",
        service: "notion",
        itemType: "page",
        name: "Doc",
        url: "https://notion.so/doc-1",
        modifiedAt: 500,
        createdAt: 100,
      },
      1,
    );
    const got = db.query("SELECT url, modified_at FROM item WHERE id = 'notion:doc-1'").get() as {
      url: string | null;
      modified_at: number;
    };
    expect(got).toEqual({ url: "https://notion.so/doc-1", modified_at: 500 });
    db.close();
  });
});

describe("deleteAllItemsForService", () => {
  test("removes every item of one service and leaves other services alone", () => {
    const db = openDb();
    for (const [service, externalId] of [
      ["github", "a"],
      ["github", "b"],
      ["gitlab", "c"],
    ] as const) {
      upsertIndexedItem(db, {
        service,
        type: "pr",
        externalId,
        title: externalId,
        modifiedAt: 1,
        syncedAt: 1,
      });
    }
    deleteAllItemsForService(db, "github");
    expect(countIndexedItems(db, "github", "pr")).toBe(0);
    expect(countIndexedItems(db, "gitlab", "pr")).toBe(1);
    // A service with nothing indexed is a no-op.
    deleteAllItemsForService(db, "jira");
    expect(countIndexedItems(db, "gitlab", "pr")).toBe(1);
    db.close();
  });
});

describe("small item readers", () => {
  function seed(db: Database, externalId: string, metadata: Record<string, unknown>): void {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId,
      title: externalId,
      modifiedAt: 1,
      syncedAt: 1,
      metadata,
    });
  }

  test("countIndexedItems counts one service+type, and an empty slice is 0", () => {
    const db = openDb();
    seed(db, "a", {});
    seed(db, "b", {});
    expect(countIndexedItems(db, "github", "pr")).toBe(2);
    expect(countIndexedItems(db, "github", "issue")).toBe(0);
    db.close();
  });

  test("indexedItemExists and selectItemMetadataJson see present and absent items", () => {
    const db = openDb();
    seed(db, "a", { repo: "acme/api" });
    expect(indexedItemExists(db, "github:a")).toBe(true);
    expect(indexedItemExists(db, "github:missing")).toBe(false);
    expect(selectItemMetadataJson(db, "github:a")).toBe('{"repo":"acme/api"}');
    expect(selectItemMetadataJson(db, "github:missing")).toBeNull();
    db.close();
  });

  test("deleteItemByServiceExternal removes exactly the addressed item", () => {
    const db = openDb();
    seed(db, "a", {});
    seed(db, "b", {});
    deleteItemByServiceExternal(db, "github", "a");
    expect(indexedItemExists(db, "github:a")).toBe(false);
    expect(indexedItemExists(db, "github:b")).toBe(true);
    // An item that is not there is a no-op, not an error, and touches nothing else.
    deleteItemByServiceExternal(db, "github", "never-indexed");
    expect(countIndexedItems(db, "github", "pr")).toBe(1);
    db.close();
  });

  test("listDistinctMetadataValues trims, dedupes, and drops whitespace SQLite's trim keeps", () => {
    const db = openDb();
    seed(db, "a", { repo: "acme/api" });
    seed(db, "b", { repo: "acme/api" });
    seed(db, "c", { repo: " acme/web " });
    // SQLite's trim() strips only spaces, so a tab/newline-only value survives the SQL filter and
    // must be dropped by the JS-side trim.
    seed(db, "d", { repo: "\t\n" });
    seed(db, "e", { repo: "   " });
    seed(db, "f", { other: "x" });
    expect(listDistinctMetadataValues(db, "github", "repo").sort()).toEqual([
      "acme/api",
      "acme/web",
    ]);
    db.close();
  });

  test("listDistinctMetadataValues refuses a key that is not a plain identifier", () => {
    const db = openDb();
    expect(() => listDistinctMetadataValues(db, "github", "repo') OR 1=1 --")).toThrow(
      /unsafe metadata key/,
    );
    expect(() => listDistinctMetadataValues(db, "github", "1repo")).toThrow(/unsafe metadata key/);
    expect(listDistinctMetadataValues(db, "github", "_repo2")).toEqual([]);
    db.close();
  });
});
