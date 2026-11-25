import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { TRIGGER_TYPES } from "../incident/trigger-sources.ts";

/**
 * The item types the push can be about (Phase 10 IC3): a PagerDuty incident, a JSM alert, a Sentry issue or a
 * data-quality item. The key of a pushed brief is still the trigger item id.
 */
const QUOTED_TRIGGER_TYPES = TRIGGER_TYPES.map((t) => `'${t}'`).join(", ");
const TRIGGER_TYPES_SQL = `(${QUOTED_TRIGGER_TYPES})`;

export type PushedBriefStatus = "ok" | "failed";
export type SinkOutcomeKind = "delivered" | "skipped" | "coalesced" | "failed";
export type SinkOutcome = {
  readonly outcome: SinkOutcomeKind;
  readonly reason?: string;
  readonly at: number;
};
export type PushedBriefRow = {
  readonly incidentId: string;
  readonly sessionId: string | null;
  readonly status: PushedBriefStatus;
  readonly failureCode: string | null;
  readonly briefMarkdown: string | null;
  readonly briefJson: string | null;
  readonly createdAt: number;
  readonly retriedAt: number | null;
  readonly delivery: Readonly<Record<string, SinkOutcome>>;
};
export type BriefOutcome =
  | {
      readonly status: "ok";
      readonly sessionId: string;
      readonly briefMarkdown: string;
      readonly briefJson: string;
    }
  | { readonly status: "failed"; readonly sessionId: string | null; readonly failureCode: string };

type Raw = {
  incident_id: string;
  session_id: string | null;
  status: string;
  failure_code: string | null;
  brief_markdown: string | null;
  brief_json: string | null;
  created_at: number;
  delivery_json: string;
  retried_at: number | null;
};

const COLS =
  "incident_id, session_id, status, failure_code, brief_markdown, brief_json, created_at, delivery_json, retried_at";

const PB_COLS = COLS.split(", ")
  .map((c) => `pb.${c}`)
  .join(", ");

// json_extract RAISES on malformed JSON. In a projection over a LEFT JOIN, one corrupt item.metadata
// would fail the whole list, so it is guarded (memory: sqlite-json-extract-raises-on-bad-json).
const PD_SERVICE_SQL =
  "CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.pagerduty_service_id') END";

export type PushedBriefListing = {
  readonly row: PushedBriefRow;
  readonly title: string | null;
  readonly pagerdutyServiceId: string | null;
};

type ListingRaw = Raw & { incident_title: string | null; incident_pd_service_id: unknown };

function parseDelivery(json: string): Record<string, SinkOutcome> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, SinkOutcome>)
      : {};
  } catch {
    return {};
  }
}

function toRow(r: Raw): PushedBriefRow {
  return {
    incidentId: r.incident_id,
    sessionId: r.session_id,
    status: r.status === "ok" ? "ok" : "failed",
    failureCode: r.failure_code,
    briefMarkdown: r.brief_markdown,
    briefJson: r.brief_json,
    createdAt: r.created_at,
    retriedAt: r.retried_at,
    delivery: parseDelivery(r.delivery_json),
  };
}

function outcomeColumns(
  o: BriefOutcome,
): [string | null, string, string | null, string | null, string | null] {
  return o.status === "ok"
    ? [o.sessionId, "ok", null, o.briefMarkdown, o.briefJson]
    : [o.sessionId, "failed", o.failureCode, null, null];
}

/** The ONLY reader/writer of `pushed_brief` and `oncall_push_state` (spec § 2.4). */
export class PushStore {
  constructor(private readonly db: Database) {}

  has(incidentId: string): boolean {
    return (
      this.db.query("SELECT 1 FROM pushed_brief WHERE incident_id = ?").get(incidentId) !== null
    );
  }

  insert(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow {
    dbRun(
      this.db,
      `INSERT INTO pushed_brief (incident_id, session_id, status, failure_code, brief_markdown, brief_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [incidentId, ...outcomeColumns(outcome), nowMs],
    );
    return this.mustGet(incidentId);
  }

  applyRetry(incidentId: string, outcome: BriefOutcome, nowMs: number): PushedBriefRow {
    const [sessionId, status, failureCode, md, json] = outcomeColumns(outcome);
    if (status === "ok") {
      dbRun(
        this.db,
        `UPDATE pushed_brief SET session_id = ?, status = 'ok', failure_code = NULL,
           brief_markdown = ?, brief_json = ?, retried_at = ? WHERE incident_id = ?`,
        [sessionId, md, json, nowMs, incidentId],
      );
    } else {
      // A failed retry may still have opened a session before timing out; record the LATEST one so
      // the row points at the attempt that actually ran. Status is restated, not assumed — and only
      // over a row that is STILL failed, so a late failure can never downgrade an `ok` brief that a
      // concurrent attempt wrote in the meantime (the caller then reads back the `ok` row).
      dbRun(
        this.db,
        "UPDATE pushed_brief SET session_id = ?, status = 'failed', failure_code = ?, retried_at = ? WHERE incident_id = ? AND status = 'failed'",
        [sessionId, failureCode, nowMs, incidentId],
      );
    }
    return this.mustGet(incidentId);
  }

  recordDelivery(incidentId: string, sink: string, outcome: SinkOutcome): void {
    const row = this.get(incidentId);
    if (row === null) return;
    const next = { ...row.delivery, [sink]: outcome };
    dbRun(this.db, "UPDATE pushed_brief SET delivery_json = ? WHERE incident_id = ?", [
      JSON.stringify(next),
      incidentId,
    ]);
  }

  get(incidentId: string): PushedBriefRow | null {
    const r = this.db
      .query(`SELECT ${COLS} FROM pushed_brief WHERE incident_id = ?`)
      .get(incidentId) as Raw | null;
    return r === null ? null : toRow(r);
  }

  newest(): PushedBriefRow | null {
    return this.list(1)[0] ?? null;
  }

  list(limit: number): PushedBriefRow[] {
    const rows = this.db
      .query(`SELECT ${COLS} FROM pushed_brief ORDER BY created_at DESC, incident_id ASC LIMIT ?`)
      .all(limit) as Raw[];
    return rows.map(toRow);
  }

  /** `list` plus the incident's title and PagerDuty service id, in ONE query (no per-row lookup). */
  listWithIncident(limit: number): PushedBriefListing[] {
    const rows = this.db
      .query(
        `SELECT ${PB_COLS}, i.title AS incident_title, ${PD_SERVICE_SQL} AS incident_pd_service_id
           FROM pushed_brief pb
           LEFT JOIN item i ON i.id = pb.incident_id AND i.type IN ${TRIGGER_TYPES_SQL}
          ORDER BY pb.created_at DESC, pb.incident_id ASC
          LIMIT ?`,
      )
      .all(limit) as ListingRaw[];
    return rows.map((r) => ({
      row: toRow(r),
      title: r.incident_title,
      pagerdutyServiceId:
        typeof r.incident_pd_service_id === "string" ? r.incident_pd_service_id : null,
    }));
  }

  pruneOlderThan(cutoffMs: number): number {
    return dbRun(this.db, "DELETE FROM pushed_brief WHERE created_at < ?", [cutoffMs]).changes;
  }

  enabledAt(): number | null {
    const r = this.db.query("SELECT enabled_at FROM oncall_push_state WHERE id = 1").get() as {
      enabled_at: number;
    } | null;
    return r === null ? null : r.enabled_at;
  }

  /** Spec § 4.1: run once at boot. Enabled + no row → stamp; disabled → clear. */
  reconcileEnabledState(enabled: boolean, nowMs: number): void {
    if (!enabled) {
      dbRun(this.db, "DELETE FROM oncall_push_state WHERE id = 1", []);
      return;
    }
    dbRun(this.db, "INSERT OR IGNORE INTO oncall_push_state (id, enabled_at) VALUES (1, ?)", [
      nowMs,
    ]);
  }

  /** Display-only read of the incident's indexed title. */
  incidentTitle(incidentId: string): string | null {
    const r = this.db
      .query(`SELECT title FROM item WHERE id = ? AND type IN ${TRIGGER_TYPES_SQL}`)
      .get(incidentId) as { title: string } | null;
    return r === null ? null : r.title;
  }

  incidentPagerdutyServiceId(incidentId: string): string | null {
    const r = this.db
      .query(
        `SELECT ${PD_SERVICE_SQL} AS v FROM item i WHERE i.id = ? AND i.type IN ${TRIGGER_TYPES_SQL}`,
      )
      .get(incidentId) as { v: unknown } | null;
    return r !== null && typeof r.v === "string" ? r.v : null;
  }

  private mustGet(incidentId: string): PushedBriefRow {
    const row = this.get(incidentId);
    if (row === null) throw new Error(`pushed_brief row vanished: ${incidentId}`);
    return row;
  }
}

export type PushedBriefErasure = {
  /** Trigger item ids whose record was erased (the V64 primary key IS the trigger item id). */
  readonly triggerItemIds: readonly string[];
  /** When set, also every row whose key begins with `<service>:` (the erased service's own incidents). */
  readonly service?: string;
};

function erasureWhere(e: PushedBriefErasure): { clause: string; params: (string | number)[] } {
  const arms = ["incident_id IN (SELECT value FROM json_each(?))"];
  const params: (string | number)[] = [JSON.stringify(e.triggerItemIds)];
  if (e.service !== undefined) {
    // substr compare, never LIKE: a `%` or `_` in a service id is literal.
    const prefix = `${e.service}:`;
    arms.push("substr(incident_id, 1, ?) = ?");
    params.push(prefix.length, prefix);
  }
  return { clause: arms.join(" OR "), params };
}

/**
 * Delete the pushed briefs built from erased or pruned incident records (Phase 10 IC3, design I). Lives here
 * because this file is the only one that names `pushed_brief` (static D46(d)); called only by
 * `incident/incident-erasure.ts`. Opens no transaction: the caller owns it. Returns the rows deleted.
 */
export function deletePushedBriefsForErasure(db: Database, e: PushedBriefErasure): number {
  const w = erasureWhere(e);
  return dbRun(db, `DELETE FROM pushed_brief WHERE ${w.clause}`, w.params).changes;
}

/** Read-only count for the `data delete` dry run, by the same predicate. */
export function countPushedBriefsForErasure(db: Database, e: PushedBriefErasure): number {
  const w = erasureWhere(e);
  const row = db
    .query(`SELECT count(*) AS n FROM pushed_brief WHERE ${w.clause}`)
    .get(...w.params) as { n: number };
  return row.n;
}
