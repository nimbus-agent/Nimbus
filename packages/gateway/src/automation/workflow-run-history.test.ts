import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { listWorkflowRuns, pruneWorkflowRuns } from "./workflow-run-history";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
     VALUES ('wf1', 'alpha', NULL, '[]', 0, 0)`,
  );
});

afterEach(() => db.close());

function insertRun(id: string, startedAt: number, dryRun = 0, status = "done"): void {
  db.run(
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, dry_run, params_override_json)
     VALUES (?, 'wf1', 'user', ?, ?, ?, NULL, ?, NULL)`,
    [id, status, startedAt, startedAt + 10, dryRun],
  );
}

test("listWorkflowRuns returns the last N runs newest-first", () => {
  for (let i = 0; i < 5; i++) insertRun(`r${i}`, 100 + i);
  const out = listWorkflowRuns(db, { workflowName: "alpha", limit: 3 });
  expect(out.runs).toHaveLength(3);
  expect(out.runs[0]?.id).toBe("r4");
  expect(out.runs[2]?.id).toBe("r2");
  expect(out.runs[0]?.durationMs).toBe(10);
  expect(out.runs[0]?.dryRun).toBe(false);
});

test("listWorkflowRuns surfaces dry_run as boolean", () => {
  insertRun("d1", 100, 1);
  const out = listWorkflowRuns(db, { workflowName: "alpha", limit: 10 });
  expect(out.runs[0]?.dryRun).toBe(true);
});

test("listWorkflowRuns returns empty for an unknown workflow", () => {
  const out = listWorkflowRuns(db, { workflowName: "missing", limit: 10 });
  expect(out.runs).toEqual([]);
});

test("listWorkflowRuns returns empty on a pre-v9 schema", () => {
  const fresh = new Database(":memory:");
  try {
    const out = listWorkflowRuns(fresh, { workflowName: "alpha", limit: 10 });
    expect(out.runs).toEqual([]);
  } finally {
    fresh.close();
  }
});

test("listWorkflowRuns clamps limit to 1..500", () => {
  for (let i = 0; i < 501; i++) insertRun(`r${i}`, i);
  const out0 = listWorkflowRuns(db, { workflowName: "alpha", limit: 0 });
  expect(out0.runs).toEqual([]);
  const outBig = listWorkflowRuns(db, { workflowName: "alpha", limit: 10000 });
  expect(outBig.runs).toHaveLength(500);
});

test("listWorkflowRuns handles null finished_at (durationMs = null)", () => {
  db.run(
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, dry_run, params_override_json)
     VALUES ('running1', 'wf1', 'user', 'running', 500, NULL, NULL, 0, NULL)`,
  );
  const out = listWorkflowRuns(db, { workflowName: "alpha", limit: 1 });
  expect(out.runs[0]?.durationMs).toBeNull();
  expect(out.runs[0]?.finishedAt).toBeNull();
});

test("pruneWorkflowRuns keeps the newest N per workflow", () => {
  for (let i = 0; i < 110; i++) insertRun(`r${i}`, i);
  const deleted = pruneWorkflowRuns(db, "wf1", 100);
  expect(deleted).toBe(10);
  const remain = db
    .query(`SELECT COUNT(*) AS c FROM workflow_run WHERE workflow_id = 'wf1'`)
    .get() as { c: number };
  expect(remain.c).toBe(100);
  const oldest = db
    .query(`SELECT MIN(started_at) AS m FROM workflow_run WHERE workflow_id = 'wf1'`)
    .get() as { m: number };
  expect(oldest.m).toBe(10);
});

test("pruneWorkflowRuns is a no-op when under the cap", () => {
  for (let i = 0; i < 5; i++) insertRun(`r${i}`, i);
  const deleted = pruneWorkflowRuns(db, "wf1", 100);
  expect(deleted).toBe(0);
});

test("pruneWorkflowRuns returns 0 on a pre-v9 schema", () => {
  const fresh = new Database(":memory:");
  try {
    const deleted = pruneWorkflowRuns(fresh, "wf1", 100);
    expect(deleted).toBe(0);
  } finally {
    fresh.close();
  }
});
