import type { IncidentUpdateBrief } from "../../agents/_lib/incident-types.ts";

/** A valid incident-update brief: a short deterministic update text, for render and reserved-section tests. */
export function buildUpdateBriefFixture(
  over: Partial<IncidentUpdateBrief> = {},
): IncidentUpdateBrief {
  return {
    kind: "incident_update",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [{ category: "missing_relation_emit", detail: "GAP-DETAIL-SENTINEL" }],
    recordId: "inc_0123456789abcdef",
    version: 1,
    audience: "stakeholders",
    text: [
      "Incident update: Payments latency (inc_0123456789abcdef, version 1)",
      "",
      "Status: open. A deployment finished 5 min before the alert (timing only, not a proven cause).",
      "",
      "Next update: when the status changes.",
      "Drafted by Nimbus from the local index at 1970-01-01 00:00 UTC. Not checked with the provider.",
      "",
    ].join("\n"),
    ...over,
  };
}
