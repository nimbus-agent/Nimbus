import type { Database } from "bun:sqlite";
import type { CuLane } from "../config/nimbus-toml.ts";
import { dbRun } from "../db/write.ts";

/**
 * The V57 "replay body" store (spec § 8.3): `cu_session` / `cu_action`. The DECISIONS ride the
 * chained `audit_log` (via `appendAuditEntry` in `cu-gate.ts`); these tables carry the bulky,
 * retention-pruned snapshot bodies. Every write goes through `dbRun` with bound parameters
 * (invariants I9/I14) — no string-interpolated SQL, anywhere in this file.
 */

export interface InsertSessionInput {
  readonly id: string;
  readonly lane: CuLane;
  readonly envelopeJson: string;
  readonly openedAt: number;
}

export function insertSession(db: Database, input: InsertSessionInput): void {
  dbRun(
    db,
    `INSERT INTO cu_session (id, lane, envelope_json, opened_at, actions_used) VALUES (?, ?, ?, ?, 0)`,
    [input.id, input.lane, input.envelopeJson, input.openedAt],
  );
}

export interface UpdateSessionStateInput {
  readonly actionsUsed?: number;
  readonly taintedAt?: number | null;
  readonly closedAt?: number | null;
  readonly closeReason?: string | null;
}

/**
 * The SQL fragments below are fixed string literals chosen by this function's own branching on
 * which optional field was supplied — never derived from external input — so this is not an I9
 * identifier-escaping concern: only the bound `?` parameters carry caller-supplied values.
 */
export function updateSessionState(
  db: Database,
  sessionId: string,
  patch: UpdateSessionStateInput,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.actionsUsed !== undefined) {
    sets.push("actions_used = ?");
    params.push(patch.actionsUsed);
  }
  if (patch.taintedAt !== undefined) {
    sets.push("tainted_at = ?");
    params.push(patch.taintedAt);
  }
  if (patch.closedAt !== undefined) {
    sets.push("closed_at = ?");
    params.push(patch.closedAt);
  }
  if (patch.closeReason !== undefined) {
    sets.push("close_reason = ?");
    params.push(patch.closeReason);
  }
  if (sets.length === 0) return;
  params.push(sessionId);
  dbRun(db, `UPDATE cu_session SET ${sets.join(", ")} WHERE id = ?`, params);
}

export interface OpenSessionRow {
  readonly id: string;
  readonly lane: string;
  readonly openedAt: number;
}

/**
 * Every `cu_session` row still recorded as open (`closed_at IS NULL`).
 *
 * Read at boot by `cu-boot-reconcile.ts`. A row is durable and the gate's `liveSessions` map is
 * not, so after a restart every previously-open row is by definition an orphan: the browser it
 * named died with the gateway that spawned it.
 */
export function listOpenSessions(db: Database): OpenSessionRow[] {
  return db
    .query<{ id: string; lane: string; opened_at: number }, []>(
      `SELECT id, lane, opened_at FROM cu_session WHERE closed_at IS NULL ORDER BY opened_at ASC`,
    )
    .all()
    .map((r) => ({ id: r.id, lane: r.lane, openedAt: r.opened_at }));
}

export interface InsertActionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly classification: "observing" | "actuating";
  readonly observedTarget: string;
  readonly modelDescription: string | null;
  readonly hitlStatus: string;
  readonly outcome: string;
  readonly domBefore: string | null;
  readonly domAfter: string | null;
  readonly screenshotDigest: string | null;
  readonly timestamp: number;
}

interface Truncated {
  readonly value: string | null;
  readonly truncated: boolean;
  readonly originalBytes: number | null;
}

function truncateSnapshot(s: string | null, maxBytes: number): Truncated {
  if (s === null) return { value: null, truncated: false, originalBytes: null };
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= maxBytes) return { value: s, truncated: false, originalBytes: null };
  // Truncate by BYTES, not JS string length, so `snapshot_max_bytes` is respected precisely even
  // with multi-byte characters near the boundary.
  const clipped = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
  return { value: clipped, truncated: true, originalBytes: bytes };
}

/**
 * Insert one `cu_action` replay-body row, truncating `dom_before`/`dom_after` at
 * `snapshotMaxBytes` (spec § 8.4) and recording `dom_truncated` + `dom_original_bytes` so a
 * clipped snapshot can never be mistaken for a complete one.
 *
 * KNOWN LIMIT: the V57 schema carries a single `dom_original_bytes` column for two independently
 * truncatable fields (`dom_before`, `dom_after`). When both are truncated this records the LARGER
 * of the two original sizes rather than losing the smaller one silently — a documented bound of
 * the schema as shipped by Task 2, not something this task can widen (a column addition is a
 * migration).
 *
 * LANE NOTE: on the TERMINAL lane `dom_before` is always NULL and `dom_after` carries the command's
 * OUTPUT. The replay body of a terminal action IS its output, so it wants exactly what this
 * function already provides — the `snapshotMaxBytes` cap, the `dom_truncated`/`dom_original_bytes`
 * flags, and the 7-day retention prune, which is the right posture for text that routinely carries
 * secrets. The columns are named `dom_*` because V57 predates the second lane; renaming them is a
 * migration under an append-only, forward-only schema and is not worth one. Recorded here so a
 * reader cannot conclude the terminal lane snapshots a DOM.
 */
export function insertAction(
  db: Database,
  input: InsertActionInput,
  snapshotMaxBytes: number,
): void {
  const before = truncateSnapshot(input.domBefore, snapshotMaxBytes);
  const after = truncateSnapshot(input.domAfter, snapshotMaxBytes);
  const truncated = before.truncated || after.truncated;
  const originalBytes =
    before.originalBytes !== null && after.originalBytes !== null
      ? Math.max(before.originalBytes, after.originalBytes)
      : (before.originalBytes ?? after.originalBytes);

  dbRun(
    db,
    `INSERT INTO cu_action (
      id, session_id, seq, kind, classification, observed_target, model_description,
      hitl_status, outcome, dom_before, dom_after, dom_truncated, dom_original_bytes,
      screenshot_digest, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sessionId,
      input.seq,
      input.kind,
      input.classification,
      input.observedTarget,
      input.modelDescription,
      input.hitlStatus,
      input.outcome,
      before.value,
      after.value,
      truncated ? 1 : 0,
      originalBytes,
      input.screenshotDigest,
      input.timestamp,
    ],
  );
}

/**
 * Snapshot retention (spec § 8.4): NULL out `dom_before`/`dom_after` for every action row older
 * than `cutoffMs` (an absolute timestamp — `now - retentionDays * 86_400_000`, computed by the
 * caller). The `audit_log` decision row is untouched and permanent; only the bulky replay body
 * ages out. Deliberately NOT `egress.prune` (I29's sole, tombstoned, chained mutation) — `cu_action`
 * is not the egress ledger and gets its own, unchained prune.
 */
export function pruneSnapshots(db: Database, cutoffMs: number): void {
  dbRun(
    db,
    `UPDATE cu_action SET dom_before = NULL, dom_after = NULL
     WHERE timestamp < ? AND (dom_before IS NOT NULL OR dom_after IS NOT NULL)`,
    [cutoffMs],
  );
}
