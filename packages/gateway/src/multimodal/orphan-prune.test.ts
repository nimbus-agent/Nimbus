import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { pruneOrphanedUnderstandings } from "./orphan-prune.ts";

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
});
