import { createTool } from "@mastra/core/tools";

import { asRecord } from "../connectors/unknown-record.ts";
import type { LocalIndex } from "../index/local-index.ts";
import {
  type OncallNowResult,
  type OncallServiceBinding,
  type OncallShiftView,
  queryOncallNow,
} from "../index/oncall-now-query.ts";

/** The longest `service` argument the tool takes; a longer value is clipped, a non-string ignored. */
export const ONCALL_NOW_TOOL_MAX_SERVICE_CHARS = 128;

const NOTE =
  "Report this result as it is. Do not name anyone as on call that this result does not name, " +
  "and say how old the data is (sources[].oldestFetchedMs against asOfMs).";

// An e-mail address reaching a cloud model adds nothing to "who is on call", so names that look like
// one are reduced to the part before the @. The owner's own surfaces (`oncall.now`, `--json`) keep them.
const EMAIL_LIKE = /([^\s@]+)@[^\s@]+/g;

function withheld(s: string): string {
  return s.replace(EMAIL_LIKE, "$1");
}

type ToolShift = Omit<OncallShiftView, "userEmail">;

function toolShift(s: OncallShiftView): ToolShift {
  return {
    source: s.source,
    userName: withheld(s.userName),
    policyName: s.policyName === null ? null : withheld(s.policyName),
    scheduleName: s.scheduleName === null ? null : withheld(s.scheduleName),
    level: s.level,
    startMs: s.startMs,
    endMs: s.endMs,
    isMe: s.isMe,
    serviceNames: s.serviceNames.map(withheld),
    serviceIds: s.serviceIds,
  };
}

function toolResult(r: OncallNowResult): Record<string, unknown> {
  return {
    ...r,
    shifts: r.shifts.map(toolShift),
    next: r.next.map(toolShift),
    known: r.known.map(withheld),
    note: NOTE,
  };
}

function serviceArg(input: unknown): string | undefined {
  const raw = asRecord(input)?.["service"];
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().slice(0, ONCALL_NOW_TOOL_MAX_SERVICE_CHARS);
  return t === "" ? undefined : t;
}

/**
 * `oncall_now`: who is on call, from the indexed on-call shifts only (no provider call, no write). Its
 * output reaches the model only through `wrapToolForLlm` in `engine/agent.ts` (I11), never wrapped here.
 */
export function createOncallNowTool(deps: {
  localIndex: LocalIndex;
  serviceConfigs: () => readonly OncallServiceBinding[];
}) {
  return createTool({
    id: "oncall_now",
    description:
      "oncall_now(service?) — who is on call right now, from the on-call shifts Nimbus has indexed from PagerDuty and Jira Service Management. " +
      "Use this, never searchLocalIndex, for 'who is on call'. service is optional: a Nimbus service id, a PagerDuty service id or name, or a schedule or escalation-policy name; omit it for every shift. " +
      "It reads the local index only (no live provider call), so every result has an age: sources[].oldestFetchedMs against asOfMs, and stale: true past an hour. " +
      "status is ok (shifts lists who is on call), none_on_call (the data exists but no shift covers now; next lists upcoming shifts), no_match (nothing matches the service; known lists names to retry) or no_data (no on-call data is indexed; gaps says what to connect). " +
      "Jira Service Management shifts carry no start or end time. If the status is not ok, say so and stop: never guess who is on call.",
    execute: (inputData: unknown) =>
      Promise.try(() => {
        const term = serviceArg(inputData);
        const result = queryOncallNow(deps.localIndex.getDatabase(), {
          nowMs: Date.now(),
          serviceConfigs: deps.serviceConfigs(),
          ...(term === undefined ? {} : { term }),
        });
        return toolResult(result);
      }),
  });
}
