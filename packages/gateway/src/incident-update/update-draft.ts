import type { Database } from "bun:sqlite";

import {
  renderIncidentUpdate,
  type UpdateAudience,
} from "../agents/_lib/incident-update-render.ts";
import { IncidentError } from "../incident/assemble.ts";
import type { IncidentRecordV1 } from "../incident/incident-record-types.ts";
import { versionJson } from "../incident/incident-store.ts";
import { readTimeline } from "../incident/timeline-read.ts";

/**
 * The incident update draft (Phase 10 IC9b, spec § 5.9): a stored record version and its timeline, rendered by
 * `renderIncidentUpdate`. READS ONLY: `incident_record`, `incident_record_version`, `item_history` and the
 * linked `audit_log` rows, through the incident readers. No request, no egress row, no model, no write. A
 * missing record or version throws the readers' own `IncidentError` (`ERR_INCIDENT_NOT_FOUND`,
 * `ERR_INCIDENT_VERSION_NOT_FOUND`).
 */

export type UpdateDraft = {
  readonly recordId: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly audience: UpdateAudience;
  readonly text: string;
};

export type DraftOptions = {
  readonly audience: UpdateAudience;
  /** A stored version; absent means the current one. */
  readonly version?: number;
  readonly nowMs: number;
};

export function draftIncidentUpdate(
  db: Database,
  recordId: string,
  opts: DraftOptions,
): UpdateDraft {
  // The timeline reader throws for a missing record or version before anything else is read.
  const tl = readTimeline(db, recordId, opts.version);
  const json =
    tl.version === tl.currentVersion
      ? (db.query("SELECT record_json FROM incident_record WHERE id = ?").get(recordId) as {
          record_json: string;
        } | null)?.record_json
      : versionJson(db, recordId, tl.version);
  if (json === undefined || json === null) {
    // A concurrent owner erasure removed it between the two reads.
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");
  }
  const record = JSON.parse(json) as IncidentRecordV1;
  return {
    recordId,
    version: tl.version,
    currentVersion: tl.currentVersion,
    audience: opts.audience,
    text: renderIncidentUpdate({
      recordId,
      record,
      version: tl.version,
      timeline: tl.timeline,
      audience: opts.audience,
      nowMs: opts.nowMs,
    }),
  };
}
