import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rankCascades } from "../../incident/cascade.ts";
import type { CascadeInfo } from "../../incident/cascade-read.ts";
import { INCIDENT_FRESHNESS_HEADING, renderCascadeSection } from "./incident-render.ts";
import { GAPS_HEADING, RESERVED_HEADINGS_BY_KIND } from "./reserved-sections.ts";

const T = Date.parse("2026-11-10T10:00:00.000Z");
const MIN = 60_000;
const deps = new Map<string, readonly string[]>([
  ["web", ["api"]],
  ["api", ["db"]],
  ["db", []],
]);

function scenario(titles: Record<string, string> = {}): {
  group: ReturnType<typeof rankCascades>[number];
  info: Map<string, CascadeInfo>;
} {
  const records = [
    {
      id: "inc_aaaaaaaaaaaaaaaa",
      service: "api",
      source: "pagerduty",
      openedAtMs: T,
      deploymentId: null,
    },
    {
      id: "inc_bbbbbbbbbbbbbbbb",
      service: "db",
      source: "jira",
      openedAtMs: T + MIN,
      deploymentId: null,
    },
    {
      id: "inc_cccccccccccccccc",
      service: "web",
      source: "sentry",
      openedAtMs: T + 2 * MIN,
      deploymentId: null,
    },
  ];
  const info = new Map<string, CascadeInfo>(
    records.map((r) => [
      r.id,
      {
        title: titles[r.id] ?? `${r.service} alert`,
        source: r.source,
        service: r.service,
        openedAtMs: r.openedAtMs,
      },
    ]),
  );
  return { group: rankCascades(records, deps)[0] as never, info };
}

describe("8.1 renderCascadeSection", () => {
  test("for the root: it says it is the root candidate and lists every member with its reason", () => {
    const { group, info } = scenario();
    const md = renderCascadeSection(group, "inc_bbbbbbbbbbbbbbbb", info);
    expect(md.startsWith("## Cascade\n\n")).toBe(true);
    expect(md).toContain("This record is the ranked root candidate of 3 open records");
    expect(md).toContain("It ranks candidates; it does not prove a cause.");
    expect(md).toContain(
      "- Root candidate: db alert (jira, db, opened 2026-11-10 10:01 UTC): 2 other open records",
    );
    expect(md).toContain("depends on the root through api -> db (declared depends_on)");
    expect(md).toContain("depends on the root through web -> api -> db (declared depends_on)");
    expect(md).not.toMatch(/\bcause[sd]?\b(?! a cause)/);
  });

  test("for a downstream member: it names the root", () => {
    const { group, info } = scenario();
    const md = renderCascadeSection(group, "inc_aaaaaaaaaaaaaaaa", info);
    expect(md).toContain(
      "This record is downstream of `db alert`, the ranked root candidate of 3 open records",
    );
  });

  test("a group with no declared relation is labelled so, and time_only reasons say how long after", () => {
    const records = [
      {
        id: "inc_aaaaaaaaaaaaaaaa",
        service: "x",
        source: "pagerduty",
        openedAtMs: T,
        deploymentId: null,
      },
      {
        id: "inc_bbbbbbbbbbbbbbbb",
        service: "y",
        source: "pagerduty",
        openedAtMs: T + 4 * MIN,
        deploymentId: null,
      },
    ];
    const info = new Map<string, CascadeInfo>(
      records.map((r) => [
        r.id,
        { title: r.id, source: r.source, service: r.service, openedAtMs: r.openedAtMs },
      ]),
    );
    const group = rankCascades(records, new Map())[0] as never;
    const md = renderCascadeSection(group, "inc_bbbbbbbbbbbbbbbb", info);
    expect(md).toContain("no depends_on is declared among these services; ranked by open time");
    expect(md).toContain("no declared path to the root; opened 4 min after it");
    expect(md).toContain("ranked by open time (no declared dependency decides it)");
  });
});

describe("8.2 no new reserved heading, no synthesis", () => {
  test("the incident brief's reserved headings are unchanged", () => {
    expect(RESERVED_HEADINGS_BY_KIND.incident).toEqual([GAPS_HEADING, INCIDENT_FRESHNESS_HEADING]);
  });

  test("the new rendering and read code never call synthesize()", () => {
    const here = import.meta.dir;
    for (const rel of [
      "incident-render.ts",
      "../../incident/cascade.ts",
      "../../incident/cascade-read.ts",
      "../../incident/timeline.ts",
      "../../incident/timeline-read.ts",
      "../../audit/incident-replay.ts",
    ]) {
      const src = readFileSync(join(here, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src).not.toMatch(/\bsynthesize\s*\(/);
    }
  });
});

describe("8.3 a hostile title renders inert", () => {
  test("ANSI, bidi, a heading, a Markdown link and a newline stay on the member's own line", () => {
    const evil = "\u001b[31mred\u001b[0m ‮evil\n## Gaps\n[x](javascript:alert(1))";
    const { group, info } = scenario({ inc_bbbbbbbbbbbbbbbb: evil });
    for (const me of ["inc_bbbbbbbbbbbbbbbb", "inc_aaaaaaaaaaaaaaaa"]) {
      const md = renderCascadeSection(group, me, info);
      expect(md).not.toContain("\u001b");
      expect(md).not.toContain("‮");
      expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Cascade"]);
      expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
    }
  });
});
