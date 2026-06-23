import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import {
  getShareRecord,
  insertShareRecord,
  listShareRecords,
  pruneExpiredShares,
} from "./share-store.ts";

function freshDb() {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const rec = (over: Partial<Parameters<typeof insertShareRecord>[1]> = {}) => ({
  contentHash: "h1",
  kind: "transcript",
  sessionId: "s1",
  createdAt: 100,
  expiresAt: null,
  redactionSet: ["secrets"],
  provenance: { hops: 0, chain: [] },
  bodyJson: "{}",
  sigJson: "{}",
  sink: "file",
  ...over,
});

describe("share-store", () => {
  test("insert + get by content hash", () => {
    const db = freshDb();
    insertShareRecord(db, rec());
    const got = getShareRecord(db, "h1");
    expect(got?.kind).toBe("transcript");
    db.close();
  });

  test("list excludes expired by default, includes with includeExpired", () => {
    const db = freshDb();
    insertShareRecord(db, rec({ contentHash: "live", expiresAt: null }));
    insertShareRecord(db, rec({ contentHash: "dead", expiresAt: 1 }));
    expect(listShareRecords(db, { now: 1000 }).map((r) => r.contentHash)).toEqual(["live"]);
    expect(listShareRecords(db, { now: 1000, includeExpired: true })).toHaveLength(2);
    db.close();
  });

  test("prune removes expired rows", () => {
    const db = freshDb();
    insertShareRecord(db, rec({ contentHash: "dead", expiresAt: 1 }));
    expect(pruneExpiredShares(db, 1000)).toBe(1);
    expect(getShareRecord(db, "dead")).toBeUndefined();
    db.close();
  });
});
