import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface PurgeRequestRow {
  jobId: string;
  peerId: string;
  status: string;
  attempts: number;
}

/**
 * Durable, per-peer state for a GDPR purge job. The rows persisted here form the
 * compliance ledger: they are retained INDEFINITELY (never pruned, not subject to
 * the `retention.min_days` floor that governs `tool_call_log`). No deletion logic
 * lives here by design.
 */
export class GdprPurgeStore {
  constructor(private readonly db: Database) {}

  openJob(p: {
    jobId: string;
    externalId: string;
    peers: readonly string[];
    openedAt: number;
  }): void {
    this.db.transaction(() => {
      dbRun(
        this.db,
        "INSERT INTO gdpr_purge_job (job_id, external_id, opened_at) VALUES (?, ?, ?)",
        [p.jobId, p.externalId, p.openedAt],
      );
      for (const peer of p.peers) {
        dbRun(
          this.db,
          "INSERT INTO gdpr_purge_request (job_id, peer_id, status) VALUES (?, ?, 'pending')",
          [p.jobId, peer],
        );
      }
    })();
  }

  pendingRequests(jobId: string): PurgeRequestRow[] {
    const rows = this.db
      .query(
        "SELECT job_id, peer_id, status, attempts FROM gdpr_purge_request WHERE job_id = ? AND status = 'pending'",
      )
      .all(jobId) as {
      job_id: string;
      peer_id: string;
      status: string;
      attempts: number;
    }[];
    return rows.map((r) => ({
      jobId: r.job_id,
      peerId: r.peer_id,
      status: r.status,
      attempts: r.attempts,
    }));
  }

  openJobIds(): string[] {
    // Drive off the job table so zero-peer jobs (opened with peers: [], which have no
    // request rows) are still surfaced and can be closed. A job is open while it has no
    // closed_at AND either has a pending request or has no request rows at all.
    const rows = this.db
      .query(
        `SELECT j.job_id
         FROM gdpr_purge_job j
         WHERE j.closed_at IS NULL
           AND (
             EXISTS (
               SELECT 1
               FROM gdpr_purge_request r
               WHERE r.job_id = j.job_id AND r.status = 'pending'
             )
             OR NOT EXISTS (
               SELECT 1
               FROM gdpr_purge_request r2
               WHERE r2.job_id = j.job_id
             )
           )`,
      )
      .all() as { job_id: string }[];
    return rows.map((r) => r.job_id);
  }

  markDone(jobId: string, peerId: string, deletionRecord: string, nowMs: number): void {
    dbRun(
      this.db,
      "UPDATE gdpr_purge_request SET status = 'done', deletion_record = ?, last_attempt_ms = ? WHERE job_id = ? AND peer_id = ?",
      [deletionRecord, nowMs, jobId, peerId],
    );
  }

  incrementAttempt(jobId: string, peerId: string, nowMs: number): void {
    dbRun(
      this.db,
      "UPDATE gdpr_purge_request SET attempts = attempts + 1, last_attempt_ms = ? WHERE job_id = ? AND peer_id = ?",
      [nowMs, jobId, peerId],
    );
  }

  allDone(jobId: string): boolean {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM gdpr_purge_request WHERE job_id = ? AND status != 'done'")
      .get(jobId) as { n: number };
    return row.n === 0;
  }

  closeJob(jobId: string, completionSig: string, nowMs: number): void {
    dbRun(this.db, "UPDATE gdpr_purge_job SET closed_at = ?, completion_sig = ? WHERE job_id = ?", [
      nowMs,
      completionSig,
      jobId,
    ]);
  }
}
