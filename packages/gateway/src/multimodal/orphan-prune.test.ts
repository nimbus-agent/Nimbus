import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createGrant, listActiveGrants } from "./media-grant-store.ts";
import { pruneOrphanedMedia, pruneOrphanedUnderstandings } from "./orphan-prune.ts";

function seed(db: Database): void {
  db.exec(`CREATE TABLE item (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, external_id TEXT NOT NULL,
    type TEXT NOT NULL, metadata TEXT
  )`);
}

function insert(db: Database, id: string, service: string, type: string, meta: object): void {
  db.query(
    "INSERT INTO item (id, service, external_id, type, metadata) VALUES (?, ?, ?, ?, ?)",
  ).run(id, service, id, type, JSON.stringify(meta));
}

function insertFull(db: Database, id: string, service: string, type: string, meta: object): void {
  db.query(
    `INSERT INTO item (id, service, external_id, type, title, body_preview, modified_at, synced_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, service, id, type, id, "", 1000, 1000, JSON.stringify(meta));
}

describe("pruneOrphanedUnderstandings", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
  });

  test("deletes a derived row whose source is gone", () => {
    insert(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1",
    });
    expect(pruneOrphanedUnderstandings(db)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 0 });
  });

  test("keeps a derived row whose source still exists", () => {
    insert(db, "filesystem:vid1", "filesystem", "media_av", {});
    insert(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1",
    });
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 2 });
  });

  test("never touches a non-understanding nimbus row", () => {
    insert(db, "nimbus:clip1", "nimbus", "web_clip", { derivedFrom: "gone" });
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 1 });
  });

  test("a derived row with no derivedFrom is left alone rather than deleted", () => {
    insert(db, "nimbus:orphan:understanding", "nimbus", "image_understanding", {});
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
  });
});

describe("pruneOrphanedMedia", () => {
  test("sweeps derived rows AND grants in one pass-start call", () => {
    const db = new Database(":memory:");
    // Set up minimal schema: item table for understanding rows, media_grant for grants.
    db.exec(`
      CREATE TABLE item (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        external_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body_preview TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE TABLE media_grant (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        modality TEXT NOT NULL CHECK (modality IN ('image', 'av')),
        model_vendor TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);

    // Seed an orphaned understanding row — source doesn't exist.
    insertFull(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1",
    });

    // Seed an orphaned grant — item doesn't exist.
    createGrant(db, {
      itemId: "orphan-grant-item",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1,
    });

    // Seed a LIVE item with an active grant — should survive the sweep.
    insertFull(db, "filesystem:vid2", "filesystem", "media_av", {});
    createGrant(db, {
      itemId: "filesystem:vid2",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1,
    });

    // Run the sweep.
    const out = pruneOrphanedMedia(db, 5000);

    // Assert both counts: one understanding, one grant.
    expect(out.understandings).toBe(1);
    expect(out.grants).toBe(1);

    // Assert the live grant survives.
    expect(listActiveGrants(db)).toHaveLength(1);
    expect(listActiveGrants(db)[0].itemId).toBe("filesystem:vid2");

    db.close();
  });
});
