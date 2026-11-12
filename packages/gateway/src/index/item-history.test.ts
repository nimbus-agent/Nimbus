import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  deleteItemHistoryForService,
  type ItemHistoryNext,
  pruneItemHistory,
  readItemHistoryBefore,
  recordItemDeleteHistory,
  recordItemUpsertHistory,
} from "./item-history.ts";

type Hist = {
  item_id: string;
  service: string;
  type: string;
  key: string;
  old_value: string | null;
  new_value: string | null;
  observed_at_ms: number;
  source_at_ms: number | null;
};

function rows(db: Database): Hist[] {
  return db.query("SELECT * FROM item_history ORDER BY id").all() as Hist[];
}

function seedItem(db: Database, id: string, service: string, type: string, meta: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
     VALUES (?, ?, ?, ?, 't', 1, 1, ?)`,
    [id, service, type, id, meta],
  );
}

function next(over: Partial<ItemHistoryNext> & { metadata: string }): ItemHistoryNext {
  return { id: "x", service: "github", type: "pr", syncedAt: 1000, ...over };
}

/** Reads before, then records, the way `upsertIndexedItem` does. */
function record(db: Database, n: ItemHistoryNext): void {
  const before = readItemHistoryBefore(db, n.id, n.service, n.type);
  if (before === undefined) return;
  recordItemUpsertHistory(db, before, n);
}

describe("readItemHistoryBefore", () => {
  test("an untracked pair returns undefined with NO statement at all", () => {
    const db = openMemoryIndexDatabase();
    try {
      let calls = 0;
      const wrap = <K extends "query" | "prepare" | "run" | "exec">(k: K): void => {
        const orig = (db[k] as (...a: unknown[]) => unknown).bind(db);
        (db as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
          calls += 1;
          return orig(...a);
        };
      };
      for (const k of ["query", "prepare", "run", "exec"] as const) wrap(k);
      expect(readItemHistoryBefore(db, "slack:1", "slack", "message")).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a tracked pair reports a missing row and an existing one", () => {
    const db = openMemoryIndexDatabase();
    try {
      expect(readItemHistoryBefore(db, "x", "github", "pr")?.existed).toBe(false);
      seedItem(db, "x", "github", "pr", '{"state":"open"}');
      const b = readItemHistoryBefore(db, "x", "github", "pr");
      expect(b?.existed).toBe(true);
      expect(b?.existed === true && b.metadata).toBe('{"state":"open"}');
    } finally {
      db.close();
    }
  });
});

describe("recordItemUpsertHistory", () => {
  test("no prior row writes ONE __created row and no key rows", () => {
    const db = openMemoryIndexDatabase();
    try {
      record(db, next({ metadata: '{"state":"open","merged":false}', syncedAt: 777 }));
      const r = rows(db);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({
        item_id: "x",
        service: "github",
        type: "pr",
        key: "__created",
        old_value: null,
        new_value: null,
        observed_at_ms: 777,
        source_at_ms: null,
      });
    } finally {
      db.close();
    }
  });

  test("identical metadata writes nothing and never parses (poisoned old text)", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(db, "x", "github", "pr", "{not json");
      record(db, next({ metadata: "{not json" }));
      expect(rows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a changed key writes one row; two changes write two; an unchanged tracked key none", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(db, "x", "github", "pr", '{"state":"open","merged":false,"draft":true,"title":"a"}');
      record(
        db,
        next({
          metadata: '{"state":"closed","merged":true,"draft":true,"title":"b"}',
          syncedAt: 5,
        }),
      );
      const r = rows(db);
      expect(r.map((x) => [x.key, x.old_value, x.new_value, x.observed_at_ms])).toEqual([
        ["state", "open", "closed", 5],
        ["merged", "false", "true", 5],
      ]);
    } finally {
      db.close();
    }
  });

  test("an untracked key changing writes nothing", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(db, "x", "github", "pr", '{"state":"open","labels":["a"]}');
      record(db, next({ metadata: '{"state":"open","labels":["b"]}' }));
      expect(rows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("an absent non-always key records nothing; an absent always key records old -> NULL", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(
        db,
        "j",
        "jira",
        "issue",
        '{"status":"Open","status_category":"todo","due_at_ms":5}',
      );
      record(db, next({ id: "j", service: "jira", type: "issue", metadata: '{"status":"Open"}' }));
      // due_at_ms omitted: silent. status_category is always written: its absence is a change.
      expect(rows(db).map((r) => [r.key, r.old_value, r.new_value])).toEqual([
        ["status_category", "todo", null],
      ]);
    } finally {
      db.close();
    }
  });

  test("an explicit null records old -> NULL; Sentry assignedTo is projected", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(
        db,
        "s",
        "sentry",
        "error_issue",
        '{"status":"unresolved","level":"error","assignedTo":{"id":"u1","name":"U"}}',
      );
      record(
        db,
        next({
          id: "s",
          service: "sentry",
          type: "error_issue",
          metadata: '{"status":"unresolved","level":"error","assignedTo":null}',
        }),
      );
      expect(rows(db).map((r) => [r.key, r.old_value, r.new_value])).toEqual([
        ["assignedTo", "u1", null],
      ]);
    } finally {
      db.close();
    }
  });

  test("a re-ordered array is not a change; a changed one is", () => {
    const db = openMemoryIndexDatabase();
    try {
      const tmpl = (emails: string): string =>
        `{"status":"triggered","assignee_emails":${emails},"resolved_by_email":null}`;
      seedItem(db, "p", "pagerduty", "incident", tmpl('["a@x","b@x"]'));
      record(
        db,
        next({ id: "p", service: "pagerduty", type: "incident", metadata: tmpl('["b@x","a@x"]') }),
      );
      expect(rows(db)).toEqual([]);
      record(
        db,
        next({ id: "p", service: "pagerduty", type: "incident", metadata: tmpl('["c@x"]') }),
      );
      expect(rows(db).map((r) => [r.key, r.old_value, r.new_value])).toEqual([
        ["assignee_emails", "a@x,b@x", "c@x"],
      ]);
    } finally {
      db.close();
    }
  });

  test("a 300-character value is stored as 256", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(db, "x", "github", "pr", '{"state":"open"}');
      record(db, next({ metadata: JSON.stringify({ state: "z".repeat(300) }) }));
      expect(rows(db)[0]?.new_value).toBe("z".repeat(256));
    } finally {
      db.close();
    }
  });

  test("source_at_ms: a merge carries merged_at, a close carries NULL", () => {
    const db = openMemoryIndexDatabase();
    try {
      seedItem(db, "x", "github", "pr", '{"state":"open","merged":false}');
      record(db, next({ metadata: '{"state":"merged","merged":true,"merged_at":4242}' }));
      expect(rows(db).map((r) => [r.key, r.source_at_ms])).toEqual([
        ["state", 4242],
        ["merged", 4242],
      ]);
      db.run("DELETE FROM item_history");
      db.run("UPDATE item SET metadata = ? WHERE id = 'x'", ['{"state":"open","merged":false}']);
      record(db, next({ metadata: '{"state":"closed","merged":false,"merged_at":4242}' }));
      expect(rows(db).map((r) => [r.key, r.source_at_ms])).toEqual([["state", null]]);
    } finally {
      db.close();
    }
  });

  test("malformed, NULL or non-object OLD metadata is no information: no throw, no rows", () => {
    const db = openMemoryIndexDatabase();
    try {
      for (const bad of ["{oops", "[1]", "7"]) {
        db.run("DELETE FROM item");
        seedItem(db, "x", "github", "pr", bad);
        record(db, next({ metadata: '{"state":"open"}' }));
      }
      db.run("DELETE FROM item");
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('x', 'github', 'pr', 'x', 't', 1, 1, NULL)`,
      );
      record(db, next({ metadata: '{"state":"open"}' }));
      expect(rows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("recordItemDeleteHistory", () => {
  test("writes __deleted for a tracked pair and nothing for an untracked one", () => {
    const db = openMemoryIndexDatabase();
    try {
      recordItemDeleteHistory(db, { id: "a", service: "github", type: "pr" }, 99);
      recordItemDeleteHistory(db, { id: "b", service: "slack", type: "message" }, 99);
      expect(rows(db).map((r) => [r.item_id, r.key, r.observed_at_ms])).toEqual([
        ["a", "__deleted", 99],
      ]);
    } finally {
      db.close();
    }
  });
});

describe("deleteItemHistoryForService", () => {
  test("removes exactly that service's rows", () => {
    const db = openMemoryIndexDatabase();
    try {
      recordItemDeleteHistory(db, { id: "a", service: "github", type: "pr" }, 1);
      recordItemDeleteHistory(db, { id: "b", service: "jira", type: "issue" }, 1);
      deleteItemHistoryForService(db, "github");
      expect(rows(db).map((r) => r.service)).toEqual(["jira"]);
    } finally {
      db.close();
    }
  });
});

describe("pruneItemHistory", () => {
  function fill(db: Database, n: number, observedAt: number): void {
    db.run("BEGIN");
    const stmt = db.prepare(
      "INSERT INTO item_history (item_id, service, type, key, observed_at_ms) VALUES ('i','github','pr','__created',?)",
    );
    try {
      for (let i = 0; i < n; i++) stmt.run(observedAt);
    } finally {
      stmt.finalize();
    }
    db.run("COMMIT");
  }

  test("12,001 old rows go in three batches; newer and equal-to-cutoff rows survive", () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 12_001, 10);
      fill(db, 3, 100);
      fill(db, 2, 500);
      const r = pruneItemHistory(db, { cutoffMs: 100, batchSize: 5000, maxBatches: 40 });
      expect(r).toEqual({ deleted: 12_001, batches: 3, more: false });
      expect(db.query("SELECT count(*) AS n FROM item_history").get()).toEqual({ n: 5 });
    } finally {
      db.close();
    }
  });

  test("maxBatches stops early and reports more", () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 12_001, 10);
      const r = pruneItemHistory(db, { cutoffMs: 100, batchSize: 5000, maxBatches: 2 });
      expect(r).toEqual({ deleted: 10_000, batches: 2, more: true });
      expect(db.query("SELECT count(*) AS n FROM item_history").get()).toEqual({ n: 2001 });
    } finally {
      db.close();
    }
  });

  test("an empty table is a no-op, and maxBatches 0 does nothing", () => {
    const db = openMemoryIndexDatabase();
    try {
      expect(pruneItemHistory(db, { cutoffMs: 1, batchSize: 10, maxBatches: 5 })).toEqual({
        deleted: 0,
        batches: 1,
        more: false,
      });
      expect(pruneItemHistory(db, { cutoffMs: 1, batchSize: 10, maxBatches: 0 })).toEqual({
        deleted: 0,
        batches: 0,
        more: false,
      });
    } finally {
      db.close();
    }
  });
});
