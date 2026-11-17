import { describe, expect, test } from "bun:test";

import type { Investigation } from "../../incident/investigate.ts";
import { renderInvestigation } from "./investigation-render.ts";

const T = Date.UTC(2026, 10, 10, 12, 0);
const ESC = String.fromCharCode(0x1b);
const BIDI = String.fromCharCode(0x202e);

function base(over: Partial<Investigation> = {}): Investigation {
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
    actions: [],
    leads: [],
    gaps: [{ code: "live_datadog", detail: "Datadog monitors are not read." }],
    freshness: [{ service: "sentry", connected: true, lastSyncMs: T }],
    recordAssembledAtMs: T,
    ...over,
  };
}

describe("renderInvestigation", () => {
  test("renders the fixed section order with Gaps and Data freshness last", () => {
    const md = renderInvestigation(
      base({
        leads: [{ kind: "deployment", refId: "deployment:1", text: "Candidate: timing only." }],
        actions: [{ atMs: T, kind: "action_approved", text: "slack.message.post" }],
        relatedOpen: {
          items: [
            { recordId: "inc_b", source: "jira", severity: null, title: "Alert", openedAtMs: null },
          ],
          total: 3,
        },
      }),
    );
    const heads = md.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual([
      "## Summary",
      "## Sentry error issues",
      "## Other open records of this service",
      "## What Nimbus did",
      "## Leads",
      "## Gaps",
      "## Data freshness",
    ]);
    expect(md).toContain("[TypeError in charge()](https://sentry.test/s/1)");
    expect(md).toContain("first seen after the deployment started (timing only)");
    expect(md).toContain("_and 2 more_");
    expect(md).toContain("approved: slack.message.post");
    expect(md).toContain("- Datadog monitors are not read.");
    expect(md.endsWith("\n")).toBe(true);
  });

  test("empty sections say so, an unlisted Sentry block points at the gaps, and data context appears only when present", () => {
    const md = renderInvestigation(
      base({
        sentry: { status: "not_scoped", projects: [], rows: [], total: 0, scanCapped: false },
        binding: { bound: false, service: null, via: null },
      }),
    );
    expect(md).toContain("_Not listed; see Gaps._");
    expect(md).toContain("_None._");
    expect(md).toContain("_No Nimbus action is linked to this record._");
    expect(md).toContain("_None found in the index._");
    expect(md).toContain("not bound to a configured service");
    expect(md).not.toContain("## Data-quality context");
    const withData = renderInvestigation(
      base({
        data: {
          models: ["analytics.payments.orders"],
          totals: { lineage: 1, orchestration: 1, prs: 0 },
          lineage: [{ model: "analytics.payments.orders", to: "raw.orders" }],
          orchestration: [
            { id: "airflow:d1", service: "airflow", type: "dag", title: "orders_dag", url: null },
          ],
        },
      }),
    );
    expect(withData).toContain("## Data-quality context");
    expect(withData).toContain("analytics.payments.orders <- raw.orders");
  });

  test("a Sentry issue with no counts or dates still renders", () => {
    const md = renderInvestigation(
      base({
        sentry: {
          status: "ok",
          projects: ["p"],
          rows: [
            {
              itemId: "sentry:S2",
              title: "Bare",
              url: null,
              project: "p",
              level: null,
              status: null,
              count: null,
              userCount: null,
              firstSeenMs: null,
              lastSeenMs: T,
              newSinceDeploy: false,
            },
          ],
          total: 1,
          scanCapped: false,
        },
      }),
    );
    expect(md).toContain("- Bare: project p; last seen");
    const none = renderInvestigation(
      base({ sentry: { status: "ok", projects: ["p"], rows: [], total: 0, scanCapped: false } }),
    );
    expect(none).toContain("_No Sentry issue of p was seen in the window._");
  });

  test("provider text cannot forge a heading, open a link or smuggle a control or break character", () => {
    const md = renderInvestigation(
      base({
        trigger: {
          ...base().trigger,
          title: `Pay](http://evil.test)\n## Injected${ESC}[31m${BIDI}`,
          url: null,
        },
        relatedOpen: {
          items: [
            {
              recordId: "inc_x",
              source: "jira",
              severity: null,
              title: "x\n## Also injected `code`",
              openedAtMs: T,
            },
          ],
          total: 1,
        },
      }),
    );
    const heads = md.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).not.toContain("## Injected");
    expect(heads.some((h) => h.includes("injected"))).toBe(false);
    expect(md).not.toMatch(/(^|[^\\])\]\(http:\/\/evil/);
    expect(md).not.toContain(BIDI);
    expect(md).not.toContain(ESC);
    expect(md).not.toContain("`code`");
  });

  test("is byte-identical across renders", () => {
    expect(renderInvestigation(base())).toBe(renderInvestigation(base()));
  });
});
