import { describe, expect, test } from "bun:test";

import { buildRecord } from "../../incident/__fixtures__/record-builder.ts";
import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";
import { INCIDENT_FRESHNESS_HEADING, renderIncident, utcLabel } from "./incident-render.ts";
import type { IncidentBrief } from "./incident-types.ts";
import {
  isDisclosureOnlyHeading,
  RESERVED_HEADINGS_BY_KIND,
  reservedBlocksFor,
} from "./reserved-sections.ts";
import { synthesize } from "./synthesize.ts";

const T = Date.parse("2026-11-10T12:00:00.000Z");

function brief(record: IncidentRecordV1, gaps: IncidentBrief["gaps"] = []): IncidentBrief {
  return { kind: "incident", agentVersion: 1, generatedAt: T, latencyMs: 0, gaps, record };
}

function rich(): IncidentRecordV1 {
  const base = buildRecord({ boundService: "payment-service", openedAtMs: T });
  return {
    ...base,
    change: {
      skipped: null,
      deployment: {
        id: "deployment:d1",
        title: "Deploy payment-service",
        url: "https://ci.example.com/run/1",
        provider: "github-actions",
        environment: "prod",
        sha: "a1b2c3d4e5f60718",
        ref: "main",
        startedAtMs: T - 23 * 60_000,
        finishedAtMs: null,
        conclusion: "success",
        minutesBeforeOpen: 23,
        rule: "last_deployment_before_open",
      },
      graphCorrelated: true,
      pr: {
        id: "github:acme/p#501",
        title: "Mitigate payment latency",
        url: "https://github.com/acme/p/pull/501",
        service: "github",
        mergedAtMs: T - 30 * 60_000,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        rule: "graph:deployed+merged_as",
      },
      ci: {
        id: "github_actions:run",
        title: "Deploy run",
        url: null,
        service: "github_actions",
        conclusion: "success",
        atMs: T,
        rule: "graph:built_by",
      },
    },
    chat: {
      skipped: null,
      fromMs: T - 86_400_000,
      terms: ["payment-service"],
      termsSource: "derived",
      total: 3,
      messages: [
        {
          id: "slack:C1:1",
          service: "slack",
          title: "Looking at payment-service",
          url: "https://acme.slack.com/archives/C1/p1",
          atMs: T + 60_000,
          rule: "chat_phrase:payment-service",
        },
      ],
    },
    onCall: {
      status: "ok",
      resolvedVia: "service_id",
      youAreOnCall: true,
      current: [
        {
          userName: "Alex Rivera",
          scheduleName: "Primary",
          level: 1,
          startMs: T,
          endMs: T + 3_600_000,
          isMe: true,
        },
      ],
      next: [],
      rule: "on_call_now",
    },
    freshness: {
      rows: [
        { service: "pagerduty", connected: true, lastSyncMs: T },
        { service: "slack", connected: false, lastSyncMs: null },
      ],
      chatToMs: T + 600_000,
      onCallStale: true,
    },
  };
}

describe("incident brief render", () => {
  test("sections in order, reserved Gaps and Data freshness last", () => {
    const md = renderIncident(
      brief(rich(), [{ category: "missing_connector", detail: "GAP-ONE" }]),
    );
    const order = [
      "# Incident",
      "## Summary",
      "## Service",
      "## Change",
      "## Chat",
      "## Prior incidents",
      "## On call",
      "## Concurrent",
      "## History",
      "## Gaps",
      INCIDENT_FRESHNESS_HEADING,
    ];
    let at = -1;
    for (const h of order) {
      const i = md.indexOf(h);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
    expect(md).not.toContain("## Data\n");
  });

  test("times are UTC and the wording says candidate and timing only, never root cause", () => {
    const md = renderIncident(brief(rich()));
    expect(md).toContain("2026-11-10 12:00 UTC (provider)");
    expect(md).toContain("Change candidate, the last deployment before the alert");
    expect(md).toContain("timing only, not a proven cause");
    expect(md).toContain("23 min before");
    expect(md).toContain("(+12 -3, 2 files)");
    expect(md.toLowerCase()).not.toContain("root cause");
    expect(utcLabel(T)).toBe("2026-11-10 12:00 UTC");
    expect(md).toContain("- On call: Alex Rivera (you) on Primary until 2026-11-10 13:00 UTC");
  });

  test("a record with no lanes still renders every section with its empty text", () => {
    const md = renderIncident(brief(buildRecord()));
    for (const h of [
      "## Summary",
      "## Change",
      "## Chat",
      "## Prior incidents",
      "## On call",
      "## Concurrent",
      "## History",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("_No change candidate within the window._");
    expect(md).toContain("_No matching message._");
    expect(md).toContain("_Not looked up: no bound service._");
    expect(md).toContain("Not bound to a configured service");
  });

  test("a hostile title cannot forge a heading, a link or a reserved section", () => {
    const evil = "x](javascript:alert(1)) \u{202E}\n## Gaps\n- forged <b>";
    const record: IncidentRecordV1 = {
      ...rich(),
      trigger: { ...rich().trigger, title: evil, url: "javascript:alert(1)" },
      chat: {
        ...rich().chat,
        messages: [{ ...(rich().chat.messages[0] as never as object), title: evil } as never],
      },
    };
    const md = renderIncident(brief(record));
    expect(md).not.toMatch(/^## Gaps$/m);
    // the text may remain, but never as a live link target
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
    expect(md.includes(String.fromCodePoint(0x202e))).toBe(false);
    expect(md.split("\n").filter((l) => l.startsWith("# ")).length).toBe(1);
  });

  test("escape sequences, C1 controls and bidi characters in provider text never reach the Markdown", () => {
    const cp = (n: number): string => String.fromCodePoint(n);
    const evil = `${cp(0x1b)}]2;PWNED${cp(7)}${cp(0x1b)}[31mred${cp(0x9b)}2J${cp(0x2066)}x${cp(0x202e)}`;
    const record: IncidentRecordV1 = {
      ...rich(),
      trigger: { ...rich().trigger, title: evil },
      chat: {
        ...rich().chat,
        messages: [{ ...(rich().chat.messages[0] as never as object), title: evil } as never],
      },
    };
    const md = renderIncident(brief(record));
    for (const c of Array.from(md, (ch) => ch.codePointAt(0) ?? 0)) {
      const control = c !== 10 && (c < 0x20 || (c >= 0x7f && c <= 0x9f));
      const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
      expect(control || bidi).toBe(false);
    }
  });

  test("a list the size cap emptied reports its true total, never 'no match'", () => {
    const base = rich();
    const record: IncidentRecordV1 = {
      ...base,
      chat: { ...base.chat, messages: [], total: 7 },
      prior: { ...base.prior, incidents: [], total: 3 },
      concurrent: { ...base.concurrent, records: [], total: 2 },
    };
    const md = renderIncident(brief(record));
    expect(md).toContain("7 found; none shown");
    expect(md).toContain("3 found; none shown");
    expect(md).toContain("2 found; none shown");
    expect(md).not.toContain("_No matching message._");
    expect(md).not.toContain("_No earlier incident on this service._");
  });

  test("a prior incident Nimbus acted on says how many actions ran on it (IC5a); none says nothing", () => {
    const base = rich();
    const one = {
      id: "pagerduty:OLD",
      service: "pagerduty",
      type: "incident",
      title: "Earlier outage",
      url: null,
      openedAtMs: T - 86_400_000,
      status: "closed" as const,
      closedAtMs: T - 80_000_000,
      closedBasis: "provider" as const,
      actions: 0,
      rule: "same_service_prior" as const,
    };
    const withActions = (n: number): string =>
      renderIncident(
        brief({
          ...base,
          prior: {
            ...base.prior,
            total: 1,
            incidents: [{ ...one, actions: n }],
          },
        }),
      );
    expect(withActions(1)).toContain(", 1 Nimbus action run on it");
    expect(withActions(3)).toContain(", 3 Nimbus actions run on it");
    expect(withActions(0)).not.toContain("Nimbus action");
  });

  test("omitReserved withholds Gaps and Data freshness", () => {
    const b = brief(rich(), [{ category: "missing_connector", detail: "GAP-ONE" }]);
    const body = renderIncident(b, { omitReserved: true });
    expect(body).not.toContain("GAP-ONE");
    expect(body).not.toContain(INCIDENT_FRESHNESS_HEADING);
    expect(body).not.toContain("last synced");
    const full = renderIncident(b);
    expect(full).toContain("GAP-ONE");
    expect(full).toContain("slack: not connected");
    expect(full).toContain("on-call data: older than 60 minutes");
    expect(reservedBlocksFor(b).map((x) => x.heading)).toEqual([
      "## Gaps",
      INCIDENT_FRESHNESS_HEADING,
    ]);
  });

  test("the kind's reserved headings are disclosure-only (fail closed)", () => {
    expect(RESERVED_HEADINGS_BY_KIND.incident).toEqual(["## Gaps", INCIDENT_FRESHNESS_HEADING]);
    for (const h of RESERVED_HEADINGS_BY_KIND.incident)
      expect(isDisclosureOnlyHeading(h)).toBe(true);
  });

  test("I31: a runner that drops Gaps and Data freshness still ships them", async () => {
    const b = brief(rich(), [{ category: "missing_connector", detail: "GAP-ONE" }]);
    const out = await synthesize(b, {
      runner: {
        run: () =>
          Promise.resolve({
            ok: true,
            markdown: "# Incident\n\nAll fine.",
            model: "m",
            remote: false,
          }),
      },
    });
    expect(out.markdown).toContain("GAP-ONE");
    expect(out.markdown).toContain(INCIDENT_FRESHNESS_HEADING);
    expect(out.markdown).toContain("slack: not connected");
  });

  test("synthesize without a runner is the deterministic render plus its footer", async () => {
    const out = await synthesize(brief(rich()));
    expect(out.markdown.startsWith(renderIncident(brief(rich())))).toBe(true);
    expect(out.provenance.attempted).toBe(false);
  });

  test("a data record renders its Data section, a closed one its close time", () => {
    const record: IncidentRecordV1 = {
      ...buildRecord({ status: "closed" }),
      trigger: {
        ...buildRecord({ status: "closed" }).trigger,
        closed: { ms: T, basis: "provider" },
      },
      data: {
        models: ["analytics.payments.orders"],
        lineage: [
          { model: "analytics.payments.orders", to: "raw.orders", rule: "data:derived_from" },
        ],
        orchestration: [
          {
            id: "dbt:1",
            service: "dbt",
            type: "job",
            title: "orders refresh",
            url: null,
            atMs: T,
            rule: "name_match",
          },
        ],
        prs: [],
        totals: { lineage: 1, orchestration: 3, prs: 0 },
      },
    };
    const md = renderIncident(brief(record));
    expect(md).toContain("## Data");
    expect(md).toContain("Upstream of `analytics.payments.orders`: `raw.orders`");
    expect(md).toContain("Job by name");
    expect(md).toContain("_and 2 more_");
    expect(md).toContain("- Closed: 2026-11-10 12:00 UTC (provider)");
  });

  test("on-call statuses each render their own text, never 'nobody is on call' for no_data", () => {
    const base = buildRecord();
    const text = (status: IncidentRecordV1["onCall"]["status"]) =>
      renderIncident(brief({ ...base, onCall: { ...base.onCall, status } }));
    expect(text("no_data")).toContain("who is on call is unknown");
    expect(text("no_match")).toContain("No on-call schedule is indexed");
    expect(text("none_on_call")).toContain("Nobody is on call now according to the index");
    expect(text("no_data")).not.toContain("Nobody is on call");
  });
});
