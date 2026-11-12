import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  ITEM_HISTORY_PRUNE_INTERVAL_MS,
  runItemHistoryPrune,
  startItemHistoryRetention,
} from "./item-history-retention.ts";

const DAY = 86_400_000;

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

function count(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM item_history").get() as { n: number }).n;
}

describe("runItemHistoryPrune", () => {
  test("deletes rows older than the retention in 5,000-row batches and yields between them", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const now = 1000 * DAY;
      fill(db, 12_001, now - 200 * DAY);
      fill(db, 4, now - 10 * DAY);
      let yields = 0;
      const r = await runItemHistoryPrune(db, {
        retentionDays: 180,
        nowMs: now,
        yieldToEventLoop: async () => {
          yields += 1;
        },
      });
      expect(r).toEqual({ deleted: 12_001, batches: 3, more: false });
      expect(yields).toBe(r.batches - 1);
      expect(count(db)).toBe(4);
    } finally {
      db.close();
    }
  });

  test("stops at maxBatches, reports more, and does not yield after the last batch", async () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 25, 1);
      let yields = 0;
      const r = await runItemHistoryPrune(db, {
        retentionDays: 7,
        nowMs: 100 * DAY,
        batchSize: 10,
        maxBatches: 2,
        yieldToEventLoop: async () => {
          yields += 1;
        },
      });
      expect(r).toEqual({ deleted: 20, batches: 2, more: true });
      expect(yields).toBe(1);
      expect(count(db)).toBe(5);
    } finally {
      db.close();
    }
  });

  test("a cutoff in the future of every row deletes everything; an empty table is a no-op", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const noYield = async (): Promise<void> => {};
      expect(
        await runItemHistoryPrune(db, { retentionDays: 7, nowMs: DAY, yieldToEventLoop: noYield }),
      ).toEqual({ deleted: 0, batches: 1, more: false });
      fill(db, 6, 5 * DAY);
      await runItemHistoryPrune(db, {
        retentionDays: 7,
        nowMs: 365 * DAY,
        batchSize: 4,
        yieldToEventLoop: noYield,
      });
      expect(count(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("the default yield is a real macrotask", async () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 3, 1);
      const r = await runItemHistoryPrune(db, {
        retentionDays: 7,
        nowMs: 100 * DAY,
        batchSize: 1,
        yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
      });
      expect(r.deleted).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe("startItemHistoryRetention", () => {
  function fakeTimer(): {
    setTimer: (fn: () => void, ms: number) => { clear: () => void };
    fire: () => void;
    intervalMs: () => number;
    cleared: () => boolean;
  } {
    let handler: (() => void) | undefined;
    let ms = 0;
    let cleared = false;
    return {
      setTimer: (fn, interval) => {
        handler = fn;
        ms = interval;
        return {
          clear: () => {
            cleared = true;
          },
        };
      },
      fire: () => handler?.(),
      intervalMs: () => ms,
      cleared: () => cleared,
    };
  }

  test("runs one pass at start (not awaited), then every 24 h; stop clears the timer", async () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 5, 1);
      const t = fakeTimer();
      const h = startItemHistoryRetention(db, {
        retentionDays: () => 7,
        nowMs: () => 100 * DAY,
        yieldToEventLoop: async () => {},
        setTimer: t.setTimer,
      });
      expect(t.intervalMs()).toBe(ITEM_HISTORY_PRUNE_INTERVAL_MS);
      await h.idle();
      expect(count(db)).toBe(0);
      fill(db, 2, 1);
      t.fire();
      await h.idle();
      expect(count(db)).toBe(0);
      h.stop();
      expect(t.cleared()).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a pass that stops at maxBatches with rows left is followed at once by another, until done", async () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 25, 1);
      const t = fakeTimer();
      let yields = 0;
      const h = startItemHistoryRetention(db, {
        retentionDays: () => 7,
        nowMs: () => 100 * DAY,
        yieldToEventLoop: async () => {
          yields += 1;
        },
        batchSize: 5,
        maxBatches: 2,
        setTimer: t.setTimer,
      });
      await h.idle();
      expect(count(db)).toBe(0);
      expect(yields).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("stop() ends a backlog drain between passes", async () => {
    const db = openMemoryIndexDatabase();
    try {
      fill(db, 25, 1);
      const t = fakeTimer();
      let handle: ReturnType<typeof startItemHistoryRetention> | undefined;
      handle = startItemHistoryRetention(db, {
        retentionDays: () => 7,
        nowMs: () => 100 * DAY,
        yieldToEventLoop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          handle?.stop();
        },
        batchSize: 5,
        maxBatches: 2,
        setTimer: t.setTimer,
      });
      await handle.idle();
      expect(count(db)).toBe(15);
    } finally {
      db.close();
    }
  });

  test("the retention is read through the closure on EVERY tick", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const now = 1000 * DAY;
      fill(db, 1, now - 50 * DAY);
      let days = 180;
      const t = fakeTimer();
      const h = startItemHistoryRetention(db, {
        retentionDays: () => days,
        nowMs: () => now,
        yieldToEventLoop: async () => {},
        setTimer: t.setTimer,
      });
      await h.idle();
      expect(count(db)).toBe(1);
      days = 7;
      t.fire();
      await h.idle();
      expect(count(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a throwing pass never escapes, and a pass in flight is not doubled", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const t = fakeTimer();
      let calls = 0;
      const h = startItemHistoryRetention(db, {
        retentionDays: () => {
          calls += 1;
          throw new Error("config unreadable");
        },
        setTimer: t.setTimer,
      });
      // The first pass is in flight (its promise has not settled yet): a second tick is skipped.
      t.fire();
      expect(calls).toBe(1);
      await h.idle();
      t.fire();
      await h.idle();
      expect(calls).toBe(2);
    } finally {
      db.close();
    }
  });

  test("a closed database is swallowed too", async () => {
    const db = openMemoryIndexDatabase();
    db.close();
    const t = fakeTimer();
    const h = startItemHistoryRetention(db, { retentionDays: () => 7, setTimer: t.setTimer });
    await h.idle();
    h.stop();
  });

  test("the defaults (real clock, real timer) start and stop cleanly", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const h = startItemHistoryRetention(db, { retentionDays: () => 180 });
      await h.idle();
      h.stop();
    } finally {
      db.close();
    }
  });
});
