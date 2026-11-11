import { describe, expect, test } from "bun:test";

import { ensureGraphEntity } from "../graph/relationship-graph.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  REPLACE_ITEM_SET_MAX_KEEP,
  REPLACE_ITEM_SET_TYPES,
  replaceItemSetRows,
} from "./item-set-store.ts";
import { upsertIndexedItem } from "./item-store.ts";

type Db = ReturnType<typeof openMemoryIndexDatabase>;

function seed(
  db: Db,
  service: string,
  type: string,
  externalId: string,
  metadata: Record<string, unknown> = {},
): void {
  upsertIndexedItem(db, {
    service,
    type,
    externalId,
    title: `title ${externalId}`,
    modifiedAt: 1,
    syncedAt: 1,
    bodyPreview: `preview ${externalId}`,
    metadata,
  });
}

function ids(db: Db, service: string, type: string): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = ? AND type = ? ORDER BY external_id")
      .all(service, type) as { external_id: string }[]
  ).map((r) => r.external_id);
}

function withDb(fn: (db: Db) => void): void {
  const db = openMemoryIndexDatabase();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("replaceItemSetRows — keep set", () => {
  test("deletes rows not in keep, keeps the rest and returns the count", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "e1");
      seed(db, "outlook", "event", "e2");
      seed(db, "outlook", "event", "e3");
      expect(replaceItemSetRows(db, "outlook", "event", ["e1", "e3"])).toBe(1);
      expect(ids(db, "outlook", "event")).toEqual(["e1", "e3"]);
    });
  });

  test("another type of the same service and another service's events are untouched", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "e1");
      seed(db, "outlook", "email", "m1");
      seed(db, "google_calendar", "event", "a|1");
      seed(db, "apple", "event", "u1");
      expect(replaceItemSetRows(db, "outlook", "event", [])).toBe(1);
      expect(ids(db, "outlook", "email")).toEqual(["m1"]);
      expect(ids(db, "google_calendar", "event")).toEqual(["a|1"]);
      expect(ids(db, "apple", "event")).toEqual(["u1"]);
    });
  });

  test("an empty keep set without options deletes every row of the type; nothing to delete returns 0", () => {
    withDb((db) => {
      seed(db, "google_calendar", "event", "a|1");
      seed(db, "google_calendar", "event", "b|1");
      expect(replaceItemSetRows(db, "google_calendar", "event", [])).toBe(2);
      expect(replaceItemSetRows(db, "google_calendar", "event", [])).toBe(0);
    });
  });
});

describe("replaceItemSetRows — externalIdPrefix", () => {
  test("only ids starting with the prefix are candidates, and _ and % are not wildcards", () => {
    withDb((db) => {
      seed(db, "google_calendar", "event", "a_b|1");
      seed(db, "google_calendar", "event", "axb|1");
      seed(db, "google_calendar", "event", "a%b|1");
      seed(db, "google_calendar", "event", "other|1");
      expect(
        replaceItemSetRows(db, "google_calendar", "event", [], { externalIdPrefix: "a_b|" }),
      ).toBe(1);
      expect(ids(db, "google_calendar", "event")).toEqual(["a%b|1", "axb|1", "other|1"]);
      expect(
        replaceItemSetRows(db, "google_calendar", "event", [], { externalIdPrefix: "a%b|" }),
      ).toBe(1);
      expect(ids(db, "google_calendar", "event")).toEqual(["axb|1", "other|1"]);
    });
  });

  test("a prefix with a keep set removes only that calendar's rows that are not kept", () => {
    withDb((db) => {
      seed(db, "google_calendar", "event", "c1|a");
      seed(db, "google_calendar", "event", "c1|b");
      seed(db, "google_calendar", "event", "c2|a");
      expect(
        replaceItemSetRows(db, "google_calendar", "event", ["c1|a"], { externalIdPrefix: "c1|" }),
      ).toBe(1);
      expect(ids(db, "google_calendar", "event")).toEqual(["c1|a", "c2|a"]);
    });
  });
});

describe("replaceItemSetRows — endBeforeMs", () => {
  test("only rows with a finite numeric end_ms below it are candidates", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "old", { end_ms: 100 });
      seed(db, "outlook", "event", "edge", { end_ms: 200 });
      seed(db, "outlook", "event", "future", { end_ms: 900 });
      seed(db, "outlook", "event", "noend", {});
      seed(db, "outlook", "event", "stringend", { end_ms: "100" });
      seed(db, "outlook", "event", "nullend", { end_ms: null });
      expect(replaceItemSetRows(db, "outlook", "event", [], { endBeforeMs: 200 })).toBe(1);
      expect(ids(db, "outlook", "event")).toEqual([
        "edge",
        "future",
        "noend",
        "nullend",
        "stringend",
      ]);
    });
  });

  test("a kept old row survives; a corrupt metadata row is not a candidate and does not throw", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "kept-old", { end_ms: 1 });
      seed(db, "outlook", "event", "gone-old", { end_ms: 2 });
      seed(db, "outlook", "event", "corrupt");
      seed(db, "outlook", "event", "array");
      db.run("UPDATE item SET metadata = ? WHERE external_id = 'corrupt'", ["{not json"]);
      db.run("UPDATE item SET metadata = ? WHERE external_id = 'array'", ["[1,2]"]);
      db.run("UPDATE item SET metadata = NULL WHERE external_id = 'array'");
      expect(replaceItemSetRows(db, "outlook", "event", ["kept-old"], { endBeforeMs: 50 })).toBe(1);
      expect(ids(db, "outlook", "event")).toEqual(["array", "corrupt", "kept-old"]);
    });
  });

  test("a metadata value that is JSON but not an object is not a candidate", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "scalar");
      db.run("UPDATE item SET metadata = '5' WHERE external_id = 'scalar'");
      expect(replaceItemSetRows(db, "outlook", "event", [], { endBeforeMs: 50 })).toBe(0);
    });
  });
});

describe("replaceItemSetRows — the delete path is deleteItem's", () => {
  test("FTS, graph entities and the open-work snapshot follow the row", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "gone");
      seed(db, "outlook", "event", "stay");
      ensureGraphEntity(db, { type: "pr", externalId: "outlook:gone", label: "x" });
      db.run(
        "INSERT INTO work_snapshot (service, relation, item_id, captured_at) VALUES ('jira','assigned','outlook:gone',1)",
      );
      expect(
        (
          db.query("SELECT COUNT(*) AS n FROM item_fts WHERE item_fts MATCH 'gone'").get() as {
            n: number;
          }
        ).n,
      ).toBeGreaterThan(0);
      replaceItemSetRows(db, "outlook", "event", ["stay"]);
      expect(
        (
          db.query("SELECT COUNT(*) AS n FROM item_fts WHERE item_fts MATCH 'gone'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect((db.query("SELECT COUNT(*) AS n FROM work_snapshot").get() as { n: number }).n).toBe(
        0,
      );
      expect(
        (
          db
            .query("SELECT COUNT(*) AS n FROM graph_entity WHERE external_id = 'outlook:gone'")
            .get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    });
  });

  test("one transaction: a delete that fails part-way leaves every row", () => {
    withDb((db) => {
      seed(db, "outlook", "event", "a");
      seed(db, "outlook", "event", "b");
      db.run(
        `CREATE TRIGGER poison BEFORE DELETE ON item WHEN OLD.external_id = 'b'
         BEGIN SELECT RAISE(ABORT, 'poisoned'); END`,
      );
      expect(() => replaceItemSetRows(db, "outlook", "event", [])).toThrow(/poisoned/);
      expect(ids(db, "outlook", "event")).toEqual(["a", "b"]);
    });
  });
});

describe("replaceItemSetRows — refusals", () => {
  test("a service with no allowlist entry, and a type outside it, throw named errors", () => {
    withDb((db) => {
      expect(() => replaceItemSetRows(db, "slack", "event", [])).toThrow(
        'replaceItemSet is not available to "slack"',
      );
      expect(() => replaceItemSetRows(db, "outlook", "email", [])).toThrow(
        'may not sweep "email" rows of "outlook"',
      );
    });
  });

  test("an oversized keep set, a non-finite endBeforeMs and an empty prefix throw", () => {
    withDb((db) => {
      const huge = Array.from({ length: REPLACE_ITEM_SET_MAX_KEEP + 1 }, (_, i) => String(i));
      expect(() => replaceItemSetRows(db, "outlook", "event", huge)).toThrow(/at most/);
      expect(() =>
        replaceItemSetRows(db, "outlook", "event", [], { endBeforeMs: Number.NaN }),
      ).toThrow(/finite/);
      expect(() =>
        replaceItemSetRows(db, "outlook", "event", [], { externalIdPrefix: "" }),
      ).toThrow(/externalIdPrefix/);
    });
  });

  test("the allowlist names only the calendar services (event) and the on-call sources (oncall_shift)", () => {
    expect(REPLACE_ITEM_SET_TYPES).toEqual({
      google_calendar: ["event"],
      outlook: ["event"],
      pagerduty: ["oncall_shift"],
      jira: ["oncall_shift"],
    });
  });
});
