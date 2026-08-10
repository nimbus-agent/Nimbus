import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { seedEpicWithServices } from "./cohort.test-helpers.ts";
import { selectCohort } from "./cohort.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("selectCohort", () => {
  test("returns no members when no closed epic shares a service", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "OTHER-1", services: ["unrelated"], resolvedAtMs: 1_000 });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members).toEqual([]);
    expect(out.oldestResolvedAtMs).toBeNull();
  });

  test("a rare shared service outranks a ubiquitous one", () => {
    const db = makeDb();
    // "shared-utils" appears in every candidate -> IDF weight ~0.
    // "billing" appears in one -> high weight.
    for (let i = 0; i < 5; i++) {
      seedEpicWithServices(db, {
        key: `UBI-${i}`,
        services: ["shared-utils"],
        resolvedAtMs: 1_000 + i,
      });
    }
    seedEpicWithServices(db, {
      key: "RARE-1",
      services: ["shared-utils", "billing"],
      resolvedAtMs: 900,
    });

    const out = selectCohort(db, ["shared-utils", "billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });

    expect(out.members[0]?.key).toBe("RARE-1");
    expect(out.members[0]?.score).toBeGreaterThan(out.members[1]?.score ?? 0);
  });

  test("the target epic is never its own cohort member", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "TARGET-1", services: ["billing"], resolvedAtMs: 1_000 });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members.map((m) => m.key)).not.toContain("TARGET-1");
  });

  test("maxCohortSize caps members while scannedCount reports the full scan", () => {
    const db = makeDb();
    for (let i = 0; i < 8; i++) {
      seedEpicWithServices(db, { key: `E-${i}`, services: ["billing"], resolvedAtMs: 1_000 + i });
    }
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 3,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members).toHaveLength(3);
    expect(out.scannedCount).toBe(8);
  });

  test("a zero-overlap epic never enters the cohort, even as the most recent closed epic", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "SHARED-1", services: ["billing"], resolvedAtMs: 1_000 });
    // Newest by a wide margin, but shares no service with the target.
    seedEpicWithServices(db, { key: "UNRELATED-1", services: ["mail"], resolvedAtMs: 9_000_000 });

    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });

    expect(out.members.map((m) => m.key)).toEqual(["SHARED-1"]);
  });

  test("maxCandidateScan truncates the OLDEST history, keeping the newest", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      seedEpicWithServices(db, { key: `E-${i}`, services: ["billing"], resolvedAtMs: 1_000 + i });
    }
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 2,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.scannedCount).toBe(2);
    expect(out.members.map((m) => m.key).sort()).toEqual(["E-3", "E-4"]);
  });
});
