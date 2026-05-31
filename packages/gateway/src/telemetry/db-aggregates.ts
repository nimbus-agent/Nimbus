import type { Database } from "bun:sqlite";

const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(name) as { ok: number } | null;
  return row !== null;
}

function medianSorted(sorted: number[]): number {
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const v = sorted[mid];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
    return (a + b) / 2;
  }
  return 0;
}

export type TelemetryDbAggregateSlice = {
  readonly connector_error_rate: Record<string, number>;
  readonly connector_health_transitions: Record<string, number>;
  readonly sync_duration_p50_ms: Record<string, number>;
  readonly extension_installs_by_id: Record<string, number>;
};

function collectSyncTelemetryAggregates(
  db: Database,
  cutoff: number,
): Pick<TelemetryDbAggregateSlice, "connector_error_rate" | "sync_duration_p50_ms"> {
  const connector_error_rate: Record<string, number> = {};
  const sync_duration_p50_ms: Record<string, number> = {};
  if (!tableExists(db, "sync_telemetry")) {
    return { connector_error_rate, sync_duration_p50_ms };
  }

  const rows = db
    .query(
      `SELECT service, duration_ms, error_msg
       FROM sync_telemetry
       WHERE started_at >= ?`,
    )
    .all(cutoff) as Array<{ service: string; duration_ms: number; error_msg: string | null }>;

  const durationsByService = new Map<string, number[]>();
  for (const r of rows) {
    const svc = r.service.trim();
    if (svc === "") {
      continue;
    }
    const hasError = r.error_msg !== null && r.error_msg !== "";
    if (hasError) {
      connector_error_rate[svc] = (connector_error_rate[svc] ?? 0) + 1;
    }
    const dm = Math.max(0, Math.floor(r.duration_ms));
    const arr = durationsByService.get(svc);
    if (arr === undefined) {
      durationsByService.set(svc, [dm]);
    } else {
      arr.push(dm);
    }
  }
  for (const [svc, arr] of durationsByService) {
    const sorted = [...arr].sort((a, b) => a - b);
    sync_duration_p50_ms[svc] = Math.round(medianSorted(sorted));
  }
  return { connector_error_rate, sync_duration_p50_ms };
}

function collectHealthTransitionAggregates(db: Database, cutoff: number): Record<string, number> {
  const connector_health_transitions: Record<string, number> = {};
  if (!tableExists(db, "connector_health_history")) {
    return connector_health_transitions;
  }
  const hRows = db
    .query(
      `SELECT to_state, COUNT(*) AS c
       FROM connector_health_history
       WHERE occurred_at >= ?
       GROUP BY to_state`,
    )
    .all(cutoff) as Array<{ to_state: string; c: number }>;
  for (const r of hRows) {
    const st = r.to_state.trim();
    if (st === "") {
      continue;
    }
    connector_health_transitions[st] = Math.max(0, Math.floor(r.c));
  }
  return connector_health_transitions;
}

function collectEnabledExtensionIds(db: Database): Record<string, number> {
  const extension_installs_by_id: Record<string, number> = {};
  if (!tableExists(db, "extension")) {
    return extension_installs_by_id;
  }
  const extRows = db.query(`SELECT id FROM extension WHERE enabled = 1`).all() as Array<{
    id: string;
  }>;
  for (const r of extRows) {
    const id = r.id.trim();
    if (id === "") {
      continue;
    }
    extension_installs_by_id[id] = 1;
  }
  return extension_installs_by_id;
}

export function collectTelemetryDbAggregates(db: Database): TelemetryDbAggregateSlice {
  const cutoff = Date.now() - SEVEN_D_MS;
  const sync = collectSyncTelemetryAggregates(db, cutoff);
  return {
    ...sync,
    connector_health_transitions: collectHealthTransitionAggregates(db, cutoff),
    extension_installs_by_id: collectEnabledExtensionIds(db),
  };
}
