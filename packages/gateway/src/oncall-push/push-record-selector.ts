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

type ServiceLookup = RecordSelectInput["serviceConfig"];

/**
 * THE proof a non-PagerDuty record must pass to be pushed, in the documented order, shared by the first push
 * (`selectRecordPushCandidates`) and a retry (`proveRecordForRetry`) so the two can never drift. `null` means
 * proven. The enable boundary and the dedupe row belong to the FIRST push only and are checked by the caller.
 */
function proofSkip(
  db: Database,
  r: Row,
  ctx: {
    readonly severities: ReadonlySet<string>;
    readonly nowMs: number;
    readonly serviceConfig: ServiceLookup;
  },
): RecordPushSkip | null {
  if (r.severity === null || !severityInSet(r.trigger_service, r.severity, ctx.severities)) {
    return "severity_not_in_push_set";
  }
  if (r.opened_at_ms === null) return "no_open_time";
  if (r.service === null) return "unbound";
  const proof = ownerOnCallForService(
    db,
    ctx.serviceConfig(r.service) ?? { pagerdutyServices: [] },
    ctx.nowMs,
  );
  if (proof === "yes") return null;
  if (proof === "stale") return "stale_oncall_data";
  if (proof === "no_data") return "no_oncall_data";
  return "owner_not_on_call";
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
  const floor = input.enabledAtMs - ENABLE_GRACE_MS;
  const candidates: OncallIncident[] = [];
  for (const r of rows) {
    const reason = proofSkip(db, r, input);
    // Normal and not counted: older than the enable boundary, or already pushed (only once the record is
    // otherwise eligible, so a severity or open-time skip is still counted as before).
    const settled =
      r.opened_at_ms !== null &&
      reason !== "severity_not_in_push_set" &&
      (r.opened_at_ms < floor || input.alreadyPushed(r.trigger_item_id));
    if (settled) continue;
    if (reason === null) candidates.push(toIncident(r));
    else counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return { candidates, notPushed: counts };
}

export type RetryProof =
  | { readonly delivered: true; readonly incident: OncallIncident }
  | { readonly delivered: false; readonly reason: string };

const RETRY_REASON: Readonly<
  Record<RecordPushSkip | "not_a_source" | "not_open" | "gone", string>
> = {
  severity_not_in_push_set: "its severity is no longer in the push set",
  no_open_time: "it has no open time",
  unbound: "it is not bound to a service",
  no_oncall_data: "there is no on-call data for its service",
  stale_oncall_data: "the on-call data for its service is stale",
  owner_not_on_call: "you are not on call for this service now",
  not_a_source: "its source is no longer opted in under [oncall.push] sources",
  not_open: "the incident is no longer open",
  gone: "the record no longer exists",
};

/**
 * A retry of a NON-PagerDuty record is delivered only if it passes the same proof as its first push, now: the
 * source is still opted in, the record is open, and `proofSkip` (severity, bound, owner on call on fresh data)
 * holds. A PagerDuty id never reaches this function (its retry is unchanged). The brief is stored either way.
 */
export function proveRecordForRetry(
  db: Database,
  itemId: string,
  input: Pick<RecordSelectInput, "sources" | "severities" | "nowMs" | "serviceConfig">,
): RetryProof {
  const r = db.query(`${SELECT} WHERE trigger_item_id = ?`).get(itemId) as Row | null;
  const no = (k: keyof typeof RETRY_REASON): RetryProof => ({
    delivered: false,
    reason: RETRY_REASON[k],
  });
  if (r === null) return no("gone");
  if (r.trigger_service === "pagerduty" || !input.sources.includes(r.trigger_service)) {
    return no("not_a_source");
  }
  if (r.status !== "open") return no("not_open");
  const skip = proofSkip(db, r, input);
  return skip === null ? { delivered: true, incident: toIncident(r) } : no(skip);
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
