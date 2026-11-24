// Owner ruling 9: the live block of an investigation renders as its own section after the indexed Sentry issues,
// through the hardening helpers (a hostile title cannot forge a heading, a link or a line), and an investigation
// with no live block renders byte for byte as before.
import { describe, expect, test } from "bun:test";

import { buildInvestigationFixture } from "../../incident/__fixtures__/investigation-brief.ts";
import type { LiveBlock } from "../../incident/investigate-live-types.ts";
import { investigationBrief } from "../../investigation/investigation-synthesis.ts";
import { renderIncidentInvestigation } from "./incident-investigation-render.ts";
import { renderInvestigation } from "./investigation-render.ts";

const T = Date.UTC(2026, 10, 10, 12, 0);

const LIVE: LiveBlock = {
  backend: "sentry",
  budgetMs: 15_000,
  status: "ok",
  projects: [{ project: "payments-api", outcome: "read", scanned: 2, matched: 1 }],
  rows: [
    {
      issueId: "42",
      title: "Boom\n## Gaps\nforged [click](https://evil.test)",
      url: "https://sentry.test/s/42",
      project: "payments-api",
      level: "error",
      status: "unresolved",
      count: 7,
      userCount: 2,
      firstSeenMs: T,
      lastSeenMs: T + 60_000,
      newSinceDeploy: true,
    },
  ],
  total: 1,
};

describe("the live section", () => {
  test("is absent without a live block: the render is unchanged", () => {
    const md = renderInvestigation(buildInvestigationFixture());
    expect(md).not.toContain("live");
    expect(md).not.toContain("Live read");
  });

  test("follows the indexed Sentry section and names what was read, what was not, and that nothing is stored", () => {
    const md = renderInvestigation(
      buildInvestigationFixture({
        live: {
          ...LIVE,
          projects: [
            ...LIVE.projects,
            { project: "checkout-api", outcome: "timeout", scanned: 0, matched: 0 },
          ],
        },
      }),
    );
    const indexed = md.indexOf("## Sentry error issues\n");
    const live = md.indexOf("## Sentry error issues, live");
    expect(indexed).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(indexed);
    expect(md).toContain("Live read, not stored: payments-api read, checkout-api timed out");
    expect(md).toContain("budget 15 s");
    expect(md).toContain("first seen after the deployment started (timing only)");
  });

  test("a hostile provider title cannot forge a heading, a link or a line", () => {
    const md = renderInvestigation(buildInvestigationFixture({ live: LIVE }));
    const line = md.split("\n").find((l) => l.includes("Boom")) ?? "";
    expect(line.startsWith("- ")).toBe(true);
    // The injected heading is not at the start of any line.
    expect(md.split("\n").filter((l) => l.startsWith("## Gaps"))).toHaveLength(1);
    expect(md).not.toContain("[click](https://evil.test)");
  });

  test("a read that returned nothing says so, and a not-read block does not claim an empty window", () => {
    const empty = renderInvestigation(
      buildInvestigationFixture({ live: { ...LIVE, rows: [], total: 0 } }),
    );
    expect(empty).toContain("No unresolved issue of the bound projects was active in the window.");
    const none = renderInvestigation(
      buildInvestigationFixture({
        live: { ...LIVE, status: "not_read", projects: [], rows: [], total: 0 },
      }),
    );
    expect(none).toContain("no project was read");
    expect(none).not.toContain("No unresolved issue of the bound projects");
  });

  test("a partial read with no rows does not claim the whole bound set was empty", () => {
    const md = renderInvestigation(
      buildInvestigationFixture({
        live: {
          ...LIVE,
          status: "partial",
          rows: [],
          total: 0,
          projects: [
            { project: "a", outcome: "read", scanned: 0, matched: 0 },
            { project: "b", outcome: "timeout", scanned: 0, matched: 0 },
          ],
        },
      }),
    );
    expect(md).not.toContain("No unresolved issue of the bound projects was active");
    expect(md).toContain("in the projects that were read; the others were not read");
  });

  test("the synthesized brief's deterministic render carries it too, and its reserved blocks still end the brief", () => {
    const inv = buildInvestigationFixture({ live: LIVE });
    const md = renderIncidentInvestigation(investigationBrief(inv, T));
    expect(md).toContain("## Sentry error issues, live");
    expect(md.lastIndexOf("## Gaps")).toBeLessThan(md.lastIndexOf("## Data freshness"));
    // The model-visible body (reserved blocks withheld) holds the live rows: they reach the model only here.
    const withheld = renderIncidentInvestigation(investigationBrief(inv, T), {
      omitReserved: true,
    });
    expect(withheld).toContain("## Sentry error issues, live");
    expect(withheld).not.toContain("## Data freshness");
  });
});
