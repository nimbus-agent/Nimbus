import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

function jitterBelowMs(maxExclusive: number): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  const u = word[0] ?? 0;
  return (u / 2 ** 32) * maxExclusive;
}

export type ConnectorHealthState =
  | "healthy"
  /**
   * Never set up — no credential the manifest names has ever been stored, so nothing this
   * connector could report would be about a real conversation with a service.
   *
   * Deliberately NOT folded into `unauthenticated`. That state means a credential was presented
   * and REJECTED, and its remedy is `nimbus connector auth <service>`; this one means there was
   * never a credential, and its remedy may be "you do not use this service". Conflating the two
   * is what made F11 take an hour: gmail was reported broken while its own credential was fine.
   */
  | "not_configured"
  | "degraded"
  | "error"
  | "rate_limited"
  | "unauthenticated"
  | "paused";

export interface ConnectorHealthSnapshot {
  connectorId: string;
  state: ConnectorHealthState;
  retryAfter?: Date;
  backoffUntil?: Date;
  backoffAttempt: number;
  lastError?: string;
  lastSuccessfulSync?: Date;
  lastSyncAttempt?: Date;
}

export type HealthEvent =
  | { type: "sync_success" }
  /**
   * No credential for this connector has ever been stored. Sets `sync_state.configured = 0`
   * and leaves `health_state` alone: the two answer different questions, and the last real
   * attempt's outcome does not stop being true because the credential was later removed.
   */
  | { type: "not_configured" }
  /** A credential IS present — clears the flag above. */
  | { type: "configured" }
  | { type: "rate_limited"; retryAfter: Date }
  | { type: "unauthenticated" }
  | { type: "transient_error"; error: string; attempt: number }
  | { type: "persistent_error"; error: string }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "reauthenticated" }
  | { type: "skipped_offline" };

const MAX_ERROR_LENGTH = 512;

function truncate(s: string): string {
  return s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH - 3)}...` : s;
}

type HealthEventWithStateChange = Exclude<
  HealthEvent,
  { type: "skipped_offline" } | { type: "not_configured" } | { type: "configured" }
>;

function nextState(event: HealthEventWithStateChange, maxAttempts: number): ConnectorHealthState {
  switch (event.type) {
    case "sync_success":
      return "healthy";
    case "rate_limited":
      return "rate_limited";
    case "unauthenticated":
      return "unauthenticated";
    case "transient_error":
      return event.attempt >= maxAttempts ? "error" : "degraded";
    case "persistent_error":
      return "error";
    case "paused":
      return "paused";
    case "resumed":
      return "healthy";
    case "reauthenticated":
      return "healthy";
  }
}

interface SyncStateHealthRow {
  health_state: string;
  configured: number;
  retry_after: number | null;
  backoff_until: number | null;
  backoff_attempt: number;
  last_error: string | null;
  last_sync_at: number | null;
}

function readHealthRow(db: Database, connectorId: string): SyncStateHealthRow | null {
  return (
    (db
      .query(
        `SELECT health_state, configured, retry_after, backoff_until, backoff_attempt, last_error, last_sync_at
         FROM sync_state WHERE connector_id = ?`,
      )
      .get(connectorId) as SyncStateHealthRow | null) ?? null
  );
}

function upsertHealthRow(
  db: Database,
  connectorId: string,
  patch: {
    health_state: string;
    retry_after: number | null;
    backoff_until: number | null;
    backoff_attempt: number;
    last_error: string | null;
  },
): void {
  // `depth` is written explicitly, and this is the ONLY `sync_state` insert
  // that runs in production for a connector whose depth was never set: it is
  // reached from `transitionHealth()`, which the scheduler calls on
  // `sync_success`, on pause/resume, and on every error path. Omitting the
  // column lets the row inherit V21's stale `DEFAULT 'summary'` — and since
  // V49 only backfilled rows that already EXISTED, every connector added
  // after the upgrade would index at `full` for exactly one sync (no row yet
  // → `getDepthForService` falls back to `full`) and then permanently at
  // `summary`: 512-char bodies, `body_complete` pinned to 0, and
  // `nimbus index rebody` permanently disarmed for that service.
  // `'full'` matches the V49 backfill, `getDepthForService`'s no-row
  // fallback, and `recordSync`'s insert — one value across every path that
  // materialises a depth nobody chose.
  dbRun(
    db,
    `INSERT OR IGNORE INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
     VALUES (?, NULL, NULL, 'full')`,
    [connectorId],
  );
  dbRun(
    db,
    `UPDATE sync_state
     SET health_state   = ?,
         retry_after    = ?,
         backoff_until  = ?,
         backoff_attempt = ?,
         last_error     = ?
     WHERE connector_id = ?`,
    [
      patch.health_state,
      patch.retry_after,
      patch.backoff_until,
      patch.backoff_attempt,
      patch.last_error,
      connectorId,
    ],
  );
}

function appendHistory(
  db: Database,
  connectorId: string,
  fromState: string | null,
  toState: string,
  reason: string | null,
  occurredAt: number,
): void {
  dbRun(
    db,
    `INSERT INTO connector_health_history
       (connector_id, from_state, to_state, reason, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
    [connectorId, fromState, toState, reason, occurredAt],
  );
}

/**
 * Write the `configured` flag, and log the change.
 *
 * Extracted from `transitionHealth` to keep it under the cognitive-complexity gate (Sonar
 * `S3776`) — it is a self-contained branch that shares nothing with the state machine below it.
 *
 * `health_state` is untouched on purpose: it records how the last REAL attempt went, and removing
 * a credential does not retroactively change that. `buildSnapshot` is where the two columns
 * become the single state a consumer reads.
 *
 * History gets a row only on a CHANGE, and only when a row already exists. A connector nobody
 * has configured is skipped on EVERY scheduler tick; appending there would bury the real
 * transitions under one line per unconfigured service per tick, and with ~90 registered syncables
 * that is the whole table. No row at all means nothing has ever been observed, which
 * `buildSnapshot` already reads as `not_configured` — creating ~90 rows on a fresh install to
 * record the absence of news would be its own noise.
 */
function applyConfiguredFlag(
  db: Database,
  connectorId: string,
  current: SyncStateHealthRow | null,
  fromState: string | null,
  nowConfigured: boolean,
  now: number,
): void {
  if (current === null) return;
  if ((current.configured !== 0) === nowConfigured) return;
  dbRun(db, "UPDATE sync_state SET configured = ? WHERE connector_id = ?", [
    nowConfigured ? 1 : 0,
    connectorId,
  ]);
  // History carries the DERIVED state, which is what a human reading the log needs. Logging the
  // untouched `health_state` would record "healthy" for the moment a connector stopped being
  // configured at all.
  appendHistory(
    db,
    connectorId,
    fromState,
    nowConfigured ? (fromState ?? "healthy") : "not_configured",
    nowConfigured ? "credential configured" : "no credential configured",
    now,
  );
}

export const DEFAULT_MAX_BACKOFF_ATTEMPTS = 10;

export function transitionHealth(
  db: Database,
  connectorId: string,
  event: HealthEvent,
  maxAttempts = DEFAULT_MAX_BACKOFF_ATTEMPTS,
): ConnectorHealthSnapshot {
  const now = Date.now();
  const current = readHealthRow(db, connectorId);
  const fromState = current?.health_state ?? null;

  if (event.type === "skipped_offline") {
    appendHistory(db, connectorId, fromState, fromState ?? "healthy", "skipped (offline)", now);
    return buildSnapshot(connectorId, current);
  }

  if (event.type === "not_configured" || event.type === "configured") {
    applyConfiguredFlag(db, connectorId, current, fromState, event.type === "configured", now);
    return buildSnapshot(connectorId, readHealthRow(db, connectorId));
  }

  const to = nextState(event, maxAttempts);

  let retryAfterMs: number | null = current?.retry_after ?? null;
  let backoffUntilMs: number | null = current?.backoff_until ?? null;
  let backoffAttempt: number = current?.backoff_attempt ?? 0;
  let lastError: string | null = current?.last_error ?? null;
  let reason: string | null = null;

  switch (event.type) {
    case "sync_success":
      retryAfterMs = null;
      backoffUntilMs = null;
      backoffAttempt = 0;
      lastError = null;
      reason = "sync succeeded";
      break;

    case "rate_limited": {
      retryAfterMs = event.retryAfter.getTime();
      reason = `rate_limited until ${event.retryAfter.toISOString()}`;
      break;
    }

    case "unauthenticated":
      lastError = "HTTP 401/403 — token expired or revoked";
      reason = "unauthenticated (401/403)";
      break;

    case "transient_error": {
      backoffAttempt = event.attempt;
      lastError = truncate(event.error);
      reason = truncate(`transient error (attempt ${String(event.attempt)}): ${event.error}`);
      const baseMs = 5_000;
      const maxBackoffMs = 3_600_000;
      const jitter = jitterBelowMs(500);
      const delay = Math.min(baseMs * 2 ** Math.max(0, event.attempt - 1), maxBackoffMs) + jitter;
      backoffUntilMs = now + delay;
      break;
    }

    case "persistent_error":
      lastError = truncate(event.error);
      reason = truncate(`persistent error: ${event.error}`);
      backoffUntilMs = null;
      break;

    case "paused":
      reason = "connector paused";
      break;

    case "resumed":
      backoffUntilMs = null;
      backoffAttempt = 0;
      lastError = null;
      reason = "connector resumed";
      break;

    case "reauthenticated":
      // Same clearing as `resumed` — a stale `unauthenticated` lastError beside a
      // healthy state is exactly the mixed signal this change exists to remove —
      // but its OWN reason: nothing was paused, so "connector resumed" would be false.
      backoffUntilMs = null;
      backoffAttempt = 0;
      lastError = null;
      reason = "credential re-verified";
      break;
  }

  const effectiveState = to;

  db.transaction(() => {
    upsertHealthRow(db, connectorId, {
      health_state: effectiveState,
      retry_after: retryAfterMs,
      backoff_until: backoffUntilMs,
      backoff_attempt: backoffAttempt,
      last_error: lastError,
    });
    appendHistory(db, connectorId, fromState, effectiveState, reason, now);
  })();

  const updated = readHealthRow(db, connectorId);
  return buildSnapshot(connectorId, updated);
}

export function getConnectorHealth(db: Database, connectorId: string): ConnectorHealthSnapshot {
  const row = readHealthRow(db, connectorId);
  return buildSnapshot(connectorId, row);
}

export function getAllConnectorHealth(db: Database): ConnectorHealthSnapshot[] {
  const rows = db
    .query(
      `SELECT connector_id, health_state, configured, retry_after, backoff_until,
              backoff_attempt, last_error, last_sync_at
       FROM sync_state`,
    )
    .all() as Array<SyncStateHealthRow & { connector_id: string }>;

  return rows.map((r) =>
    buildSnapshot(r.connector_id, {
      health_state: r.health_state,
      configured: r.configured,
      retry_after: r.retry_after,
      backoff_until: r.backoff_until,
      backoff_attempt: r.backoff_attempt,
      last_error: r.last_error,
      last_sync_at: r.last_sync_at,
    }),
  );
}

export interface HealthHistoryRow {
  id: number;
  connectorId: string;
  fromState: string | null;
  toState: string;
  reason: string | null;
  occurredAt: Date;
}

export function getConnectorHealthHistory(
  db: Database,
  connectorId: string,
  limit = 100,
): HealthHistoryRow[] {
  const rows = db
    .query(
      `SELECT id, connector_id, from_state, to_state, reason, occurred_at
       FROM connector_health_history
       WHERE connector_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(connectorId, limit) as Array<{
    id: number;
    connector_id: string;
    from_state: string | null;
    to_state: string;
    reason: string | null;
    occurred_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    connectorId: r.connector_id,
    fromState: r.from_state,
    toState: r.to_state,
    reason: r.reason,
    occurredAt: new Date(r.occurred_at),
  }));
}

export function pruneConnectorHealthHistory(db: Database, maxAgeDays: number): number {
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = dbRun(db, `DELETE FROM connector_health_history WHERE occurred_at < ?`, [
    cutoffMs,
  ]);
  return result.changes;
}

function buildSnapshot(
  connectorId: string,
  row: SyncStateHealthRow | null,
): ConnectorHealthSnapshot {
  if (row === null) {
    // No row means this connector has never been observed at all. Reporting `healthy` here was
    // an assertion nothing supported, and it is the half of F6 that needs no scheduler run to
    // reproduce — a fresh install claimed ~90 healthy connectors. `not_configured` is the
    // honest reading, and it is self-correcting: the first successful sync overwrites it, so a
    // connector configured moments ago reads this only until its next tick.
    return { connectorId, state: "not_configured", backoffAttempt: 0 };
  }
  const snap: ConnectorHealthSnapshot = {
    connectorId,
    // `configured = 0` outranks whatever the last attempt recorded. A connector with no
    // credential cannot be healthy in any sense a reader cares about, and the stored
    // `health_state` at that point describes an attempt that is no longer repeatable.
    state:
      row.configured === 0
        ? "not_configured"
        : ((row.health_state as ConnectorHealthState) ?? "healthy"),
    backoffAttempt: row.backoff_attempt ?? 0,
  };
  if (row.retry_after !== null) {
    snap.retryAfter = new Date(row.retry_after);
  }
  if (row.backoff_until !== null) {
    snap.backoffUntil = new Date(row.backoff_until);
  }
  if (row.last_error !== null) {
    snap.lastError = row.last_error;
  }
  if (row.last_sync_at !== null) {
    snap.lastSuccessfulSync = new Date(row.last_sync_at);
  }
  return snap;
}
