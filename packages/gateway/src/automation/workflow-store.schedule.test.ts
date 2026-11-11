// Phase 10 SA4: the schedule and blocked-run columns of the workflow store, at V89 and (for the
// version guards) at V88.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import {
  abandonWorkflowRunRow,
  advanceSchedule,
  blockWorkflowRunRow,
  clearScheduleByName,
  insertWorkflowRunRow,
  listDueWorkflows,
  listScheduledWorkflows,
  listWorkflows,
  setWorkflowSchedule,
  upsertWorkflowByName,
} from "./workflow-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function dbAt(version: number): Database {
  ensureFullSqlite();
  const db = new Database(":memory:");
  dbs.push(db);
  runIndexedSchemaMigrations(db, version);
  return db;
}

const SCHEDULE = { expr: "0 6 * * *", tz: "UTC", nextAt: 5000 };

describe("schedule columns (V89)", () => {
  test("a save stores the schedule, a later save without one clears it, last-fire history stays", () => {
    const db = dbAt(89);
    const id = upsertWorkflowByName(db, "w", null, "[]", 1, SCHEDULE);
    expect(listScheduledWorkflows(db)).toMatchObject([
      { id, name: "w", schedule: "0 6 * * *", schedule_tz: "UTC", schedule_next_at: 5000 },
    ]);
    advanceSchedule(db, id, 9000, 8000);
    upsertWorkflowByName(db, "w", "d", "[]", 2);
    expect(listScheduledWorkflows(db)).toEqual([]);
    const [row] = listWorkflows(db);
    expect(row).toMatchObject({
      schedule: null,
      schedule_tz: null,
      schedule_next_at: null,
      schedule_last_fire_at: 8000,
    });
  });

  test("clearScheduleByName clears one workflow and reports a miss", () => {
    const db = dbAt(89);
    upsertWorkflowByName(db, "a", null, "[]", 1, SCHEDULE);
    upsertWorkflowByName(db, "b", null, "[]", 1, SCHEDULE);
    expect(clearScheduleByName(db, "a")).toBe(true);
    expect(clearScheduleByName(db, "nope")).toBe(false);
    expect(listScheduledWorkflows(db).map((w) => w.name)).toEqual(["b"]);
  });

  test("due workflows are those at or before now, oldest first, ties by name", () => {
    const db = dbAt(89);
    const ids = ["c", "a", "b", "later"].map((n) => upsertWorkflowByName(db, n, null, "[]", 1));
    setWorkflowSchedule(db, ids[0] as string, { ...SCHEDULE, nextAt: 100 });
    setWorkflowSchedule(db, ids[1] as string, { ...SCHEDULE, nextAt: 100 });
    setWorkflowSchedule(db, ids[2] as string, { ...SCHEDULE, nextAt: 50 });
    setWorkflowSchedule(db, ids[3] as string, { ...SCHEDULE, nextAt: 101 });
    expect(listDueWorkflows(db, 100).map((w) => w.name)).toEqual(["b", "a", "c"]);
    advanceSchedule(db, ids[2] as string, null);
    expect(listDueWorkflows(db, 100).map((w) => w.name)).toEqual(["a", "c"]);
  });

  test("a run row records its trigger and hash; a blocked run is blocked once and abandoned once", () => {
    const db = dbAt(89);
    const wf = upsertWorkflowByName(db, "w", null, "[]", 1);
    insertWorkflowRunRow(db, {
      id: "r1",
      workflowId: wf,
      triggeredBy: "scheduler",
      status: "running",
      startedAt: 10,
      trigger: "schedule",
      workflowSha256: "a".repeat(64),
    });
    blockWorkflowRunRow(db, "r1", 2, 20, "waiting");
    expect(db.query("SELECT * FROM workflow_run WHERE id = 'r1'").get()).toMatchObject({
      status: "blocked_on_approval",
      blocked_step: 2,
      blocked_at: 20,
      finished_at: 20,
      error_msg: "waiting",
      trigger: "schedule",
      workflow_sha256: "a".repeat(64),
    });
    abandonWorkflowRunRow(db, "r1", 30);
    expect(db.query("SELECT status, finished_at FROM workflow_run WHERE id = 'r1'").get()).toEqual({
      status: "abandoned",
      finished_at: 30,
    });
    expect(() => abandonWorkflowRunRow(db, "r1", 31)).toThrow("ERR_RUN_NOT_BLOCKED");
  });
});

describe("a V88 database (the version guards)", () => {
  test("the schedule helpers return nothing and the run insert uses the old columns", () => {
    const db = dbAt(88);
    const id = upsertWorkflowByName(db, "w", null, "[]", 1, SCHEDULE);
    expect(listScheduledWorkflows(db)).toEqual([]);
    expect(listDueWorkflows(db, 1e12)).toEqual([]);
    expect(clearScheduleByName(db, "w")).toBe(false);
    expect(Object.keys(listWorkflows(db)[0] ?? {})).not.toContain("schedule");
    insertWorkflowRunRow(db, {
      id: "r1",
      workflowId: id,
      triggeredBy: "x",
      status: "running",
      startedAt: 1,
      trigger: "schedule",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM workflow_run").get()).toEqual({ n: 1 });
  });
});
