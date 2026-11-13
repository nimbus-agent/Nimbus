// packages/gateway/src/connectors/connector-writes/enablement-store.ts
// The owner's opt-in for model connector writes (V83 `connector_write_enablement`, V84
// `approved_tool_ids`). Written only by the HITL-gated `connector.writes.enable` handler; read by
// `connector.writesStatus` and the model's tool source (`model-write-source.ts`).
import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import type { ConnectorWriteRow, ConnectorWriteWave } from "./types.ts";

export interface ModelWriteEnablement {
  readonly service: string;
  readonly maxWave: ConnectorWriteWave;
  readonly enabledAt: number;
  /**
   * The tool ids the owner approved by name (V84): the rows the enable prompt listed as offerable
   * when they approved it. The model is offered only these. Empty for an opt-in written before V84,
   * or a stored value that does not parse as an array of strings (fail closed).
   */
  readonly approvedToolIds: ReadonlySet<string>;
}

interface EnablementDbRow {
  service: string;
  max_wave: number;
  enabled_at: number;
  approved_tool_ids: string;
}

const SELECT_COLUMNS = "service, max_wave, enabled_at, approved_tool_ids";

/** The stored JSON array, or an EMPTY set when it is anything else (fail closed). */
function parseApproved(raw: unknown): ReadonlySet<string> {
  if (typeof raw !== "string") return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) {
    return new Set();
  }
  return new Set(parsed);
}

function fromDb(r: EnablementDbRow): ModelWriteEnablement {
  return {
    service: r.service,
    maxWave: r.max_wave as ConnectorWriteWave,
    enabledAt: r.enabled_at,
    approvedToolIds: parseApproved(r.approved_tool_ids),
  };
}

/** Every service with at least one row in the write table (or `rows`), sorted. */
export function modelWriteServices(
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): readonly string[] {
  return [...new Set(rows.map((r) => serviceOf(r.actionType)))].sort((a, b) => a.localeCompare(b));
}

/**
 * Enable (or re-enable: the row is replaced) a service for the model, with the tool ids the owner
 * approved by name. The set is stored sorted and de-duplicated, so re-enabling replaces it whole.
 */
export function setModelWriteEnablement(
  db: Database,
  service: string,
  maxWave: ConnectorWriteWave,
  now: number,
  approvedToolIds: readonly string[],
): void {
  const approved = JSON.stringify([...new Set(approvedToolIds)].sort((a, b) => a.localeCompare(b)));
  dbRun(
    db,
    `INSERT INTO connector_write_enablement (service, max_wave, enabled_at, approved_tool_ids)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET max_wave = excluded.max_wave,
       enabled_at = excluded.enabled_at, approved_tool_ids = excluded.approved_tool_ids`,
    [service, maxWave, now, approved],
  );
}

/**
 * The agent door's writer of the SHARED wave (OR-AD-2): insert a row with an EMPTY model approved
 * set, or raise `max_wave` (never lower it); it touches nothing else, so the model is offered nothing
 * new (V84 approves by name). A later model-door `enable` still replaces the row whole.
 */
export function raiseWriteEnablementWave(
  db: Database,
  service: string,
  maxWave: ConnectorWriteWave,
  now: number,
): void {
  dbRun(
    db,
    `INSERT INTO connector_write_enablement (service, max_wave, enabled_at, approved_tool_ids)
     VALUES (?, ?, ?, '[]')
     ON CONFLICT(service) DO UPDATE SET max_wave = MAX(max_wave, excluded.max_wave)`,
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
    .query(`SELECT ${SELECT_COLUMNS} FROM connector_write_enablement WHERE service = ?`)
    .get(service) as EnablementDbRow | null;
  return r === null ? undefined : fromDb(r);
}

/** The write whose approval turns the Obsidian sandbox write grant on (OR-B4-1, I15). */
export const OBSIDIAN_APPEND_TOOL_ID = "obsidian_append_to_daily_note";

/**
 * The Obsidian sandbox write-grant trigger (OR-B4-1, I15): the owner's `obsidian` opt-in exists AND
 * approved the daily-note append by name. Read LIVE at every Obsidian spawn. Nothing else (no
 * config, no policy lockoff) turns the grant on.
 */
export function isObsidianWriteGrantApproved(db: Database): boolean {
  return (
    getModelWriteEnablement(db, "obsidian")?.approvedToolIds.has(OBSIDIAN_APPEND_TOOL_ID) === true
  );
}

export function listModelWriteEnablement(db: Database): readonly ModelWriteEnablement[] {
  const rows = db
    .query(`SELECT ${SELECT_COLUMNS} FROM connector_write_enablement`)
    .all() as EnablementDbRow[];
  return rows.map(fromDb).sort((a, b) => a.service.localeCompare(b.service));
}

/** The rows of `service` whose wave is at or below `maxWave`: what enabling it covers. */
export function writesEnabledBy(
  service: string,
  maxWave: ConnectorWriteWave,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): readonly ConnectorWriteRow[] {
  return rows.filter((r) => serviceOf(r.actionType) === service && r.wave <= maxWave);
}

/** The subset of {@link writesEnabledBy} the model could be offered now (M1), approved or not. */
export function offerableWritesEnabledBy(
  service: string,
  maxWave: ConnectorWriteWave,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): readonly ConnectorWriteRow[] {
  return writesEnabledBy(service, maxWave, rows).filter(isModelOfferableRow);
}
