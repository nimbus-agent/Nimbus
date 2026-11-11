import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  steps_json: string;
  created_at: number;
  updated_at: number;
  /** Schema V89: present only on a database at that version. */
  schedule?: string | null;
  schedule_tz?: string | null;
  schedule_next_at?: number | null;
  schedule_last_fire_at?: number | null;
};

/** A workflow's schedule (schema V89). `expr` and `tz` are validated and the zone resolved at save. */
export type WorkflowSchedule = {
  readonly expr: string;
  readonly tz: string;
  readonly nextAt: number;
};

export type ScheduledWorkflowRow = {
  id: string;
  name: string;
  steps_json: string;
  schedule: string;
  schedule_tz: string;
  schedule_next_at: number | null;
  schedule_last_fire_at: number | null;
};

const SCHEDULE_SCHEMA_VERSION = 89;

export function getWorkflowByName(db: Database, name: string): WorkflowRow | null {
  if (readIndexedUserVersion(db) < 9) {
    return null;
  }
  const row = db
    .query(
      `SELECT id, name, description, steps_json, created_at, updated_at FROM workflow WHERE name = ?`,
    )
    .get(name) as WorkflowRow | null | undefined;
  return row ?? null;
}

export function listWorkflows(db: Database): WorkflowRow[] {
  const version = readIndexedUserVersion(db);
  if (version < 9) {
    return [];
  }
  const schedule =
    version >= SCHEDULE_SCHEMA_VERSION
      ? ", schedule, schedule_tz, schedule_next_at, schedule_last_fire_at"
      : "";
  return db
    .query(
      `SELECT id, name, description, steps_json, created_at, updated_at${schedule}
       FROM workflow ORDER BY name`,
    )
    .all() as WorkflowRow[];
}

export function upsertWorkflowByName(
  db: Database,
  name: string,
  description: string | null,
  stepsJson: string,
  now: number,
  schedule: WorkflowSchedule | null = null,
): string {
  const version = readIndexedUserVersion(db);
  if (version < 9) {
    throw new Error("Workflow schema requires v9+");
  }
  const existing = db.query(`SELECT id FROM workflow WHERE name = ?`).get(name) as
    | { id: string }
    | null
    | undefined;
  let id: string;
  if (existing?.id === undefined) {
    id = randomUUID();
    dbRun(
      db,
      `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, description, stepsJson, now, now],
    );
  } else {
    id = existing.id;
    dbRun(db, `UPDATE workflow SET description = ?, steps_json = ?, updated_at = ? WHERE id = ?`, [
      description,
      stepsJson,
      now,
      id,
    ]);
  }
  // A save never keeps the old schedule: it sets the one given or clears it (SA4, plan task 3).
  if (version >= SCHEDULE_SCHEMA_VERSION) setWorkflowSchedule(db, id, schedule);
  return id;
}

/** Sets or clears (`null`) a workflow's schedule; the last-fire time is history and stays. */
export function setWorkflowSchedule(
  db: Database,
  workflowId: string,
  schedule: WorkflowSchedule | null,
): void {
  dbRun(
    db,
    `UPDATE workflow SET schedule = ?, schedule_tz = ?, schedule_next_at = ? WHERE id = ?`,
    [schedule?.expr ?? null, schedule?.tz ?? null, schedule?.nextAt ?? null, workflowId],
  );
}

/** Clears the schedule of the named workflow; false when there is no such workflow. */
export function clearScheduleByName(db: Database, name: string): boolean {
  if (readIndexedUserVersion(db) < SCHEDULE_SCHEMA_VERSION) return false;
  const r = dbRun(
    db,
    `UPDATE workflow SET schedule = NULL, schedule_tz = NULL, schedule_next_at = NULL WHERE name = ?`,
    [name],
  );
  return r.changes > 0;
}

const SCHEDULED_COLUMNS =
  "id, name, steps_json, schedule, schedule_tz, schedule_next_at, schedule_last_fire_at";

/** Every scheduled workflow, by name. */
export function listScheduledWorkflows(db: Database): ScheduledWorkflowRow[] {
  if (readIndexedUserVersion(db) < SCHEDULE_SCHEMA_VERSION) return [];
  return db
    .query(`SELECT ${SCHEDULED_COLUMNS} FROM workflow WHERE schedule IS NOT NULL ORDER BY name`)
    .all() as ScheduledWorkflowRow[];
}

/** The scheduled workflows whose next fire is at or before `now`, oldest due first. */
export function listDueWorkflows(db: Database, now: number): ScheduledWorkflowRow[] {
  if (readIndexedUserVersion(db) < SCHEDULE_SCHEMA_VERSION) return [];
  return db
    .query(
      `SELECT ${SCHEDULED_COLUMNS} FROM workflow
       WHERE schedule IS NOT NULL AND schedule_next_at IS NOT NULL AND schedule_next_at <= ?
       ORDER BY schedule_next_at ASC, name ASC`,
    )
    .all(now) as ScheduledWorkflowRow[];
}

/** Moves a workflow's next fire (and, when it fired or was skipped, its last-fire time). */
export function advanceSchedule(
  db: Database,
  workflowId: string,
  nextAt: number | null,
  lastFireAt?: number,
): void {
  if (lastFireAt === undefined) {
    dbRun(db, `UPDATE workflow SET schedule_next_at = ? WHERE id = ?`, [nextAt, workflowId]);
    return;
  }
  dbRun(db, `UPDATE workflow SET schedule_next_at = ?, schedule_last_fire_at = ? WHERE id = ?`, [
    nextAt,
    lastFireAt,
    workflowId,
  ]);
}

export function deleteWorkflowByName(db: Database, name: string): boolean {
  if (readIndexedUserVersion(db) < 9) {
    return false;
  }
  const r = dbRun(db, `DELETE FROM workflow WHERE name = ?`, [name]);
  return r.changes > 0;
}

export function insertWorkflowRunRow(
  db: Database,
  row: {
    id: string;
    workflowId: string;
    triggeredBy: string;
    status: string;
    startedAt: number;
    dryRun?: boolean;
    paramsOverrideJson?: string | null;
    /** The run's derived trigger and the hash of the definition it executes (V89; history, never authority). */
    trigger?: string | null;
    workflowSha256?: string | null;
  },
): void {
  if (readIndexedUserVersion(db) < SCHEDULE_SCHEMA_VERSION) {
    dbRun(
      db,
      `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, dry_run, params_override_json)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        row.id,
        row.workflowId,
        row.triggeredBy,
        row.status,
        row.startedAt,
        row.dryRun === true ? 1 : 0,
        row.paramsOverrideJson ?? null,
      ],
    );
    return;
  }
  dbRun(
    db,
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, dry_run, params_override_json, trigger, workflow_sha256)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      row.id,
      row.workflowId,
      row.triggeredBy,
      row.status,
      row.startedAt,
      row.dryRun === true ? 1 : 0,
      row.paramsOverrideJson ?? null,
      row.trigger ?? null,
      row.workflowSha256 ?? null,
    ],
  );
}

/**
 * Finishes a blocked run as `abandoned` (resumed elsewhere, or discarded). Only a run that is still
 * `blocked_on_approval` changes; anything else throws, so two resumes cannot both win.
 */
export function abandonWorkflowRunRow(db: Database, id: string, at: number): void {
  const r = dbRun(
    db,
    `UPDATE workflow_run SET status = 'abandoned', finished_at = ?
     WHERE id = ? AND status = 'blocked_on_approval'`,
    [at, id],
  );
  if (r.changes !== 1) {
    throw new Error("ERR_RUN_NOT_BLOCKED: the run is no longer waiting for approval");
  }
}

/** Marks a run as stopped at a write step that no standing rule covered (V89). */
export function blockWorkflowRunRow(
  db: Database,
  id: string,
  blockedStep: number,
  blockedAt: number,
  errorMsg: string,
): void {
  dbRun(
    db,
    `UPDATE workflow_run SET status = 'blocked_on_approval', blocked_step = ?, blocked_at = ?, finished_at = ?, error_msg = ? WHERE id = ?`,
    [blockedStep, blockedAt, blockedAt, errorMsg, id],
  );
}

export function finishWorkflowRunRow(
  db: Database,
  id: string,
  status: string,
  finishedAt: number,
  errorMsg: string | null,
): void {
  dbRun(db, `UPDATE workflow_run SET status = ?, finished_at = ?, error_msg = ? WHERE id = ?`, [
    status,
    finishedAt,
    errorMsg,
    id,
  ]);
}

export function insertWorkflowRunStepRow(
  db: Database,
  row: {
    runId: string;
    stepIndex: number;
    label: string | null;
    status: string;
    startedAt: number;
  },
): void {
  dbRun(
    db,
    `INSERT INTO workflow_run_step (run_id, step_index, label, status, hitl_action, hitl_approved, result_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
    [row.runId, row.stepIndex, row.label, row.status, row.startedAt],
  );
}

export function updateWorkflowRunStepRow(
  db: Database,
  runId: string,
  stepIndex: number,
  patch: { status: string; resultJson: string | null; finishedAt: number },
): void {
  dbRun(
    db,
    `UPDATE workflow_run_step SET status = ?, result_json = ?, finished_at = ?
     WHERE run_id = ? AND step_index = ?`,
    [patch.status, patch.resultJson, patch.finishedAt, runId, stepIndex],
  );
}
