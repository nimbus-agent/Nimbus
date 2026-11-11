import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner";

export interface WorkflowRunHistoryRow {
  readonly id: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly status: string;
  readonly errorMsg: string | null;
  readonly dryRun: boolean;
  readonly paramsOverrideJson: string | null;
  readonly triggeredBy: string;
}

export interface WorkflowRunListResult {
  readonly runs: ReadonlyArray<WorkflowRunHistoryRow>;
}

export interface ListWorkflowRunsParams {
  readonly workflowName: string;
  readonly limit: number;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const WORKFLOW_RUN_SCHEMA_VERSION = 9;

function clamp(n: number): number {
  if (!Number.isFinite(n) || n < MIN_LIMIT) return 0;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(n);
}

export function listWorkflowRuns(
  db: Database,
  params: ListWorkflowRunsParams,
): WorkflowRunListResult {
  if (readIndexedUserVersion(db) < WORKFLOW_RUN_SCHEMA_VERSION) return { runs: [] };
  const limit = clamp(params.limit);
  if (limit === 0) return { runs: [] };
  const rows = db
    .query(
      `SELECT r.id, r.started_at, r.finished_at, r.status, r.error_msg,
              r.dry_run, r.params_override_json, r.triggered_by
       FROM workflow_run AS r
       INNER JOIN workflow AS w ON w.id = r.workflow_id
       WHERE w.name = ?
       ORDER BY r.started_at DESC
       LIMIT ?`,
    )
    .all(params.workflowName, limit) as Array<{
    id: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    error_msg: string | null;
    dry_run: number;
    params_override_json: string | null;
    triggered_by: string;
  }>;
  return {
    runs: rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.finished_at === null ? null : r.finished_at - r.started_at,
      status: r.status,
      errorMsg: r.error_msg,
      dryRun: r.dry_run === 1,
      paramsOverrideJson: r.params_override_json,
      triggeredBy: r.triggered_by,
    })),
  };
}

export function pruneWorkflowRuns(db: Database, workflowId: string, keep: number): number {
  if (readIndexedUserVersion(db) < WORKFLOW_RUN_SCHEMA_VERSION) return 0;
  const res = dbRun(
    db,
    `DELETE FROM workflow_run
     WHERE workflow_id = ?
       AND status <> 'blocked_on_approval'
       AND id NOT IN (
         SELECT id FROM workflow_run
         WHERE workflow_id = ?
         ORDER BY started_at DESC
         LIMIT ?
       )`,
    [workflowId, workflowId, keep],
  );
  return res.changes;
}
