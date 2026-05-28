import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { SubTaskExecuteResult, SubTaskType } from "./coordinator.ts";

export type SubAgentRunOptions = {
  sessionId: string;
  parentId: string;
  taskIndex: number;
  taskType: SubTaskType;
  db?: Database;
  execute: () => Promise<SubAgentRunResult>;
};

export type SubAgentRunResult = SubTaskExecuteResult;

function tryPersistStart(db: Database, opts: SubAgentRunOptions, now: number): number | undefined {
  try {
    const stmt = dbRun(
      db,
      `INSERT INTO sub_task_results
       (session_id, parent_id, task_index, task_type, status, started_at, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      [opts.sessionId, opts.parentId, opts.taskIndex, opts.taskType, now, now],
    );
    return stmt.lastInsertRowid as number;
  } catch {
    return undefined;
  }
}

function tryPersistDone(db: Database, rowId: number, result: SubAgentRunResult): void {
  try {
    dbRun(
      db,
      `UPDATE sub_task_results
       SET status = 'done', result_json = ?, model_used = ?, tokens_in = ?, tokens_out = ?, completed_at = ?
       WHERE id = ?`,
      [
        JSON.stringify({ text: result.text }),
        result.modelUsed ?? null,
        result.tokensIn,
        result.tokensOut,
        Date.now(),
        rowId,
      ],
    );
  } catch {
    /* best-effort */
  }
}

function tryPersistError(db: Database, rowId: number, e: unknown): void {
  try {
    dbRun(
      db,
      `UPDATE sub_task_results SET status = 'error', error_text = ?, completed_at = ? WHERE id = ?`,
      [e instanceof Error ? e.message : String(e), Date.now(), rowId],
    );
  } catch {
    /* best-effort */
  }
}

export async function runSubAgent(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const now = Date.now();
  const rowId = opts.db ? tryPersistStart(opts.db, opts, now) : undefined;

  try {
    const result = await opts.execute();
    if (opts.db && typeof rowId === "number") {
      tryPersistDone(opts.db, rowId, result);
    }
    return result;
  } catch (e) {
    if (opts.db && typeof rowId === "number") {
      tryPersistError(opts.db, rowId, e);
    }
    throw e;
  }
}
