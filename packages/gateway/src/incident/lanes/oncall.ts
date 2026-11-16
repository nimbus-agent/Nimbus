import type { Database } from "bun:sqlite";
import {
  type OncallNowResult,
  type OncallShiftView,
  queryOncallNow,
} from "../../index/oncall-now-query.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { GapNote, OnCallLane, OnCallPerson } from "../incident-record-types.ts";
import { codeUnitCompare, gap } from "./caps.ts";

/**
 * Lane 7, on call (Phase 10 IC3, design C step 9): who is on call for the service now, from the index only.
 * DISPLAY ONLY: the push never reads this lane (it recomputes `ownerOnCallForService` by exact PagerDuty
 * service id at push time). `resolvedVia` is stored so a service-name or schedule-name SUBSTRING match is
 * visible as such. Never stores an e-mail address, and never stores how stale a source was (that is volatile,
 * and lives in the record's freshness block).
 */

export type OnCallResult = {
  readonly lane: OnCallLane;
  readonly gaps: readonly GapNote[];
  /** Whether any source behind the lane was older than the staleness bound (volatile, for `freshness`). */
  readonly stale: boolean | null;
};

const SHOWN = 3;

function person(s: OncallShiftView): OnCallPerson {
  return {
    userName: s.userName,
    scheduleName: s.scheduleName ?? s.policyName,
    level: s.level,
    startMs: s.startMs,
    endMs: s.endMs,
    isMe: s.isMe,
  };
}

function personOrder(a: OnCallPerson, b: OnCallPerson): number {
  return (
    codeUnitCompare(a.scheduleName ?? "", b.scheduleName ?? "") ||
    (a.level ?? 0) - (b.level ?? 0) ||
    codeUnitCompare(a.userName ?? "", b.userName ?? "") ||
    (a.startMs ?? 0) - (b.startMs ?? 0) ||
    (a.endMs ?? 0) - (b.endMs ?? 0)
  );
}

function skipped(): OnCallResult {
  return {
    lane: {
      status: "skipped",
      resolvedVia: null,
      youAreOnCall: null,
      current: [],
      next: [],
      rule: "on_call_now",
    },
    gaps: [
      gap(
        "missing_relation_emit",
        "Who is on call was not looked up: this item is not bound to a service and carries no PagerDuty service id.",
      ),
    ],
    stale: null,
  };
}

function fromResult(r: OncallNowResult): OnCallResult {
  const gaps: GapNote[] = [];
  if (r.status === "no_data") {
    gaps.push(
      gap(
        "missing_connector",
        "No on-call shifts are indexed, so who is on call is unknown (this is not evidence that nobody is).",
        "Run `nimbus connector auth pagerduty` (or Jira Service Management) to index on-call schedules.",
      ),
    );
  } else if (r.status === "no_match") {
    gaps.push(gap("missing_relation_emit", "No on-call schedule is indexed for this service."));
  }
  return {
    lane: {
      status: r.status,
      resolvedVia: r.resolvedVia,
      youAreOnCall: r.status === "ok" ? r.youAreOnCall : null,
      current: r.shifts.slice(0, SHOWN).map(person).sort(personOrder),
      next: r.next.slice(0, SHOWN).map(person).sort(personOrder),
      rule: "on_call_now",
    },
    gaps,
    stale: r.sources.length === 0 ? null : r.sources.some((s) => s.stale),
  };
}

export function oncallLane(
  db: Database,
  input: {
    readonly nowMs: number;
    readonly cfg: ServiceConfig | null;
    readonly triggerService: string;
    readonly pagerdutyServiceId: string | null;
  },
): OnCallResult {
  if (input.triggerService === "pagerduty" && input.pagerdutyServiceId !== null) {
    return fromResult(
      queryOncallNow(db, { nowMs: input.nowMs, pagerdutyServiceId: input.pagerdutyServiceId }),
    );
  }
  if (input.cfg === null) return skipped();
  return fromResult(
    queryOncallNow(db, {
      nowMs: input.nowMs,
      term: input.cfg.serviceId,
      serviceConfigs: [
        { serviceId: input.cfg.serviceId, pagerdutyServices: input.cfg.pagerdutyServices },
      ],
    }),
  );
}
