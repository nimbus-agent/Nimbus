import type { Database } from "bun:sqlite";

export interface AuditMetaRow {
  readonly id: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly hash: string;
  readonly timestamp: number;
  readonly actionJson?: string; // present in DB rows; NEVER shipped
}

/** Project to metadata-only — the no-leak guarantee. Drops actionJson. */
export function toShippableLine(row: AuditMetaRow): string {
  return JSON.stringify({
    id: row.id,
    actionType: row.actionType,
    hitlStatus: row.hitlStatus,
    hash: row.hash,
    timestamp: row.timestamp,
  });
}

export interface ShipDeps {
  readonly shipTo: string;
  readonly post: (url: string, ndjson: string) => Promise<boolean>;
}

/** POST a batch as NDJSON; return the number shipped (0 on failure — best-effort). */
export async function shipBatch(rows: readonly AuditMetaRow[], deps: ShipDeps): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const ndjson = `${rows.map(toShippableLine).join("\n")}\n`;
  const ok = await deps.post(deps.shipTo, ndjson);
  return ok ? rows.length : 0;
}

// ---------------------------------------------------------------------------
// Sidecar (assemble.ts) — best-effort, forward-only cursor. NEVER selects
// action_json (the no-leak guarantee is enforced at the SQL level too).
// ---------------------------------------------------------------------------

/** Default ship cadence. */
export const AUDIT_SHIP_INTERVAL_MS = 30_000;
/** Per-tick upper bound on rows fetched/shipped. */
export const AUDIT_SHIP_BATCH_LIMIT = 500;

/** Current MAX(id) of audit_log, or 0 when the table is empty / missing. */
export function currentAuditCursor(db: Database): number {
  try {
    const row = db.query("SELECT MAX(id) AS maxId FROM audit_log").get() as {
      maxId: number | null;
    } | null;
    return row?.maxId ?? 0;
  } catch {
    return 0;
  }
}

interface AuditLogSelectRow {
  readonly id: number;
  readonly action_type: string;
  readonly hitl_status: string;
  readonly row_hash: string;
  readonly timestamp: number;
}

/**
 * Fetch audit_log rows with id > cursor as metadata-only `AuditMetaRow`s. The
 * SELECT deliberately omits `action_json` — the shipped payload is never allowed
 * to carry the action body.
 */
export function fetchAuditMetaSince(
  db: Database,
  cursor: number,
  limit: number,
): readonly AuditMetaRow[] {
  const rows = db
    .query(
      `SELECT id, action_type, hitl_status, row_hash, timestamp
         FROM audit_log
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor, limit) as AuditLogSelectRow[];
  return rows.map((r) => ({
    id: r.id,
    actionType: r.action_type,
    hitlStatus: r.hitl_status,
    hash: r.row_hash,
    timestamp: r.timestamp,
  }));
}

/** A real fetch-based NDJSON POST: 2xx → true; non-2xx or throw → false. */
async function postNdjson(url: string, ndjson: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface StartAuditShipperOptions {
  readonly shipTo: string;
  readonly intervalMs?: number;
  readonly batchLimit?: number;
  /** Injected for tests; defaults to a real fetch POST. */
  readonly post?: (url: string, ndjson: string) => Promise<boolean>;
}

export interface AuditShipperHandle {
  stop(): void;
}

/**
 * Ship audit_log metadata to the org SIEM endpoint on an interval. Forward-only:
 * the starting cursor is the current MAX(id), so only entries created AFTER the
 * shipper starts are shipped (no persisted-cursor migration needed; a restart
 * re-baselines and never re-ships history). The cursor advances only when a full
 * batch ships successfully. Best-effort: a failed POST leaves the cursor in place
 * so the same rows are retried next tick; a thrown tick never escapes.
 */
export function startAuditShipper(
  db: Database,
  opts: StartAuditShipperOptions,
): AuditShipperHandle {
  const intervalMs = opts.intervalMs ?? AUDIT_SHIP_INTERVAL_MS;
  const batchLimit = opts.batchLimit ?? AUDIT_SHIP_BATCH_LIMIT;
  const post = opts.post ?? postNdjson;
  let cursor = currentAuditCursor(db);

  const tick = async (): Promise<void> => {
    try {
      const rows = fetchAuditMetaSince(db, cursor, batchLimit);
      if (rows.length === 0) {
        return;
      }
      const shipped = await shipBatch(rows, { shipTo: opts.shipTo, post });
      if (shipped === rows.length) {
        const last = rows[rows.length - 1];
        if (last !== undefined) {
          cursor = last.id;
        }
      }
    } catch {
      // Best-effort shipping — never crash the gateway.
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return { stop: () => clearInterval(timer) };
}
