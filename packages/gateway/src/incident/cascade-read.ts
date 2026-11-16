import type { Database } from "bun:sqlite";

import { type CascadeGroup, type CascadeRecord, type DependsOn, rankCascades } from "./cascade.ts";

/** What a rendered cascade says about each member (provider text: always rendered through the hardening helpers). */
export type CascadeInfo = {
  readonly title: string;
  readonly source: string;
  readonly service: string | null;
  readonly openedAtMs: number;
};

export type CascadeView = {
  readonly groups: readonly CascadeGroup[];
  readonly info: ReadonlyMap<string, CascadeInfo>;
};

/**
 * The open records the cascade ranks (Phase 10 IC4): `status = 'open'` rows of `incident_record` with a known
 * open time, newest first, at most {@link CASCADE_OPEN_CAP}. A closed record is never part of a cascade. The
 * deployment id each record cites is read out of its own stored JSON by SQLite, so the ranker needs no parse.
 *
 * Read only. A failure of the SQL read throws {@link CascadeReadError}, which the on-call push catches (a failed
 * cascade degrades to the brief without the block and a one-line gap, never a failed push).
 */

export const CASCADE_OPEN_CAP = 500;

export class CascadeReadError extends Error {
  constructor(cause: unknown) {
    super(`the cascade could not be read: ${cause instanceof Error ? cause.message : "unknown"}`);
    this.name = "CascadeReadError";
  }
}

type Row = {
  id: string;
  title: string;
  service: string | null;
  trigger_service: string;
  opened_at_ms: number;
  deployment_id: string | null;
};

export type OpenCascadeRecord = CascadeRecord & { readonly title: string };

export function readOpenCascadeRecords(db: Database): OpenCascadeRecord[] {
  try {
    const rows = db
      .query(
        `SELECT id, title, service, trigger_service, opened_at_ms,
                CASE WHEN json_valid(record_json)
                     THEN json_extract(record_json, '$.change.deployment.id') END AS deployment_id
           FROM incident_record
          WHERE status = 'open' AND opened_at_ms IS NOT NULL
          ORDER BY opened_at_ms DESC, id ASC LIMIT ?`,
      )
      .all(CASCADE_OPEN_CAP) as Row[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      service: r.service,
      source: r.trigger_service,
      openedAtMs: r.opened_at_ms,
      deploymentId: typeof r.deployment_id === "string" ? r.deployment_id : null,
    }));
  } catch (e) {
    throw new CascadeReadError(e);
  }
}

/** The cascade groups of the open records, from the index and the declared `depends_on` map, with what to say of each. */
export function readCascade(db: Database, dependsOn: DependsOn): CascadeView {
  const records = readOpenCascadeRecords(db);
  return {
    groups: rankCascades(records, dependsOn),
    info: new Map(
      records.map((r) => [
        r.id,
        { title: r.title, source: r.source, service: r.service, openedAtMs: r.openedAtMs },
      ]),
    ),
  };
}
