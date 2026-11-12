import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  annotateStateAt,
  buildAtClause,
  buildAtGapClause,
  composeAtClause,
  earliestHistoryMs,
  loadServiceHistoryStarts,
  pointInTimeDisclosure,
} from "./item-history-at.ts";
import { deleteItemByPrimaryKey, upsertIndexedItem } from "./item-store.ts";

type Put = {
  service: string;
  type: string;
  ext: string;
  meta?: Record<string, unknown>;
  at: number;
  modified?: number;
};

/** Writes through the REAL writer (`upsertIndexedItem`), so history rows are never hand-inserted. */
function put(db: Database, p: Put): void {
  upsertIndexedItem(db, {
    service: p.service,
    type: p.type,
    externalId: p.ext,
    title: "t",
    modifiedAt: p.modified ?? p.at,
    syncedAt: p.at,
    metadata: p.meta ?? {},
  });
}

/** An item that predates history: inserted without the writer. */
function raw(
  db: Database,
  service: string,
  type: string,
  ext: string,
  metadata: string,
  modified: number,
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
     VALUES (?, ?, ?, ?, 't', ?, 1, ?)`,
    [`${service}:${ext}`, service, type, ext, modified, metadata],
  );
}

function ids(db: Database, clause: { sql: string; params: readonly unknown[] }): string[] {
  const rows = db
    .query(`SELECT i.external_id AS e FROM item i WHERE ${clause.sql} ORDER BY i.external_id`)
    .all(...(clause.params as never[])) as { e: string }[];
  return rows.map((r) => r.e);
}

function classes(db: Database, atMs: number): { inn: string[]; gap: string[]; out: string[] } {
  const inn = ids(db, buildAtClause(db, atMs, "i"));
  const gap = ids(db, buildAtGapClause(db, atMs, "i"));
  const all = (
    db.query("SELECT external_id AS e FROM item ORDER BY e").all() as { e: string }[]
  ).map((r) => r.e);
  const out = all.filter((e) => !inn.includes(e) && !gap.includes(e));
  // The classification is total and exclusive.
  expect(inn.filter((e) => gap.includes(e))).toEqual([]);
  return { inn, gap, out };
}

/** Seeds one writer-made row per service so that H0(service) = 100. */
function seedStarts(db: Database, services: Array<[string, string]>): void {
  for (const [service, type] of services) {
    put(db, { service, type, ext: `seed-${service}`, at: 100, meta: { opened_at_ms: 90 } });
  }
}

describe("buildAtClause - the OUT / IN / GAP arms", () => {
  test("deleted before T is OUT, even if the item exists again now", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      put(db, { service: "github", type: "pr", ext: "x1", at: 200, meta: { opened_at_ms: 150 } });
      deleteItemByPrimaryKey(db, "github:x1", 500);
      put(db, { service: "github", type: "pr", ext: "x1", at: 1500, meta: { opened_at_ms: 150 } });
      const c = classes(db, 1000);
      expect(c.out).toContain("x1");
      expect(c.inn).not.toContain("x1");
    } finally {
      db.close();
    }
  });

  test("a deletion AFTER T does not remove an item that existed at T", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      put(db, { service: "github", type: "pr", ext: "x1", at: 200, meta: { opened_at_ms: 150 } });
      deleteItemByPrimaryKey(db, "github:x1", 1200);
      put(db, { service: "github", type: "pr", ext: "x1", at: 1500, meta: { opened_at_ms: 150 } });
      expect(classes(db, 1000).inn).toContain("x1");
    } finally {
      db.close();
    }
  });

  test("provider creation after T is OUT; before T and covered is IN", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      put(db, {
        service: "github",
        type: "pr",
        ext: "late",
        at: 1300,
        meta: { opened_at_ms: 1200 },
      });
      put(db, {
        service: "github",
        type: "pr",
        ext: "early",
        at: 200,
        meta: { opened_at_ms: 150 },
      });
      const c = classes(db, 1000);
      expect(c.out).toContain("late");
      expect(c.inn).toContain("early");
    } finally {
      db.close();
    }
  });

  test("born unknown: first seen after T is GAP, first seen before T is IN", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "issue"]]);
      put(db, {
        service: "github",
        type: "issue",
        ext: "i-late",
        at: 1200,
        meta: { state: "open" },
      });
      put(db, {
        service: "github",
        type: "issue",
        ext: "i-early",
        at: 300,
        meta: { state: "open" },
      });
      const c = classes(db, 1000);
      expect(c.gap).toContain("i-late");
      expect(c.inn).toContain("i-early");
    } finally {
      db.close();
    }
  });

  test("a pre-history tracked item: modified_at proves it unchanged only where it tracks change", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [
        ["github", "pr"],
        ["gitlab", "pr"],
      ]);
      raw(db, "github", "pr", "p-old", '{"opened_at_ms":50}', 60);
      raw(db, "github", "pr", "p-new", '{"opened_at_ms":50}', 90);
      raw(db, "gitlab", "pr", "g-old", '{"opened_at_ms":50}', 60);
      // T = 80 is before the history of both services (H0 = 100).
      const c = classes(db, 80);
      expect(c.inn).toContain("p-old"); // github tracks modified_at, and it is <= T
      expect(c.gap).toContain("p-new"); // modified after T, before any history: cannot be placed
      expect(c.gap).toContain("g-old"); // gitlab's modified_at is not a change clock
      // T = 500 is covered by history for both.
      const later = classes(db, 500);
      expect(later.inn).toEqual(expect.arrayContaining(["p-old", "p-new", "g-old"]));
    } finally {
      db.close();
    }
  });

  test("a pre-history item of a non-tracking type without a creation time: GAP before H0, IN after", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["bigeye", "data_quality_test"]]);
      raw(db, "bigeye", "data_quality_test", "b1", '{"slaStatus":"ok"}', 60);
      expect(classes(db, 80).gap).toContain("b1");
      expect(classes(db, 500).inn).toContain("b1");
    } finally {
      db.close();
    }
  });

  test("an untracked type is IN iff modified_at <= T, else GAP, even in a tracked service", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      put(db, { service: "slack", type: "message", ext: "m-old", at: 10, modified: 10 });
      put(db, { service: "slack", type: "message", ext: "m-new", at: 2000, modified: 2000 });
      put(db, { service: "github", type: "review", ext: "r-new", at: 2000, modified: 2000 });
      const c = classes(db, 1000);
      expect(c.inn).toContain("m-old");
      expect(c.gap).toEqual(expect.arrayContaining(["m-new", "r-new"]));
    } finally {
      db.close();
    }
  });

  test("a service with no history at all: modified_at is the only evidence", () => {
    const db = openMemoryIndexDatabase();
    try {
      raw(db, "github", "pr", "a", '{"opened_at_ms":50}', 60);
      raw(db, "github", "pr", "b", '{"opened_at_ms":50}', 900);
      const c = classes(db, 500);
      expect(c.inn).toEqual(["a"]);
      expect(c.gap).toEqual(["b"]);
      expect(earliestHistoryMs(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an ISO born time (Monte Carlo) is read, and a wrong-typed one is unknown", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["montecarlo", "data_quality_test"]]);
      put(db, {
        service: "montecarlo",
        type: "data_quality_test",
        ext: "mc-future",
        at: 5000,
        meta: { status: "open", severity: "S1", firstSeenAt: "1970-01-01T00:00:03Z" },
      });
      put(db, {
        service: "montecarlo",
        type: "data_quality_test",
        ext: "mc-early",
        at: 200,
        meta: { status: "open", severity: "S1", firstSeenAt: "1970-01-01T00:00:00Z" },
      });
      put(db, {
        service: "montecarlo",
        type: "data_quality_test",
        ext: "mc-num",
        at: 5000,
        meta: { status: "open", severity: "S1", firstSeenAt: 5 },
      });
      const c = classes(db, 1000);
      expect(c.out).toContain("mc-future"); // born 3000 ms > T
      expect(c.inn).toContain("mc-early");
      expect(c.gap).toContain("mc-num"); // a number is not an ISO text: born unknown, seen after T
    } finally {
      db.close();
    }
  });

  test("malformed metadata JSON does not raise; the row classifies by the other arms", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      raw(db, "github", "pr", "bad", "{oops", 60);
      expect(classes(db, 500).inn).toContain("bad");
    } finally {
      db.close();
    }
  });
});

describe("buildAtClause - the SQL is bound end to end", () => {
  test("no instant, spec key or pair id appears in the SQL text", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedStarts(db, [["github", "pr"]]);
      const { sql, params } = buildAtClause(db, 123_456_789, "i");
      expect(sql).not.toContain("123456789");
      expect(sql).not.toContain("opened_at_ms");
      expect(sql).not.toContain("github:pr");
      expect(params).toContain(123_456_789);
      expect(params).toContain("github:pr");
      expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    } finally {
      db.close();
    }
  });

  test("the alias is a closed set", () => {
    expect(() => composeAtClause(new Map(), 1, "i; DROP TABLE item", "in")).toThrow(
      /unsupported alias/,
    );
    expect(composeAtClause(new Map(), 1, "item", "gap").sql).toContain("item.id");
  });
});

describe("history starts", () => {
  test("loadServiceHistoryStarts and earliestHistoryMs", () => {
    const db = openMemoryIndexDatabase();
    try {
      expect(loadServiceHistoryStarts(db).size).toBe(0);
      expect(earliestHistoryMs(db)).toBeNull();
      expect(earliestHistoryMs(db, ["github"])).toBeNull();
      put(db, { service: "github", type: "pr", ext: "a", at: 300, meta: { opened_at_ms: 1 } });
      put(db, { service: "github", type: "issue", ext: "b", at: 200 });
      put(db, { service: "jira", type: "issue", ext: "c", at: 700 });
      expect(Object.fromEntries(loadServiceHistoryStarts(db))).toEqual({ github: 200, jira: 700 });
      expect(earliestHistoryMs(db)).toBe(200);
      expect(earliestHistoryMs(db, ["jira"])).toBe(700);
      expect(earliestHistoryMs(db, ["jira", "github", "slack"])).toBe(200);
      expect(earliestHistoryMs(db, ["slack"])).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("annotateStateAt", () => {
  type Itm = { id: string; service: string; itemType: string; rawMeta?: Record<string, unknown> };

  test("history basis: the OLD value of the earliest change after T; a key never changed is current", () => {
    const db = openMemoryIndexDatabase();
    try {
      put(db, {
        service: "github",
        type: "pr",
        ext: "a",
        at: 200,
        meta: { state: "open", merged: false, draft: false, opened_at_ms: 1 },
      });
      put(db, {
        service: "github",
        type: "pr",
        ext: "a",
        at: 1200,
        meta: { state: "closed", merged: false, draft: false, opened_at_ms: 1 },
      });
      put(db, {
        service: "github",
        type: "pr",
        ext: "a",
        at: 1300,
        meta: { state: "merged", merged: true, draft: false, opened_at_ms: 1, merged_at: 1300 },
      });
      const items: Itm[] = [
        {
          id: "a",
          service: "github",
          itemType: "pr",
          rawMeta: { state: "merged", merged: true, draft: false, title: "SECRET" },
        },
      ];
      const [r] = annotateStateAt(db, items, 1000);
      expect(r?.asOf.basis).toBe("history");
      // `state` changed twice after T: the EARLIEST change's old value. `merged` changed once.
      expect(r?.asOf.state).toEqual({ state: "open", merged: "false", draft: "false" });
      expect(r?.asOf.atMs).toBe(1000);
      expect(JSON.stringify(r?.asOf)).not.toContain("SECRET");
    } finally {
      db.close();
    }
  });

  test("an item deleted and recreated with another state still shows its earlier state before the deletion", () => {
    const db = openMemoryIndexDatabase();
    try {
      put(db, {
        service: "github",
        type: "pr",
        ext: "r",
        at: 200,
        meta: { state: "open", merged: false, draft: false, opened_at_ms: 1 },
      });
      deleteItemByPrimaryKey(db, "github:r", 1200);
      put(db, {
        service: "github",
        type: "pr",
        ext: "r",
        at: 1500,
        meta: { state: "closed", merged: false, draft: false, opened_at_ms: 1 },
      });
      const items: Itm[] = [
        {
          id: "r",
          service: "github",
          itemType: "pr",
          rawMeta: { state: "closed", merged: false, draft: false },
        },
      ];
      const [before] = annotateStateAt(db, items, 1000);
      expect(before?.asOf.state["state"]).toBe("open");
      // After the recreation the current value stands.
      const [after] = annotateStateAt(db, items, 1600);
      expect(after?.asOf.state["state"]).toBe("closed");
    } finally {
      db.close();
    }
  });

  test("current basis for an unchanged item; only tracked keys; an untracked item has none", () => {
    const db = openMemoryIndexDatabase();
    try {
      put(db, {
        service: "github",
        type: "pr",
        ext: "a",
        at: 200,
        meta: { state: "open", opened_at_ms: 1 },
      });
      const items: Itm[] = [
        { id: "a", service: "github", itemType: "pr", rawMeta: { state: "open", labels: ["x"] } },
        { id: "m", service: "slack", itemType: "message", rawMeta: { state: "x" } },
        { id: "n", service: "github", itemType: "pr" },
      ];
      const out = annotateStateAt(db, items, 1000);
      expect(out[0]?.asOf).toEqual({ atMs: 1000, state: { state: "open" }, basis: "current" });
      expect(out[1]?.asOf).toEqual({ atMs: 1000, state: {}, basis: "current" });
      expect(out[2]?.asOf.state).toEqual({});
    } finally {
      db.close();
    }
  });

  test("a change whose old value was NULL is shown as null; more than 500 items are chunked", () => {
    const db = openMemoryIndexDatabase();
    try {
      put(db, { service: "jira", type: "issue", ext: "j", at: 200, meta: { status: "Open" } });
      put(db, {
        service: "jira",
        type: "issue",
        ext: "j",
        at: 1200,
        meta: { status: "Open", due_at_ms: 5 },
      });
      const many: Itm[] = [{ id: "j", service: "jira", itemType: "issue" }];
      for (let i = 0; i < 600; i++)
        many.push({ id: `n${String(i)}`, service: "jira", itemType: "issue" });
      const out = annotateStateAt(db, many, 1000);
      expect(out).toHaveLength(601);
      expect(out[0]?.asOf.state["due_at_ms"]).toBeNull();
      expect(out[600]?.asOf.basis).toBe("current");
    } finally {
      db.close();
    }
  });
});

describe("pointInTimeDisclosure", () => {
  const base = { atMs: Date.UTC(2026, 10, 11, 9), zone: "Europe/London" };

  test("covered, with gaps: the as-of line, then Gaps (plural)", () => {
    expect(pointInTimeDisclosure({ ...base, historyStartMs: base.atMs - 1, gapCount: 2 })).toEqual([
      "As of 2026-11-11T09:00:00.000Z (Europe/London). State keys come from item history; titles and bodies are as of now.",
      "## Gaps",
      "2 items could not be placed at that time (their state changed after it and the change predates item history, or their birth is unknown); they are not shown.",
      "Items deleted from the index since that time are not shown and are not counted.",
    ]);
  });

  test("history starts later than T", () => {
    const lines = pointInTimeDisclosure({
      ...base,
      historyStartMs: Date.UTC(2026, 10, 11, 12),
      gapCount: 0,
    });
    expect(lines[1]).toBe(
      "History starts 2026-11-11T12:00:00.000Z; state before then is the first observed state.",
    );
    expect(lines[3]).toContain("0 items could not be placed");
  });

  test("empty history, singular gap", () => {
    const lines = pointInTimeDisclosure({ ...base, historyStartMs: null, gapCount: 1 });
    expect(lines[1]).toBe(
      "Item history is empty for at least part of this scope; there, only items unchanged since that time are shown.",
    );
    expect(lines[2]).toBe("## Gaps");
    expect(lines[3]).toContain("1 item could not be placed");
    expect(lines[3]).toContain("it is not shown");
  });
});
