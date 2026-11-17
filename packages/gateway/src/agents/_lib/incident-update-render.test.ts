import { describe, expect, test } from "bun:test";

import { buildRecord } from "../../incident/__fixtures__/record-builder.ts";
import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";
import type { Timeline } from "../../incident/timeline.ts";
import { chatSafe, renderIncidentUpdate } from "./incident-update-render.ts";

const OPEN = Date.parse("2026-11-17T10:00:00Z");
const NOW = Date.parse("2026-11-17T11:30:00Z");
const EMPTY: Timeline = { events: [], notes: [] };

function render(
  record: IncidentRecordV1,
  audience: "stakeholders" | "engineers",
  timeline: Timeline = EMPTY,
): string {
  return renderIncidentUpdate({
    recordId: "inc_0123456789abcdef",
    record,
    version: 3,
    timeline,
    audience,
    nowMs: NOW,
  });
}

describe("renderIncidentUpdate", () => {
  test("a stakeholder update of an open incident is fixed text plus the hardened facts", () => {
    const text = render(
      buildRecord({ title: "Payments latency", openedAtMs: OPEN, boundService: "payments" }),
      "stakeholders",
    );
    expect(text).toBe(
      [
        "Incident update: Payments latency",
        "Status: Ongoing | Service: payments | Severity: p1",
        "Record: inc_0123456789abcdef (version 3)",
        "",
        "Started: 2026-11-17 10:00 UTC",
        "Open for: 1 h 30 min",
        "",
        "What we know: 0 events on the timeline so far.",
        "",
        "Next update: when the status changes.",
        "Drafted by Nimbus from the local index at 2026-11-17 11:30 UTC. Not checked with the provider.",
        "",
      ].join("\n"),
    );
  });

  test("the render is deterministic", () => {
    const r = buildRecord({ openedAtMs: OPEN });
    expect(render(r, "engineers")).toBe(render(r, "engineers"));
  });

  test("a resolved incident states its duration and no next update", () => {
    const base = buildRecord({ openedAtMs: OPEN, status: "closed" });
    const r: IncidentRecordV1 = {
      ...base,
      trigger: { ...base.trigger, closed: { ms: OPEN + 45 * 60_000, basis: "provider" } },
    };
    const text = render(r, "stakeholders");
    expect(text).toContain("Status: Resolved");
    expect(text).toContain("Resolved: 2026-11-17 10:45 UTC (after 45 min)");
    expect(text).toContain("This incident is resolved.");
    expect(text).not.toContain("Next update");
  });

  test("a hostile title cannot open a Slack control sequence or forge a line", () => {
    const text = render(
      buildRecord({
        title: "boom <!here> <@U123> ‮evil\u001b[31m\nStatus: Resolved `x` *b*",
        openedAtMs: OPEN,
      }),
      "stakeholders",
    );
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("`");
    expect(text.split("\n")[0]).toBe(
      "Incident update: boom ‹!here› ‹@U123› evil [31m Status: Resolved x b",
    );
    expect(text.split("\n").filter((l) => l.startsWith("Status:"))).toHaveLength(1);
  });

  test("the engineer update adds the trigger, an https link only, and the latest events", () => {
    const base = buildRecord({ openedAtMs: OPEN });
    const events = Array.from({ length: 12 }, (_, i) => ({
      atMs: OPEN + i * 60_000,
      atBasis: "source" as const,
      kind: "state_change" as const,
      source: "pagerduty",
      itemId: null,
      text: `step ${String(i)}`,
      rule: null,
    }));
    const https = render(
      { ...base, trigger: { ...base.trigger, url: "https://acme.pagerduty.com/incidents/PD1" } },
      "engineers",
      { events, notes: [] },
    );
    expect(https).toContain("Trigger: pagerduty incident PD1");
    expect(https).toContain("Link: https://acme.pagerduty.com/incidents/PD1");
    expect(https).toContain("Latest 10 of 12 events:");
    expect(https).toContain("- 2026-11-17 10:11 UTC state change (pagerduty): step 11");
    expect(https).not.toContain("step 1\n");
    const js = render(
      { ...base, trigger: { ...base.trigger, url: "javascript:alert(1)" } },
      "engineers",
    );
    expect(js).not.toContain("Link:");
    const http = render(
      { ...base, trigger: { ...base.trigger, url: "http://acme.example/x" } },
      "engineers",
    );
    expect(http).not.toContain("Link:");
  });

  test("a stakeholder update shows no trigger id, link or events", () => {
    const base = buildRecord({ openedAtMs: OPEN });
    const text = render(
      { ...base, trigger: { ...base.trigger, url: "https://acme.pagerduty.com/incidents/PD1" } },
      "stakeholders",
    );
    expect(text).not.toContain("Trigger:");
    expect(text).not.toContain("https://");
  });

  test("an open incident with no open time says so", () => {
    const text = render(buildRecord({ openedAtMs: null }), "stakeholders");
    expect(text).toContain("Started: not recorded by the source");
    expect(text).not.toContain("Open for");
  });
});

describe("chatSafe", () => {
  test("caps and trims", () => {
    expect(chatSafe("  a  b  ")).toBe("a b");
    expect(chatSafe("x".repeat(130))).toBe(`${"x".repeat(120)}…`);
  });
});
