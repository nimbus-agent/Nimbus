/**
 * The scheduler's persistence layer, against the REAL migrated schema (`scheduler_state`,
 * `sync_telemetry`, `item`) rather than a hand-written copy of it.
 *
 * Production code writes a status only through the typed setters (one of the three values), and
 * `countItemsForAnyService`'s one caller (`connector-vault.ts`) always passes a fixed, non-empty
 * service list — so the unknown-status and empty-list arms are reachable only from a test and are
 * pinned here directly, alongside the telemetry read-back the scheduler itself never performs.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import {
  clearSchedulerCursor,
  countItemsForAnyService,
  countItemsForService,
  deleteSchedulerStateRow,
  insertSyncTelemetry,
  listAllSchedulerStates,
  listRecentSyncTelemetry,
  loadSchedulerState,
  setIntervalMs,
  setNextSyncAt,
  setPaused,
  updateSchedulerState,
  upsertSchedulerRegistration,
} from "./scheduler-store.ts";

let db: Database;

beforeEach(() => {
  db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
});

afterEach(() => {
  db.close();
});

/** Writes a row by hand — the only way to persist a status the typed API refuses to produce. */
function rawState(serviceId: string, status: string): void {
  db.run(
    `INSERT INTO scheduler_state (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
     VALUES (?, 'cur', 60000, 1, 2, ?, NULL, 0, 0)`,
    [serviceId, status],
  );
}

function insertItem(id: string, service: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, ?, 'file', ?, 't', '', 1, 1)`,
    [id, service, id],
  );
}

describe("registration and load", () => {
  test("an unregistered service loads as null", () => {
    expect(loadSchedulerState(db, "github")).toBeNull();
  });

  test("first registration inserts a due-now, healthy, unpaused row", () => {
    upsertSchedulerRegistration(db, "github", 300_000, 1_000, false);
    expect(loadSchedulerState(db, "github")).toEqual({
      service_id: "github",
      cursor: null,
      interval_ms: 300_000,
      last_sync_at: null,
      next_sync_at: 1_000,
      status: "ok",
      error_msg: null,
      consecutive_failures: 0,
      paused: 0,
    });
  });

  test("re-registration keeps the stored row, and changes ONLY the interval when asked to", () => {
    upsertSchedulerRegistration(db, "github", 300_000, 1_000, false);
    updateSchedulerState(db, {
      serviceId: "github",
      cursor: "page-7",
      intervalMs: 300_000,
      lastSyncAt: 5_000,
      nextSyncAt: 305_000,
      status: "backoff",
      errorMsg: "429",
      consecutiveFailures: 2,
      paused: true,
    });
    const stored = loadSchedulerState(db, "github");
    expect(stored).toMatchObject({ cursor: "page-7", status: "backoff", paused: 1 });
    if (stored === null) throw new Error("unreachable: asserted above");

    upsertSchedulerRegistration(db, "github", 60_000, 9_999, false);
    expect(loadSchedulerState(db, "github")).toEqual(stored);

    upsertSchedulerRegistration(db, "github", 60_000, 9_999, true);
    expect(loadSchedulerState(db, "github")).toEqual({ ...stored, interval_ms: 60_000 });
  });

  test("a persisted status outside ok/backoff/error loads as null rather than a mistyped row", () => {
    rawState("jira", "paused");
    expect(loadSchedulerState(db, "jira")).toBeNull();
    // Control: the same row with a known status loads.
    rawState("slack", "error");
    expect(loadSchedulerState(db, "slack")?.status).toBe("error");
  });
});

describe("single-column setters touch only their column and only their service", () => {
  test("next-sync, paused, interval, cursor clear, and delete", () => {
    upsertSchedulerRegistration(db, "a", 1_000, 10, false);
    upsertSchedulerRegistration(db, "b", 2_000, 20, false);
    updateSchedulerState(db, {
      serviceId: "a",
      cursor: "c1",
      intervalMs: 1_000,
      lastSyncAt: 5,
      nextSyncAt: 10,
      status: "ok",
      errorMsg: null,
      consecutiveFailures: 0,
      paused: false,
    });
    const untouchedB = loadSchedulerState(db, "b");

    setNextSyncAt(db, "a", null);
    setPaused(db, "a", true);
    setIntervalMs(db, "a", 7_000);
    clearSchedulerCursor(db, "a");
    expect(loadSchedulerState(db, "a")).toMatchObject({
      next_sync_at: null,
      paused: 1,
      interval_ms: 7_000,
      cursor: null,
      last_sync_at: 5,
    });
    setPaused(db, "a", false);
    expect(loadSchedulerState(db, "a")?.paused).toBe(0);

    deleteSchedulerStateRow(db, "a");
    expect(loadSchedulerState(db, "a")).toBeNull();
    expect(loadSchedulerState(db, "b")).toEqual(untouchedB);
  });
});

describe("listAllSchedulerStates", () => {
  test("returns every well-formed row by service id, silently skipping unknown statuses", () => {
    rawState("zendesk", "ok");
    rawState("bitbucket", "mystery");
    rawState("github", "backoff");
    expect(listAllSchedulerStates(db).map((r) => [r.service_id, r.status])).toEqual([
      ["github", "backoff"],
      ["zendesk", "ok"],
    ]);
  });
});

describe("item counts", () => {
  test("per-service and any-of-services counts see only the named services", () => {
    insertItem("github:1", "github");
    insertItem("github:2", "github");
    insertItem("jira:1", "jira");
    insertItem("slack:1", "slack");
    expect(countItemsForService(db, "github")).toBe(2);
    expect(countItemsForService(db, "nope")).toBe(0);
    expect(countItemsForAnyService(db, ["github", "jira"])).toBe(3);
    expect(countItemsForAnyService(db, ["nope"])).toBe(0);
  });

  test("an EMPTY service list answers 0 without issuing a query at all", () => {
    // A database with no `item` table: any query would throw "no such table".
    const bare = new Database(":memory:");
    try {
      expect(countItemsForAnyService(bare, [])).toBe(0);
      // Control: the same database DOES throw once a query is actually issued.
      expect(() => countItemsForAnyService(bare, ["github"])).toThrow(/no such table/);
    } finally {
      bare.close();
    }
  });
});

describe("sync telemetry", () => {
  test("reads back newest-first for one service, with had_more mapped to a boolean", () => {
    insertSyncTelemetry(db, {
      service: "github",
      startedAt: 100,
      durationMs: 5,
      itemsUpserted: 3,
      itemsDeleted: 0,
      bytesTransferred: null,
      hadMore: false,
      errorMsg: null,
    });
    insertSyncTelemetry(db, {
      service: "github",
      startedAt: 200,
      durationMs: 7,
      itemsUpserted: 1,
      itemsDeleted: 2,
      bytesTransferred: 4_096,
      hadMore: true,
      errorMsg: "partial",
    });
    insertSyncTelemetry(db, {
      service: "jira",
      startedAt: 300,
      durationMs: 1,
      itemsUpserted: 0,
      itemsDeleted: 0,
      bytesTransferred: null,
      hadMore: false,
      errorMsg: null,
    });
    expect(listRecentSyncTelemetry(db, "github", 10)).toEqual([
      {
        startedAt: 200,
        durationMs: 7,
        itemsUpserted: 1,
        itemsDeleted: 2,
        bytesTransferred: 4_096,
        hadMore: true,
        errorMsg: "partial",
      },
      {
        startedAt: 100,
        durationMs: 5,
        itemsUpserted: 3,
        itemsDeleted: 0,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: null,
      },
    ]);
  });

  test("the limit is clamped to 1..100 and floored", () => {
    for (let i = 0; i < 105; i++) {
      insertSyncTelemetry(db, {
        service: "s",
        startedAt: i,
        durationMs: 1,
        itemsUpserted: 0,
        itemsDeleted: 0,
        bytesTransferred: null,
        hadMore: false,
        errorMsg: null,
      });
    }
    expect(listRecentSyncTelemetry(db, "s", 0)).toHaveLength(1);
    expect(listRecentSyncTelemetry(db, "s", -5)).toHaveLength(1);
    expect(listRecentSyncTelemetry(db, "s", 2.9)).toHaveLength(2);
    expect(listRecentSyncTelemetry(db, "s", 1_000)).toHaveLength(100);
    expect(listRecentSyncTelemetry(db, "s", 1_000)[0]?.startedAt).toBe(104);
  });
});
