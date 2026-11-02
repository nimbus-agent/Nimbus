import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { deleteLivenessFloor, recordLivenessAccepted } from "./registry-liveness-store.ts";
import { deleteRegistry, insertRegistry } from "./registry-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 80);
});
afterEach(() => db.close());

const f = (sequence: number, sha = "a", key = "K1") => ({
  livenessKey: key,
  sequence,
  documentSha256: sha,
  generatedAt: "2026-11-02T00:00:00Z",
  now: 1,
});

const rows = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM registry_liveness_state").get() as { n: number }).n;

describe("recordLivenessAccepted", () => {
  test("first, higher and identical records are accepted", () => {
    expect(recordLivenessAccepted(db, "r", f(2))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(3, "b"))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(3, "b"))).toBe("accepted");
  });

  test("the same sequence with other content is equivocation", () => {
    recordLivenessAccepted(db, "r", f(3, "b"));
    expect(recordLivenessAccepted(db, "r", f(3, "c"))).toBe("equivocation");
  });

  test("a lower sequence is a rollback", () => {
    recordLivenessAccepted(db, "r", f(3, "b"));
    expect(recordLivenessAccepted(db, "r", f(2, "z"))).toBe("rollback");
  });

  test("a different key at a lower sequence replaces the floor", () => {
    recordLivenessAccepted(db, "r", f(5, "b"));
    expect(recordLivenessAccepted(db, "r", f(1, "n", "K2"))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(1, "n", "K2"))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(0, "m", "K2"))).toBe("rollback");
  });
});

describe("key alternation", () => {
  test("K1@5, K2@1, K1@3 are each accepted", () => {
    expect(recordLivenessAccepted(db, "r", f(5, "a", "K1"))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(1, "b", "K2"))).toBe("accepted");
    expect(recordLivenessAccepted(db, "r", f(3, "c", "K1"))).toBe("accepted");
  });
});

describe("floor deletion", () => {
  test("deleteLivenessFloor removes the row", () => {
    recordLivenessAccepted(db, "r", f(1));
    deleteLivenessFloor(db, "r");
    expect(rows()).toBe(0);
  });

  test("deleteRegistry removes the floor and still reports the registry row", () => {
    insertRegistry(db, {
      name: "r",
      url: "https://r.example/",
      rootKey: "K",
      rootFingerprint: "FP",
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    recordLivenessAccepted(db, "r", f(1));
    expect(deleteRegistry(db, "r")).toBe(true);
    expect(rows()).toBe(0);
    expect(deleteRegistry(db, "r")).toBe(false);
  });

  test("deleteRegistry does not throw on a V79 database", () => {
    const old = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(old, 79);
      expect(deleteRegistry(old, "nope")).toBe(false);
      deleteLivenessFloor(old, "nope");
    } finally {
      old.close();
    }
  });
});
