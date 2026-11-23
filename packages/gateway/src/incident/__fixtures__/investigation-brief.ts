import type { IncidentInvestigationBrief } from "../../agents/_lib/incident-types.ts";
import type { Investigation } from "../investigate.ts";

const T = Date.UTC(2026, 10, 10, 12, 0);

/** A valid investigation of an open PagerDuty incident, for render, reserved-section and synthesis tests. */
export function buildInvestigationFixture(over: Partial<Investigation> = {}): Investigation {
  return {
    recordId: "inc_0123456789abcdef",
    version: 2,
    asOfMs: T + 3_600_000,
    span: { fromMs: T - 6 * 3_600_000, toMs: T + 3_600_000 },
    trigger: {
      itemId: "pagerduty:P1",
      service: "pagerduty",
      type: "incident",
      title: "Payments latency",
      url: "https://example.test/i/1",
      status: "open",
      severity: "p1",
      openedAtMs: T,
      closedAtMs: null,
    },
    binding: { bound: true, service: "payment-service", via: "pagerduty_service" },
    sentry: {
      status: "ok",
      projects: ["payments-api"],
      rows: [
        {
          itemId: "sentry:S1",
          title: "TypeError in charge()",
          url: "https://sentry.test/s/1",
          project: "payments-api",
          level: "error",
          status: "unresolved",
          count: 120,
          userCount: 9,
          firstSeenMs: T - 600_000,
          lastSeenMs: T + 60_000,
          newSinceDeploy: true,
        },
      ],
      total: 1,
      scanCapped: false,
    },
    data: null,
    relatedOpen: { items: [], total: 0 },
    actions: [{ atMs: T + 120_000, kind: "action_approved", text: "Argo CD rollback to 41" }],
    leads: [
      {
        kind: "deployment",
        refId: "deploy:D1",
        text: "Deployment D1 finished 5 min before the alert (timing only, not a proven cause)",
      },
    ],
    gaps: [{ code: "live_datadog", detail: "GAP-DETAIL-SENTINEL" }],
    freshness: [{ service: "sentry", connected: true, lastSyncMs: T }],
    recordAssembledAtMs: T,
    ...over,
  };
}

/** The brief form, with `gaps` mirroring the investigation's own (detail only), as the synthesis builds it. */
export function buildInvestigationBriefFixture(
  over: Partial<Investigation> = {},
): IncidentInvestigationBrief {
  const investigation = buildInvestigationFixture(over);
  return {
    kind: "incident_investigation",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: investigation.gaps.map((g) => ({
      category: "missing_entity_type" as const,
      detail: g.detail,
    })),
    investigation,
  };
}
