import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { GENESIS_HASH } from "../db/audit-chain.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { type AuditEntry, LocalIndex, RAW_META_MAX_BYTES } from "./local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "./sqlite-vec-load.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function openMemoryIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

describe("LocalIndex", () => {
  test("ensureSchema is idempotent", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    LocalIndex.ensureSchema(db);
    const row = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(row.user_version).toBe(LocalIndex.SCHEMA_VERSION);
  });

  test.skipIf(!VEC_AVAILABLE)(
    "migration 6 creates sqlite-vec table and cascades chunk + vector on item delete",
    () => {
      const db = new Database(":memory:");
      LocalIndex.ensureSchema(db);

      const ver = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(ver.user_version).toBe(LocalIndex.SCHEMA_VERSION);

      const vecMeta = db.query("SELECT vec_version() AS v").get() as { v: string };
      expect(typeof vecMeta.v).toBe("string");
      expect(vecMeta.v.length).toBeGreaterThan(0);

      const now = Date.now();
      upsertIndexedItem(db, {
        service: "filesystem",
        type: "file",
        externalId: "doc1",
        title: "Zurich project notes",
        bodyPreview: "Planning for Zurich",
        modifiedAt: now,
        syncedAt: now,
      });
      const itemId = "filesystem:doc1";
      const vec = new Float32Array(384).fill(0.02);
      db.run(`INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))`, [1n, vec]);
      db.run(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, 'Zurich planning', 1, 'all-MiniLM-L6-v2', 384, ?)`,
        [itemId, now],
      );

      const chunksBefore = db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as {
        c: number;
      };
      expect(chunksBefore.c).toBe(1);

      db.run("DELETE FROM item WHERE id = ?", [itemId]);

      const chunksAfter = db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as {
        c: number;
      };
      expect(chunksAfter.c).toBe(0);

      const vecAfter = db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number };
      expect(vecAfter.c).toBe(0);
    },
  );

  test("upsert and search by name via FTS5", () => {
    const idx = openMemoryIndex();
    idx.upsert({
      id: "a1",
      service: "filesystem",
      itemType: "file",
      name: "Quarterly report Q1.pdf",
    });
    idx.upsert({
      id: "a2",
      service: "filesystem",
      itemType: "file",
      name: "Holiday photos.zip",
    });

    const hits = idx.search({ name: "quarterly report", limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(["a1"]);
  });

  test("searchRanked collapses duplicate canonical_url", () => {
    const idx = openMemoryIndex();
    const db = idx.getDatabase();
    const t = Date.now();
    const canon = "https://example.com/shared";
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "hello world",
      modifiedAt: t,
      syncedAt: t,
      canonicalUrl: canon,
      url: canon,
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "p1",
      title: "hello world thread",
      modifiedAt: t - 1,
      syncedAt: t,
      canonicalUrl: canon,
      url: canon,
    });
    const ranked = idx.searchRanked({ name: "hello", limit: 20 }, {});
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.duplicates?.includes("github")).toBe(true);
  });

  test("getBodyPreview returns indexed preview by primary key", () => {
    const idx = openMemoryIndex();
    const db = idx.getDatabase();
    const t = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "issue",
      externalId: "zaalgol/helpdesk#issue-1",
      title: "add a smoke test",
      bodyPreview: "Create a basic smoke test for the helpdesk app.",
      modifiedAt: t,
      syncedAt: t,
    });

    expect(idx.getBodyPreview("github:zaalgol/helpdesk#issue-1")).toBe(
      "Create a basic smoke test for the helpdesk app.",
    );
    expect(idx.getBodyPreview("github:missing")).toBeUndefined();
  });

  test("search filters by service and itemType", () => {
    const idx = openMemoryIndex();
    idx.upsert({
      id: "x1",
      service: "fs",
      itemType: "file",
      name: "alpha",
    });
    idx.upsert({
      id: "x2",
      service: "other",
      itemType: "file",
      name: "alpha beta",
    });

    const onlyFs = idx.search({ name: "alpha", service: "fs" });
    expect(onlyFs.map((h) => h.id)).toEqual(["x1"]);

    const byType = idx.search({ itemType: "file", limit: 5 });
    expect(byType).toHaveLength(2);
  });

  test("delete removes item", () => {
    const idx = openMemoryIndex();
    idx.upsert({
      id: "d1",
      service: "s",
      itemType: "file",
      name: "gone",
    });
    idx.delete("d1");
    expect(idx.search({ name: "gone" })).toEqual([]);
  });

  test("upsert rejects raw_meta over 64 KiB", () => {
    const idx = openMemoryIndex();
    const big = "x".repeat(RAW_META_MAX_BYTES);
    expect(() =>
      idx.upsert({
        id: "big",
        service: "s",
        itemType: "file",
        name: "n",
        rawMeta: { blob: big },
      }),
    ).toThrow(/exceeds 64 KB/);
  });

  test("recordSync and getLastSyncToken", () => {
    const idx = openMemoryIndex();
    idx.recordSync("filesystem", "token-a");
    expect(idx.getLastSyncToken("filesystem")).toBe("token-a");
    idx.recordSync("filesystem", "token-b");
    expect(idx.getLastSyncToken("filesystem")).toBe("token-b");
    expect(idx.getLastSyncToken("missing")).toBeNull();
  });

  test("recordAudit and listAudit order", () => {
    const idx = openMemoryIndex();
    const e1: Omit<AuditEntry, "id"> = {
      actionType: "file.delete",
      hitlStatus: "rejected",
      actionJson: '{"path":"/home/nimbus-test/a"}',
      timestamp: 100,
    };
    const e2: Omit<AuditEntry, "id"> = {
      actionType: "filesystem.search",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 200,
    };
    idx.recordAudit(e1);
    idx.recordAudit(e2);
    const list = idx.listAudit(10);
    expect(list).toHaveLength(2);
    expect(list[0]?.actionType).toBe("filesystem.search");
    expect(list[1]?.actionType).toBe("file.delete");
  });

  test("recordAudit chains row_hash across successive inserts", () => {
    const db = openMemoryIndex();
    db.recordAudit({ actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    db.recordAudit({ actionType: "b", hitlStatus: "approved", actionJson: "{}", timestamp: 2 });
    const rows = db.listAuditWithChain(10);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.prevHash).toBe(GENESIS_HASH);
    expect(second?.prevHash).toBe(first?.rowHash);
    expect(first?.rowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("connector scheduler registration and persisted statuses", () => {
    const idx = openMemoryIndex();
    const now = 1_700_000_000_000;
    idx.ensureConnectorSchedulerRegistration("google_drive", 60_000, now);
    const rows = idx.persistedConnectorStatuses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceId).toBe("google_drive");
    expect(rows[0]?.intervalMs).toBe(60_000);
    expect(rows[0]?.status).toBe("ok");
    // Registering a connector writes `scheduler_state`, NOT `sync_state` — so nothing has been
    // observed about its credentials yet. This asserted `healthy`, which is the F6 defect seen
    // through `persistedConnectorStatuses`, one of the surfaces it was reported on: a connector
    // the user never set up, presented as working.
    expect(rows[0]?.healthState).toBe("not_configured");
    idx.upsert({
      id: "g1",
      service: "google_drive",
      itemType: "file",
      name: "a",
    });
    expect(idx.persistedConnectorStatuses("google_drive")[0]?.itemCount).toBe(1);
    const deleted = idx.removeConnectorIndexData("google_drive");
    expect(deleted).toBe(1);
    expect(idx.persistedConnectorStatuses()).toEqual([]);
  });
});
