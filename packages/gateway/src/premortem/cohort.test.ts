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

  test("a same-service, non-JSON metadata row does not break childCount (json_valid guard in childCountsFor)", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "GOOD-1", services: ["billing"], resolvedAtMs: 1_000 });
    // The bad row shares the epic's SERVICE ("jira"). Only a same-service row
    // forces SQLite to evaluate json_extract on it at all -- a
    // different-service row is filtered out via idx_item_service before the
    // JSON expression ever runs, so it could never prove this guard does
    // anything. `epic-services.ts`'s own child join is now ALSO guarded (see
    // the epic-services.ts fix landed in this same round), so this row no
    // longer trips that function's raise first -- it isolates
    // `childCountsFor`'s own guard.
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["jira:BAD-1", "jira", "issue", "BAD-1", "bad", 1, 1, "not json"],
    );

    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });

    expect(out.members.map((m) => m.key)).toEqual(["GOOD-1"]);
    // 1: GOOD-1's own real child from `seedEpicWithServices` (services:
    // ["billing"]) -- the bad row is excluded by the guard, not counted.
    expect(out.members[0]?.childCount).toBe(1);
  });

  test("childCount reports the total number of children under the epic", () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "KIDS-1",
      services: ["billing", "mail", "search"],
      resolvedAtMs: 1_000,
    });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members[0]?.childCount).toBe(3);
  });

  test("a service touching every scanned candidate contributes exactly 0 to score", () => {
    // Pins the IDF formula directly, rather than relying on a rare-vs-ubiquitous
    // comparison (which a `+1`-smoothed formula could also satisfy). df === N
    // must give a weight of exactly 0 -- any smoothing constant makes this
    // nonzero.
    const db = makeDb();
    for (let i = 0; i < 4; i++) {
      seedEpicWithServices(db, {
        key: `E-${i}`,
        services: ["ubiquitous"],
        resolvedAtMs: 1_000 + i,
      });
    }
    const out = selectCohort(db, ["ubiquitous"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members).toHaveLength(4);
    for (const member of out.members) {
      expect(member.score).toBe(0);
    }
  });

  test("createdAtMs is read through metadata.created_at_ms when present", () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "CREATED-1",
      services: ["billing"],
      resolvedAtMs: 2_000,
      createdAtMs: 500,
    });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members[0]?.createdAtMs).toBe(500);
  });

  test("a canceled epic is a reachable cohort member", () => {
    const db = makeDb();
    seedEpicWithServices(db, {
      key: "CANCELED-1",
      services: ["billing"],
      resolvedAtMs: 1_000,
      statusCategory: "canceled",
    });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members[0]?.statusCategory).toBe("canceled");
  });

  test("an epic with no children (zero services) never enters the cohort and does not throw", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "NOKIDS-1", services: [], resolvedAtMs: 1_000 });
    seedEpicWithServices(db, { key: "HASKIDS-1", services: ["billing"], resolvedAtMs: 900 });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members.map((m) => m.key)).toEqual(["HASKIDS-1"]);
  });
});
