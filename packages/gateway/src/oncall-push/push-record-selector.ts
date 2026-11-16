import type { Database } from "bun:sqlite";

import { selectIncidentById } from "../agents/_lib/oncall-queries.ts";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import { normaliseSeverityLabel } from "../incident/trigger-facts.ts";
import { isTriggerService, type TriggerService } from "../incident/trigger-sources.ts";
import { ownerOnCallForService } from "./owner-on-call.ts";
import { ENABLE_GRACE_MS } from "./push-selector.ts";

/**
 * Which incident RECORDS the on-call push may push (Phase 10 IC3, design G). PagerDuty keeps its own
 * assignment-based path (`selectPushCandidates`); a record of any OTHER source is pushed only when ALL of these
 * hold, evaluated in this order, each failure counted under its own reason and never pushed:
 *
 * 1. its severity label is in the `[oncall.push]` severity set (`[incident] severities` is NEVER read here: it
 *    decided only whether the record exists);
 * 2. it is open, has an open time at or after `enabled_at - 5 min`, and has no `pushed_brief` row;
 * 3. it is bound to a configured service;
 * 4. the index proves the local owner is on call for that service now (`ownerOnCallForService`, exact PagerDuty
 *    service id, fresh data);
 * 5. its source is in `[oncall.push] sources` and is not PagerDuty. This one is enforced INSIDE this function,
 *    in its SQL, so it is correct whatever its caller does.
 *
 * Nothing the index cannot prove is pushed, and nothing is broadcast. No `pushed_brief` row is written for a skip
 * (a row would block a later push once you do go on call), so a record is re-evaluated at the next run.
 */

export type RecordPushSkip =
  | "severity_not_in_push_set"
  | "no_open_time"
  | "unbound"
  | "no_oncall_data"
  | "stale_oncall_data"
  | "owner_not_on_call";

export type RecordSelectInput = {
  /** `[oncall.push] sources`; PagerDuty is never selected through this path even when listed. */
  readonly sources: readonly string[];
  /** `resolveSeveritySet(...)`: the `[oncall.push]` set, the same value the PagerDuty path uses. */
  readonly severities: ReadonlySet<string>;
  readonly enabledAtMs: number;
  readonly nowMs: number;
  readonly alreadyPushed: (itemId: string) => boolean;
  /** The configured service's PagerDuty service ids, or undefined when the service is no longer configured. */
  readonly serviceConfig: (
    serviceId: string,
  ) => { readonly pagerdutyServices: readonly string[] } | undefined;
};

export type RecordSelection = {
  readonly candidates: OncallIncident[];
  readonly notPushed: Readonly<Partial<Record<RecordPushSkip, number>>>;
};

type Row = {
  trigger_item_id: string;
  trigger_service: string;
  service: string | null;
  title: string;
  severity: string | null;
  opened_at_ms: number | null;
  status: string;
  url: string | null;
};

const SELECT = `SELECT trigger_item_id, trigger_service, service, title, severity, opened_at_ms, status,
       CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.trigger.url') END AS url
  FROM incident_record`;

function severityInSet(service: string, label: string, set: ReadonlySet<string>): boolean {
  if (!isTriggerService(service)) return false;
  for (const s of set)
    if (normaliseSeverityLabel(service as TriggerService, s) === label) return true;
  return false;
}

function toIncident(r: Row): OncallIncident {
  return {
    id: r.trigger_item_id,
    title: r.title,
    url: typeof r.url === "string" && r.url !== "" ? r.url : null,
    status: r.status,
    severity: r.severity === null ? null : r.severity.toUpperCase(),
    urgency: null,
    openedAtMs: r.opened_at_ms,
    pagerdutyServiceId: null,
    assigneeEmails: [],
  };
}

/** The push candidates among the stored records of the opted-in, non-PagerDuty sources. */
export function selectRecordPushCandidates(
  db: Database,
  input: RecordSelectInput,
): RecordSelection {
  const rows = db
    .query(
      `${SELECT}
        WHERE trigger_service IN (SELECT value FROM json_each(?)) AND trigger_service <> 'pagerduty'
          AND status = 'open'
        ORDER BY opened_at_ms DESC, id ASC`,
    )
    .all(JSON.stringify(input.sources)) as Row[];
  const counts: Partial<Record<RecordPushSkip, number>> = {};
  const skip = (reason: RecordPushSkip): void => {
    counts[reason] = (counts[reason] ?? 0) + 1;
  };
  const floor = input.enabledAtMs - ENABLE_GRACE_MS;
  const candidates: OncallIncident[] = [];
  for (const r of rows) {
    if (r.severity === null || !severityInSet(r.trigger_service, r.severity, input.severities)) {
      skip("severity_not_in_push_set");
    } else if (r.opened_at_ms === null) {
      skip("no_open_time");
    } else if (r.opened_at_ms < floor || input.alreadyPushed(r.trigger_item_id)) {
      // Normal: older than the enable boundary, or already pushed. Not a skip worth counting.
    } else if (r.service === null) {
      skip("unbound");
    } else {
      const proof = ownerOnCallForService(
        db,
        input.serviceConfig(r.service) ?? { pagerdutyServices: [] },
        input.nowMs,
      );
      if (proof === "yes") candidates.push(toIncident(r));
      else if (proof === "stale") skip("stale_oncall_data");
      else if (proof === "no_data") skip("no_oncall_data");
      else skip("owner_not_on_call");
    }
  }
  return { candidates, notPushed: counts };
}

/**
 * Map a trigger item id to the `OncallIncident` the headline and toast take: a PagerDuty item through
 * `selectIncidentById` (an item id starts with `pagerduty:`), any other source from its stored record. `null`
 * for an id that names nothing. `once()` and `retry` both use it, so a retried non-PagerDuty push is delivered.
 */
export function pushIncidentForItem(db: Database, itemId: string): OncallIncident | null {
  if (itemId.startsWith("pagerduty:")) return selectIncidentById(db, itemId);
  const row = db.query(`${SELECT} WHERE trigger_item_id = ?`).get(itemId) as Row | null;
  return row === null ? null : toIncident(row);
}
