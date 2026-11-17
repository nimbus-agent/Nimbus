import type {
  IncidentPostmortemBrief,
  PostmortemAction,
} from "../../agents/_lib/incident-postmortem-types.ts";
import { buildRecord } from "./record-builder.ts";

/** A valid post-mortem brief over a closed record, for render, reserved-section and push tests. */
export function buildPostmortemFixture(
  over: {
    readonly title?: string;
    readonly actions?: readonly PostmortemAction[];
    readonly template?: IncidentPostmortemBrief["template"];
  } = {},
): IncidentPostmortemBrief {
  const record = buildRecord({
    status: "closed",
    ...(over.title === undefined ? {} : { title: over.title }),
  });
  return {
    kind: "incident_postmortem",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [{ category: "missing_relation_emit", detail: "GAP-DETAIL-SENTINEL" }],
    record: {
      ...record,
      version: 1,
      freshness: {
        rows: [{ service: "pagerduty", connected: true, lastSyncMs: 1_000_000 }],
        chatToMs: null,
        onCallStale: null,
      },
    },
    recordId: "inc_0123456789abcdef",
    impact: {
      openedMs: 1_000_000,
      openedBasis: "provider",
      resolvedMs: 1_000_000 + 95 * 60_000,
      resolvedBasis: "provider",
    },
    timeline: {
      events: [
        {
          atMs: 1_000_000,
          atBasis: "source",
          kind: "opened",
          source: "pagerduty",
          itemId: "pagerduty:PD1",
          text: "Opened: Payments latency",
          rule: null,
        },
      ],
      notes: [],
    },
    actions: over.actions ?? [],
    actionsTruncated: false,
    template: over.template ?? null,
  };
}
