import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
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

  /**
   * `json_extract` RAISES on malformed JSON, and `COALESCE` does not guard it (see the module doc
   * on `orphan-prune.ts`). This sweep runs FIRST at pass start, so before the `json_valid` guard, a
   * single row like this one would have thrown out of the whole statement and aborted the ENTIRE
   * sweep — hiding the real orphan seeded alongside it, and hiding every other orphan in the index
   * besides.
   */
  test("a malformed-metadata row does not abort the sweep, and a real orphan alongside it is still pruned", () => {
    insert(db, "nimbus:bad:understanding", "nimbus", "image_understanding", {});
    db.run("UPDATE item SET metadata = '{not json' WHERE id = 'nimbus:bad:understanding'");
    insert(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1", // source item does not exist -- a real orphan
    });

    let pruned = -1;
    expect(() => {
      pruned = pruneOrphanedUnderstandings(db);
    }).not.toThrow();
    expect(pruned).toBe(1);

    // The malformed row survives: an unparseable `derivedFrom` reads as absent, same as the
    // "no derivedFrom" case above -- KEPT, never deleted on a guess.
    expect(
      db.query("SELECT COUNT(*) AS n FROM item WHERE id = 'nimbus:bad:understanding'").get(),
    ).toEqual({ n: 1 });
    // The real orphan is gone.
    expect(
      db.query("SELECT COUNT(*) AS n FROM item WHERE id = 'nimbus:vid1:understanding'").get(),
    ).toEqual({ n: 0 });
  });
});

describe("pruneOrphanedMedia", () => {
  test("sweeps derived rows AND grants in one pass-start call", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    // Seed an orphaned understanding row — source doesn't exist.
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "video_understanding",
      externalId: "nimbus:vid1:understanding",
      title: "understanding",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { derivedFrom: "filesystem:vid1" },
    });

    // Seed an orphaned grant — item doesn't exist.
    const orphanGrantBefore = listActiveGrants(db).length;
    createGrant(db, {
      itemId: "orphan-grant-item",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1,
    });
    const orphanGrantAfter = listActiveGrants(db).length;
    expect(orphanGrantAfter).toBe(orphanGrantBefore + 1);

    // Seed a LIVE item with an active grant — should survive the sweep.
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "media_av",
      externalId: "filesystem:vid2",
      title: "vid2",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: {},
    });
    createGrant(db, {
      itemId: "filesystem:vid2",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1,
    });

    // Count understanding rows before sweep.
    const understandingsBefore = (
      db
        .query(
          "SELECT COUNT(*) as n FROM item WHERE type IN ('image_understanding', 'video_understanding')",
        )
        .get() as { n: number }
    ).n;
    expect(understandingsBefore).toBe(1);

    // Count active grants before sweep.
    const grantsBefore = listActiveGrants(db).length;
    expect(grantsBefore).toBe(2);

    // Run the sweep.
    const out = pruneOrphanedMedia(db, 5000);

    // Assert sweep returned correct counts of actual orphans pruned (not FTS cascade counts).
    expect(out.understandings).toBe(1);
    expect(out.grants).toBe(1);

    // Count understanding rows after sweep — the orphaned one should be gone.
    const understandingsAfter = (
      db
        .query(
          "SELECT COUNT(*) as n FROM item WHERE type IN ('image_understanding', 'video_understanding')",
        )
        .get() as { n: number }
    ).n;
    expect(understandingsAfter).toBe(0);

    // Assert the live grant survives and the orphaned one is revoked.
    const grantsAfter = listActiveGrants(db);
    expect(grantsAfter).toHaveLength(1);
    expect(grantsAfter[0]!.itemId).toBe("filesystem:vid2");

    db.close();
  });
});
