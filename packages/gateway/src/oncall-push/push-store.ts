import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

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
      // the row points at the attempt that actually ran. Status is restated, not assumed.
      dbRun(
        this.db,
        "UPDATE pushed_brief SET session_id = ?, status = 'failed', failure_code = ?, retried_at = ? WHERE incident_id = ?",
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
      .query("SELECT title FROM item WHERE id = ? AND type = 'incident'")
      .get(incidentId) as { title: string } | null;
    return r === null ? null : r.title;
  }

  private mustGet(incidentId: string): PushedBriefRow {
    const row = this.get(incidentId);
    if (row === null) throw new Error(`pushed_brief row vanished: ${incidentId}`);
    return row;
  }
}
