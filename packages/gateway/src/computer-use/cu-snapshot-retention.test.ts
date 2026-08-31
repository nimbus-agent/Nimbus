import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  type CuSnapshotRetentionHandle,
  pruneCuSnapshots,
  startCuSnapshotRetention,
} from "./cu-snapshot-retention.ts";
import { insertAction, insertSession } from "./cu-store.ts";

const DAY_MS = 86_400_000;

function makeTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

interface ActionRow {
  outcome: string;
  hitl_status: string;
  dom_before: string | null;
  dom_after: string | null;
}

function getAction(db: Database, id: string): ActionRow | null {
  return db
    .query<ActionRow, [string]>(
      `SELECT outcome, hitl_status, dom_before, dom_after FROM cu_action WHERE id = ?`,
    )
    .get(id);
}

function seedAction(db: Database, id: string, timestamp: number): void {
  insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 0 });
  insertAction(
    db,
    {
      id,
      sessionId: "s1",
      seq: 1,
      kind: "read",
      classification: "observing",
      observedTarget: "read",
      modelDescription: null,
      hitlStatus: "approved",
      outcome: "actuated",
      domBefore: "<html>secret</html>",
      domAfter: "<html>secret-after</html>",
      screenshotDigest: null,
      timestamp,
    },
    1_000_000,
  );
}

describe("pruneCuSnapshots", () => {
  const now = 1_000 * DAY_MS;

  test("NULLs dom_before/dom_after for rows past the retention window but keeps the action row", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 8 * DAY_MS); // older than a 7-day window

    pruneCuSnapshots(db, { retentionDays: 7, nowMs: now });

    const row = getAction(db, "a1");
    expect(row?.dom_before).toBeNull();
    expect(row?.dom_after).toBeNull();
    // The permanent decision fields survive the prune untouched.
    expect(row?.outcome).toBe("actuated");
    expect(row?.hitl_status).toBe("approved");
  });

  test("a row inside the window survives untouched", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 1 * DAY_MS); // inside a 7-day window

    pruneCuSnapshots(db, { retentionDays: 7, nowMs: now });

    const row = getAction(db, "a1");
    expect(row?.dom_before).toBe("<html>secret</html>");
    expect(row?.dom_after).toBe("<html>secret-after</html>");
  });

  test("retentionDays = 0 disables pruning entirely (no call, no mutation)", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 10_000 * DAY_MS);
    let called = false;

    pruneCuSnapshots(db, {
      retentionDays: 0,
      nowMs: now,
      prune: () => {
        called = true;
      },
    });

    expect(called).toBe(false);
    const row = getAction(db, "a1");
    expect(row?.dom_before).toBe("<html>secret</html>");
  });

  test("invokes the injected prune function with the computed cutoff", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 8 * DAY_MS);
    const calls: Array<number> = [];

    pruneCuSnapshots(db, {
      retentionDays: 7,
      nowMs: now,
      prune: (_db, cutoffMs) => {
        calls.push(cutoffMs);
      },
    });

    expect(calls).toEqual([now - 7 * DAY_MS]);
  });
});

describe("startCuSnapshotRetention", () => {
  const now = 1_000 * DAY_MS;

  test("prunes once immediately on start", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 8 * DAY_MS);
    let handle: CuSnapshotRetentionHandle | undefined;
    try {
      handle = startCuSnapshotRetention(db, { retentionDays: 7, nowMs: () => now });
      const row = getAction(db, "a1");
      expect(row?.dom_before).toBeNull();
    } finally {
      handle?.stop();
    }
  });

  test("retentionDays = 0 starts no timer and prunes nothing", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 10_000 * DAY_MS);
    const handle = startCuSnapshotRetention(db, { retentionDays: 0, nowMs: () => now });
    try {
      const row = getAction(db, "a1");
      expect(row?.dom_before).toBe("<html>secret</html>");
    } finally {
      handle.stop();
    }
  });

  test("a prune error does not throw out of the tick", () => {
    const db = makeTestDb();
    seedAction(db, "a1", now - 8 * DAY_MS);
    db.exec("DROP TABLE cu_action");
    expect(() => {
      const handle = startCuSnapshotRetention(db, { retentionDays: 7, nowMs: () => now });
      handle.stop();
    }).not.toThrow();
  });

  test("falls back to Date.now when no clock is injected", () => {
    const db = makeTestDb();
    seedAction(db, "a1", Date.now() - 8 * DAY_MS);
    const handle = startCuSnapshotRetention(db, { retentionDays: 7 });
    try {
      const row = getAction(db, "a1");
      expect(row?.dom_before).toBeNull();
    } finally {
      handle.stop();
    }
  });
});
