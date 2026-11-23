import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

/**
 * The ONLY writer of `incident_proposal` and `incident_engine_state` (Phase 10 IC5a, static D46(c)). A proposal
 * is a remediation the engine OFFERS for an incident record; nothing here runs it. Every status move is ONE
 * conditional `UPDATE ... WHERE id = ? AND status = ?`, so a second concurrent claim finds zero rows changed and
 * is refused (`busy`); a status is never read and then written. Every function uses bound parameters (I9, I14)
 * and imports nothing from `incident/` or `index/`.
 *
 * Lifecycle: `proposed` to `executing` (the claim) to `executed`, `failed` or `denied`; or `proposed` to
 * `expired` (past its TTL) or `superseded` (a re-derivation no longer offers it). Only an explicit owner
 * LISTING revives an `expired`, `superseded`, `denied` or `failed` proposal that is still derived
 * (`revive: true`); `executing` and `executed` are never revived. An `executing` row older than
 * {@link STALE_EXECUTING_MS} (a crashed gateway) becomes `failed` at the next sync, and an `undoing` one is released
 * to NULL so the owner can retry the undo.
 */

export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;
export const STALE_EXECUTING_MS = 30 * 60 * 1000;

export type ProposalStatus =
  | "proposed"
  | "executing"
  | "executed"
  | "failed"
  | "denied"
  | "expired"
  | "superseded";
export type ProposalReversibility = "reversible" | "irreversible" | "unknown";
export type UndoStatus = "undoing" | "undone";

export type ProposalDraft = {
  /** `prp_` plus 16 hex, derived from the record, the kind, the tool and the input (`proposals.ts`). */
  readonly id: string;
  readonly kind: string;
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly evidence: unknown;
  readonly confidence: number | null;
  readonly reversibility: ProposalReversibility;
};

export type ProposalRow = {
  readonly id: string;
  readonly record_id: string;
  readonly record_version: number;
  readonly kind: string;
  readonly tool_id: string;
  readonly input_json: string;
  readonly evidence_json: string;
  readonly confidence: number | null;
  readonly reversibility: ProposalReversibility;
  readonly status: ProposalStatus;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly updated_at_ms: number;
  readonly action_id: string | null;
  readonly captured_json: string | null;
  readonly undo_status: UndoStatus | null;
  readonly undone_at_ms: number | null;
  /** When the action finished running (V106); null for a proposal that never ran or an older undone one. */
  readonly executed_at_ms: number | null;
};

export type SyncOutcome = {
  readonly expired: number;
  readonly superseded: number;
  readonly staleExecuting: number;
  /** Undos left `undoing` by a crashed gateway, released so the owner can retry them. */
  readonly staleUndoing: number;
};

/**
 * Bring the stored proposals of one record in line with what was just derived, in ONE transaction:
 * executing rows older than the stale bound fail; due `proposed` rows expire; `proposed` rows no longer derived
 * are superseded; each draft is inserted or refreshed (a `proposed` row keeps its original expiry; a refreshed
 * row records the record version it was derived from). With `revive`, a derived `expired`, `superseded`,
 * `denied` or `failed` row becomes `proposed` again with a fresh TTL. The stale sweeps exist for a gateway that
 * crashed mid-run, so a row in `live` (a proposal THIS process is still running or undoing, however long the
 * owner takes to answer) is never failed or released by them.
 */
export function syncProposals(
  db: Database,
  input: {
    readonly recordId: string;
    readonly version: number;
    readonly drafts: readonly ProposalDraft[];
    readonly nowMs: number;
    readonly revive: boolean;
    /** Proposal ids this process is running or undoing now: never swept as stale. */
    readonly live?: readonly string[];
  },
): SyncOutcome {
  const { recordId, version, drafts, nowMs, revive } = input;
  const live = input.live ?? [];
  const notLive = live.length === 0 ? "" : ` AND id NOT IN (${live.map(() => "?").join(",")})`;
  const tx = db.transaction((): SyncOutcome => {
    const staleExecuting = dbRun(
      db,
      `UPDATE incident_proposal SET status = 'failed', updated_at_ms = ?
        WHERE status = 'executing' AND updated_at_ms < ?${notLive}`,
      [nowMs, nowMs - STALE_EXECUTING_MS, ...live],
    ).changes;
    const staleUndoing = dbRun(
      db,
      `UPDATE incident_proposal SET undo_status = NULL, updated_at_ms = ?
        WHERE undo_status = 'undoing' AND updated_at_ms < ?${notLive}`,
      [nowMs, nowMs - STALE_EXECUTING_MS, ...live],
    ).changes;
    const expired = dbRun(
      db,
      `UPDATE incident_proposal SET status = 'expired', updated_at_ms = ?
        WHERE status = 'proposed' AND expires_at_ms <= ?`,
      [nowMs, nowMs],
    ).changes;
    const keep = drafts.map((d) => d.id);
    const marks = keep.map(() => "?").join(",");
    const superseded = dbRun(
      db,
      `UPDATE incident_proposal SET status = 'superseded', updated_at_ms = ?
        WHERE record_id = ? AND status = 'proposed'${keep.length === 0 ? "" : ` AND id NOT IN (${marks})`}`,
      [nowMs, recordId, ...keep],
    ).changes;
    for (const d of drafts) {
      dbRun(
        db,
        `INSERT INTO incident_proposal
           (id, record_id, record_version, kind, tool_id, input_json, evidence_json, confidence,
            reversibility, status, created_at_ms, expires_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           record_version = excluded.record_version,
           evidence_json = excluded.evidence_json,
           confidence = excluded.confidence,
           reversibility = excluded.reversibility,
           updated_at_ms = excluded.updated_at_ms,
           expires_at_ms = CASE WHEN incident_proposal.status = 'proposed'
                                THEN incident_proposal.expires_at_ms ELSE excluded.expires_at_ms END,
           status = CASE WHEN incident_proposal.status = 'proposed' THEN 'proposed'
                         WHEN ? = 1 AND incident_proposal.status IN ('expired', 'superseded', 'denied', 'failed')
                         THEN 'proposed' ELSE incident_proposal.status END
         WHERE incident_proposal.status NOT IN ('executing', 'executed')`,
        [
          d.id,
          recordId,
          version,
          d.kind,
          d.toolId,
          JSON.stringify(d.input),
          JSON.stringify(d.evidence),
          d.confidence,
          d.reversibility,
          nowMs,
          nowMs + PROPOSAL_TTL_MS,
          nowMs,
          revive ? 1 : 0,
        ],
      );
    }
    return { expired, superseded, staleExecuting, staleUndoing };
  });
  return tx();
}

export function getProposal(db: Database, id: string): ProposalRow | null {
  return db.query("SELECT * FROM incident_proposal WHERE id = ?").get(id) as ProposalRow | null;
}

export function getProposalByAction(db: Database, actionId: string): ProposalRow | null {
  return db
    .query("SELECT * FROM incident_proposal WHERE action_id = ?")
    .get(actionId) as ProposalRow | null;
}

/** Every stored proposal of a record, oldest first (the order is total: creation time, then id). */
export function listProposals(db: Database, recordId: string): ProposalRow[] {
  return db
    .query("SELECT * FROM incident_proposal WHERE record_id = ? ORDER BY created_at_ms ASC, id ASC")
    .all(recordId) as ProposalRow[];
}

export type ClaimOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "busy" | "expired" | "stale" | "missing" };

/**
 * `proposed` to `executing` in one statement. Zero rows changed means someone else holds it or it is no longer
 * claimable; a follow-up READ (never a write) names why, so the refusal can be specific.
 */
export function claimProposal(
  db: Database,
  id: string,
  actionId: string,
  nowMs: number,
): ClaimOutcome {
  const changed = dbRun(
    db,
    `UPDATE incident_proposal SET status = 'executing', action_id = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'proposed' AND expires_at_ms > ?`,
    [actionId, nowMs, id, nowMs],
  ).changes;
  if (changed === 1) return { ok: true };
  const row = getProposal(db, id);
  if (row === null) return { ok: false, reason: "missing" };
  if (row.status === "executing") return { ok: false, reason: "busy" };
  if (row.status === "proposed" || row.status === "expired")
    return { ok: false, reason: "expired" };
  return { ok: false, reason: "stale" };
}

/** `executing` to a terminal status (and the values the inverse needs), one statement. False if not executing. */
export function finishProposal(
  db: Database,
  id: string,
  to: "executed" | "failed" | "denied",
  nowMs: number,
  captured?: Readonly<Record<string, string>>,
): boolean {
  return (
    dbRun(
      db,
      `UPDATE incident_proposal
          SET status = ?, updated_at_ms = ?, captured_json = ?, executed_at_ms = ?
        WHERE id = ? AND status = 'executing'`,
      [
        to,
        nowMs,
        captured === undefined ? null : JSON.stringify(captured),
        to === "executed" ? nowMs : null,
        id,
      ],
    ).changes === 1
  );
}

/** Mark a `proposed` row `superseded` (a re-derivation at claim time found it changed). */
export function supersedeProposal(db: Database, id: string, nowMs: number): boolean {
  return (
    dbRun(
      db,
      "UPDATE incident_proposal SET status = 'superseded', updated_at_ms = ? WHERE id = ? AND status = 'proposed'",
      [nowMs, id],
    ).changes === 1
  );
}

/**
 * The executed, not-yet-undone actions that kept a before-state, newest run first (V106 `executed_at_ms`; the
 * action id breaks a tie). `nimbus incident undo` with no id walks this list and takes the first one whose row
 * is declared reversible; it is a READ and decides nothing by itself.
 */
export function listUndoCandidates(db: Database, limit: number): ProposalRow[] {
  return db
    .query(
      `SELECT * FROM incident_proposal
        WHERE status = 'executed' AND undo_status IS NULL AND action_id IS NOT NULL
          AND captured_json IS NOT NULL AND executed_at_ms IS NOT NULL
        ORDER BY executed_at_ms DESC, action_id DESC LIMIT ?`,
    )
    .all(limit) as ProposalRow[];
}

/** Take the single undo of an executed action: `executed` with no undo yet to `undoing`. False if not claimable. */
export function claimUndo(db: Database, actionId: string, nowMs: number): boolean {
  return (
    dbRun(
      db,
      `UPDATE incident_proposal SET undo_status = 'undoing', updated_at_ms = ?
        WHERE action_id = ? AND status = 'executed' AND undo_status IS NULL`,
      [nowMs, actionId],
    ).changes === 1
  );
}

/** `undoing` to `undone`, or (declined, failed) back to NULL so it can be retried. */
export function finishUndo(
  db: Database,
  actionId: string,
  outcome: "undone" | "retry",
  nowMs: number,
): boolean {
  return (
    dbRun(
      db,
      `UPDATE incident_proposal
          SET undo_status = ?, undone_at_ms = ?, updated_at_ms = ?
        WHERE action_id = ? AND undo_status = 'undoing'`,
      [
        outcome === "undone" ? "undone" : null,
        outcome === "undone" ? nowMs : null,
        nowMs,
        actionId,
      ],
    ).changes === 1
  );
}

/**
 * How many EXECUTED proposals a record has (the prior-incident lane's `actions`): what Nimbus did for it.
 * A record that was never acted on, or a pruned one, counts 0.
 */
export function executedCount(db: Database, recordId: string): number {
  return (
    db
      .query(
        "SELECT count(*) AS n FROM incident_proposal WHERE record_id = ? AND status = 'executed'",
      )
      .get(recordId) as { n: number }
  ).n;
}

/** Delete the proposals of erased records (an OWNER erasure only; retention keeps what Nimbus did). */
export function deleteProposalsForRecords(db: Database, recordIds: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < recordIds.length; i += 500) {
    const chunk = recordIds.slice(i, i + 500);
    n += dbRun(
      db,
      `DELETE FROM incident_proposal WHERE record_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    ).changes;
  }
  return n;
}

/** The engine's advisory switch (default OFF): `incident_engine_state` key `advisory`. */
export function isAdvisory(db: Database): boolean {
  const row = db.query("SELECT value FROM incident_engine_state WHERE key = 'advisory'").get() as {
    value: string;
  } | null;
  return row?.value === "on";
}

export function setAdvisory(db: Database, on: boolean, nowMs: number): void {
  dbRun(
    db,
    `INSERT INTO incident_engine_state (key, value, updated_at_ms) VALUES ('advisory', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    [on ? "on" : "off", nowMs],
  );
}
