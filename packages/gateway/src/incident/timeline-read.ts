import type { Database } from "bun:sqlite";

import { eventKindOf, groupSteps, readLinkedActions } from "./action-links.ts";
import { IncidentError } from "./assemble.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById, versionJson, versionsOf } from "./incident-store.ts";
import {
  buildTimeline,
  type Timeline,
  type TimelineActionInput,
  type TimelineHistoryInput,
} from "./timeline.ts";

/**
 * Loads the inputs of {@link buildTimeline} for one record and version (Phase 10 IC4). Takes only a `Database`:
 * index reads (the record and its versions, the trigger's `item_history`, the audit rows that name the record),
 * no network, no clock, no write (static D46(a)).
 *
 * `--version N` reads that version's stored JSON and shows what was known THEN: history observed up to its
 * assembly time and the actions linked to a version no later than N. With no version the current record, every
 * history row (the oldest 200) and every linked action are shown.
 */

export const TIMELINE_HISTORY_CAP = 200;

type HistoryRow = {
  key: string;
  old_value: string | null;
  new_value: string | null;
  observed_at_ms: number;
  source_at_ms: number | null;
};

function parseRecord(json: string): IncidentRecordV1 {
  return JSON.parse(json) as IncidentRecordV1;
}

export type ReadTimeline = {
  readonly recordId: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly timeline: Timeline;
};

export function readTimeline(db: Database, recordId: string, version?: number): ReadTimeline {
  return readTimelineWithCaps(db, recordId, version).read;
}

/**
 * `readTimeline` plus whether the linked-action scan hit its audit-row cap, for an in-gateway reader that must
 * report the cut as a gap of its own (IC9a's investigation). The IPC reply stays `ReadTimeline`.
 */
export function readTimelineWithCaps(
  db: Database,
  recordId: string,
  version?: number,
): { read: ReadTimeline; actionsTruncated: boolean } {
  const row = getById(db, recordId);
  if (row === null) {
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");
  }
  let record: IncidentRecordV1;
  let asOfMs: number | null = null;
  if (version === undefined) {
    record = parseRecord(row.record_json);
  } else if (version === row.version) {
    record = parseRecord(row.record_json);
    // A requested version shows what was known when it was assembled, current or not.
    asOfMs = row.assembled_at_ms;
  } else {
    const json = versionJson(db, recordId, version);
    const meta = versionsOf(db, recordId).find((v) => v.version === version);
    if (json === null || meta === undefined) {
      throw new IncidentError(
        "ERR_INCIDENT_VERSION_NOT_FOUND",
        `record ${recordId} has no version ${String(version)}`,
      );
    }
    record = parseRecord(json);
    asOfMs = meta.assembled_at_ms;
  }
  const shown = version ?? row.version;

  const rows = db
    .query(
      `SELECT key, old_value, new_value, observed_at_ms, source_at_ms FROM item_history
        WHERE item_id = ? AND substr(key, 1, 2) <> '__' ${asOfMs === null ? "" : "AND observed_at_ms <= ?"}
        ORDER BY observed_at_ms ASC, id ASC LIMIT ?`,
    )
    .all(
      ...(asOfMs === null
        ? [row.trigger_item_id, TIMELINE_HISTORY_CAP + 1]
        : [row.trigger_item_id, asOfMs, TIMELINE_HISTORY_CAP + 1]),
    ) as HistoryRow[];
  const history: TimelineHistoryInput[] = rows.slice(0, TIMELINE_HISTORY_CAP).map((h) => ({
    key: h.key,
    oldValue: h.old_value,
    newValue: h.new_value,
    observedAtMs: h.observed_at_ms,
    sourceAtMs: h.source_at_ms,
  }));

  const linked = readLinkedActions(db, recordId);
  const actions: TimelineActionInput[] = groupSteps(
    linked.rows.filter((r) => r.link.version <= shown),
  )
    // A read with no gate row after it never reached its gate (the scan cap dropped the gate row, or the
    // read threw): it is no approval, so the timeline leaves it out.
    .filter((s) => s.gate.role === "gate")
    .map((s) => ({
      auditId: s.gate.auditId,
      timestamp: s.gate.timestamp,
      actionType: s.gate.actionType,
      kind: eventKindOf(s.gate),
      answerSource: s.gate.answerSource,
      linkVersion: s.gate.link.version,
      subSteps: s.subSteps.length,
    }));

  return {
    read: {
      recordId,
      version: shown,
      currentVersion: row.version,
      timeline: buildTimeline({
        record,
        history,
        historyTruncated: rows.length > TIMELINE_HISTORY_CAP,
        actions,
        actionsTruncated: linked.truncated,
      }),
    },
    actionsTruncated: linked.truncated,
  };
}
