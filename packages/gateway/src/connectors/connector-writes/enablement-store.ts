// packages/gateway/src/connectors/connector-writes/enablement-store.ts
// The owner's opt-in for model connector writes (V83 `connector_write_enablement`). Written only by
// the HITL-gated `connector.writes.enable` handler; today only `connector.writesStatus` reads it, and the
// model's tool source will (Phase 9.7 A5).
import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import type { ConnectorWriteRow, ConnectorWriteWave } from "./types.ts";

export interface ModelWriteEnablement {
  readonly service: string;
  readonly maxWave: ConnectorWriteWave;
  readonly enabledAt: number;
}

interface EnablementDbRow {
  service: string;
  max_wave: number;
  enabled_at: number;
}

function fromDb(r: EnablementDbRow): ModelWriteEnablement {
  return { service: r.service, maxWave: r.max_wave as ConnectorWriteWave, enabledAt: r.enabled_at };
}

/** Every service with at least one row in the write table, sorted. */
export function modelWriteServices(): readonly string[] {
  return [...new Set(CONNECTOR_WRITE_ROWS.map((r) => serviceOf(r.actionType)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Enable (or re-enable with a different wave: the row is replaced) a service for the model. */
export function setModelWriteEnablement(
  db: Database,
  service: string,
  maxWave: ConnectorWriteWave,
  now: number,
): void {
  dbRun(
    db,
    `INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES (?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET max_wave = excluded.max_wave, enabled_at = excluded.enabled_at`,
    [service, maxWave, now],
  );
}

/** Remove a service's opt-in. True when a row existed. */
export function removeModelWriteEnablement(db: Database, service: string): boolean {
  return (
    dbRun(db, "DELETE FROM connector_write_enablement WHERE service = ?", [service]).changes > 0
  );
}

export function getModelWriteEnablement(
  db: Database,
  service: string,
): ModelWriteEnablement | undefined {
  const r = db
    .query("SELECT service, max_wave, enabled_at FROM connector_write_enablement WHERE service = ?")
    .get(service) as EnablementDbRow | null;
  return r === null ? undefined : fromDb(r);
}

export function listModelWriteEnablement(db: Database): readonly ModelWriteEnablement[] {
  const rows = db
    .query("SELECT service, max_wave, enabled_at FROM connector_write_enablement")
    .all() as EnablementDbRow[];
  return rows.map(fromDb).sort((a, b) => a.service.localeCompare(b.service));
}

/** The rows of `service` whose wave is at or below `maxWave`: what enabling it offers the model. */
export function writesEnabledBy(
  service: string,
  maxWave: ConnectorWriteWave,
): readonly ConnectorWriteRow[] {
  return CONNECTOR_WRITE_ROWS.filter(
    (r) => serviceOf(r.actionType) === service && r.wave <= maxWave,
  );
}
