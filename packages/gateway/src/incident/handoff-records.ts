import type { Database } from "bun:sqlite";

import { codeUnitCompare } from "./lanes/caps.ts";
import { TRIGGER_SERVICES } from "./trigger-sources.ts";

/**
 * The incident-record sections of the on-call handoff brief (Phase 10 IC9a, spec § 5.9): which records opened,
 * resolved and are still open in the shift window, and which are smouldering (open over four hours, or
 * re-triggered). A PURE read over the local index: it takes a `Database` and the window, has no clock of its own
 * and no network, and writes nothing (static D46(a), I57 (a)). The shipped handoff (`index/oncall-handoff-query.ts`)
 * keeps its window, lanes and flags; this adds to it and shares nothing with it but the window.
 *
 * Open and resolved are read from the STORED record (its `status`, `opened_at_ms` and the closed time inside its
 * JSON), as of the record's last refresh, not from the provider. The closed time is read with a `json_valid`
 * guard: SQLite's `json_extract` raises on a row that is not JSON, and one such row must not fail the brief.
 */

export const RECORDS_LIST_CAP = 50;
export const SMOULDERING_AFTER_MS = 4 * 3_600_000;
/** The words the shipped handoff already uses for "the provider closed this"; no other vocabulary is guessed. */
const ENDED_VALUES: ReadonlySet<string> = new Set(["resolved", "closed"]);

export type HandoffRecordRef = {
  readonly recordId: string;
  readonly triggerItemId: string;
  readonly triggerService: string;
  readonly service: string | null;
  readonly title: string;
  readonly severity: string | null;
  readonly status: string;
  readonly openedAtMs: number | null;
  readonly closedAtMs: number | null;
};

export type SmoulderingRef = HandoffRecordRef & { readonly reason: "open_over_4h" | "retriggered" };

export type RecordsCounted<T> = { readonly items: readonly T[]; readonly total: number };

export type HandoffRecords = {
  readonly status: "ok" | "no_records";
  readonly opened: RecordsCounted<HandoffRecordRef>;
  readonly resolved: RecordsCounted<HandoffRecordRef>;
  readonly stillOpen: RecordsCounted<HandoffRecordRef>;
  readonly smouldering: RecordsCounted<SmoulderingRef>;
  readonly freshness: readonly {
    readonly service: string;
    readonly connected: boolean;
    readonly lastSyncMs: number | null;
  }[];
  readonly gaps: readonly { readonly code: string; readonly detail: string }[];
};

export type HandoffRecordsOptions = {
  readonly fromMs: number;
  readonly toMs: number;
  readonly nowMs: number;
  /** The service ids in scope, or null for every record. */
  readonly serviceIds: ReadonlySet<string> | null;
};

type Row = {
  id: string;
  trigger_item_id: string;
  trigger_service: string;
  service: string | null;
  title: string;
  severity: string | null;
  status: string;
  opened_at_ms: number | null;
  closed_ms: number | null;
};

type StatusRow = { item_id: string; old_value: string | null; new_value: string | null };

function ref(r: Row): HandoffRecordRef {
  return {
    recordId: r.id,
    triggerItemId: r.trigger_item_id,
    triggerService: r.trigger_service,
    service: r.service,
    title: r.title,
    severity: r.severity,
    status: r.status,
    openedAtMs: r.opened_at_ms,
    closedAtMs:
      typeof r.closed_ms === "number" && Number.isFinite(r.closed_ms) ? r.closed_ms : null,
  };
}

function byOpenedThenId(a: HandoffRecordRef, b: HandoffRecordRef): number {
  return (
    (a.openedAtMs ?? Number.POSITIVE_INFINITY) - (b.openedAtMs ?? Number.POSITIVE_INFINITY) ||
    codeUnitCompare(a.recordId, b.recordId)
  );
}

function counted<T extends HandoffRecordRef>(all: readonly T[]): RecordsCounted<T> {
  const sorted = [...all].sort(byOpenedThenId);
  return { items: sorted.slice(0, RECORDS_LIST_CAP), total: sorted.length };
}

/** Records that could matter to the window: still open, or refreshed since it began (a close is seen by a refresh). */
function readCandidates(db: Database, opts: HandoffRecordsOptions): Row[] {
  return db
    .query(
      `SELECT id, trigger_item_id, trigger_service, service, title, severity, status, opened_at_ms,
              CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.trigger.closed.ms') END AS closed_ms
         FROM incident_record
        WHERE (status = 'open' OR checked_at_ms >= ?)
        ORDER BY id`,
    )
    .all(opts.fromMs) as Row[];
}

function readRetriggered(db: Database, opts: HandoffRecordsOptions): Set<string> {
  const rows = db
    .query(
      `SELECT item_id, old_value, new_value FROM item_history
        WHERE key = 'status' AND observed_at_ms >= ? AND observed_at_ms <= ?`,
    )
    .all(opts.fromMs, opts.toMs) as StatusRow[];
  const out = new Set<string>();
  for (const r of rows) {
    if (
      r.old_value !== null &&
      ENDED_VALUES.has(r.old_value.toLowerCase()) &&
      (r.new_value === null || !ENDED_VALUES.has(r.new_value.toLowerCase()))
    ) {
      out.add(r.item_id);
    }
  }
  return out;
}

function freshnessRows(db: Database): HandoffRecords["freshness"] {
  const q = db.query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1");
  return TRIGGER_SERVICES.map((service) => {
    const row = q.get(service) as { last_sync_at: number | null } | null;
    return { service, connected: row !== null, lastSyncMs: row?.last_sync_at ?? null };
  });
}

/** The record lists of one window, and what could not be placed in them. */
type Placed = {
  readonly opened: HandoffRecordRef[];
  readonly resolved: HandoffRecordRef[];
  readonly stillOpen: HandoffRecordRef[];
  readonly smouldering: SmoulderingRef[];
  noOpenTime: number;
  closedUnknown: number;
};

/** Places one record (its open time known) in every list of the window it belongs to. */
function placeRecord(
  r: Row,
  v: HandoffRecordRef,
  openedAtMs: number,
  retriggered: ReadonlySet<string>,
  opts: HandoffRecordsOptions,
  out: Placed,
): void {
  if (openedAtMs >= opts.fromMs && openedAtMs <= opts.toMs) out.opened.push(v);
  if (r.status === "closed") {
    if (v.closedAtMs === null) out.closedUnknown += 1;
    else if (v.closedAtMs >= opts.fromMs && v.closedAtMs <= opts.toMs) out.resolved.push(v);
  }
  const open =
    openedAtMs <= opts.toMs &&
    (r.status === "open" ||
      (r.status === "closed" && v.closedAtMs !== null && v.closedAtMs > opts.toMs));
  if (open) out.stillOpen.push(v);
  if (retriggered.has(v.triggerItemId) && openedAtMs <= opts.toMs) {
    out.smouldering.push({ ...v, reason: "retriggered" });
  } else if (open && opts.toMs - openedAtMs > SMOULDERING_AFTER_MS) {
    out.smouldering.push({ ...v, reason: "open_over_4h" });
  }
}

function placeRecords(
  rows: readonly Row[],
  retriggered: ReadonlySet<string>,
  opts: HandoffRecordsOptions,
): Placed {
  const out: Placed = {
    opened: [],
    resolved: [],
    stillOpen: [],
    smouldering: [],
    noOpenTime: 0,
    closedUnknown: 0,
  };
  for (const r of rows) {
    const v = ref(r);
    const openedAtMs = v.openedAtMs;
    if (openedAtMs === null) {
      out.noOpenTime += 1;
      continue;
    }
    placeRecord(r, v, openedAtMs, retriggered, opts, out);
  }
  return out;
}

/** The gaps after the lists: unplaced records, the scope of records, a past window, what is not read. */
function trailingGaps(
  total: number,
  placed: Placed,
  opts: HandoffRecordsOptions,
): { code: string; detail: string }[] {
  const gaps: { code: string; detail: string }[] = [];
  if (total > 0 && placed.noOpenTime > 0) {
    gaps.push({
      code: "no_open_time",
      detail: `${String(placed.noOpenTime)} record(s) carry no open time and are not placed in any list.`,
    });
  }
  if (placed.closedUnknown > 0) {
    gaps.push({
      code: "closed_time_unknown",
      detail: `${String(placed.closedUnknown)} closed record(s) carry no close time, so they are not listed as resolved in the window.`,
    });
  }
  if (total > 0) {
    gaps.push({
      code: "records_scope",
      detail:
        "Records exist only for alerts that met the [incident] severity rule or were assembled on request, so these lists can be shorter than the PagerDuty and Jira Service Management lists above; open and resolved are as of each record's last refresh.",
    });
  }
  if (opts.toMs < opts.nowMs - 60_000) {
    gaps.push({
      code: "window_ends_in_past",
      detail:
        "The window ends before now: a record's state is read from its stored close time, and a close the engine has not yet refreshed is not seen.",
    });
  }
  gaps.push({
    code: "proposals_runbook_findings",
    detail:
      "This brief does not read remediation proposals, runbook steps or radar findings, so their silence is not evidence that none exist.",
  });
  return gaps;
}

export function readHandoffRecords(db: Database, opts: HandoffRecordsOptions): HandoffRecords {
  const total = (db.query("SELECT count(*) AS n FROM incident_record").get() as { n: number }).n;
  const empty: RecordsCounted<never> = { items: [], total: 0 };
  const gaps: { code: string; detail: string }[] = [];
  const freshness = freshnessRows(db);
  if (total === 0) {
    gaps.push({
      code: "no_records",
      detail:
        "No incident record has been assembled yet, so the record lists are empty because nothing can be read, not because nothing happened.",
    });
  }

  const retriggered = readRetriggered(db, opts);
  const rows = readCandidates(db, opts).filter(
    (r) => opts.serviceIds === null || (r.service !== null && opts.serviceIds.has(r.service)),
  );
  const placed = placeRecords(rows, retriggered, opts);
  gaps.push(...trailingGaps(total, placed, opts));

  return {
    status: total === 0 ? "no_records" : "ok",
    opened: total === 0 ? empty : counted(placed.opened),
    resolved: total === 0 ? empty : counted(placed.resolved),
    stillOpen: total === 0 ? empty : counted(placed.stillOpen),
    smouldering: total === 0 ? empty : counted(placed.smouldering),
    freshness,
    gaps,
  };
}
