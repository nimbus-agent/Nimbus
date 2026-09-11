import { describe, expect, test } from "bun:test";
import type { ChangelogBrief } from "./changelog-types.ts";
import { renderChangelog } from "./render.ts";

const NOW = 1_800_000_000_000;

function brief(over: Partial<ChangelogBrief> = {}): ChangelogBrief {
  return {
    kind: "changelog",
    agentVersion: 1,
    generatedAt: NOW,
    latencyMs: 5,
    gaps: [],
    query: { sinceMs: NOW - 604_800_000, nowMs: NOW, service: null },
    mergedPrs: [],
    deployments: [],
    incidentsOpened: [],
    incidentsResolved: [],
    counts: { mergedPrs: 0, deployments: 0, incidentsOpened: 0, incidentsResolved: 0 },
    indexTimedCount: 0,
    nonGithubMergedPrs: 0,
    truncatedCount: 0,
    ...over,
  };
}

describe("renderChangelog", () => {
  test("renders every category heading even at zero", () => {
    const md = renderChangelog(brief());
    for (const h of [
      "## Merged Pull Requests",
      "## Deployments",
      "## Incidents Opened",
      "## Incidents Resolved",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("_None in this window._");
  });

  test("omitReserved actually removes the Gaps section", () => {
    // I31 fail-closed: if the two renders come back identical, synthesize.ts refuses to
    // attempt a rewrite at all. A renderer ignoring the flag must fail HERE, loudly.
    const b = brief({ gaps: [{ category: "missing_entity_type", detail: "d", remediation: "r" }] });
    const full = renderChangelog(b);
    const without = renderChangelog(b, { omitReserved: true });
    expect(full).toContain("## Gaps");
    expect(without).not.toContain("## Gaps");
    expect(full).not.toBe(without);
  });

  test("the time-basis disclosure appears when an entry is index-timed", () => {
    const md = renderChangelog(brief({ indexTimedCount: 3 }));
    expect(md).toContain("same basis");
  });

  test("the truncation disclosure appears only when entries were dropped", () => {
    expect(renderChangelog(brief())).not.toContain("truncated");
    expect(renderChangelog(brief({ truncatedCount: 12 }))).toContain("truncated");
  });

  test("the window and the service scope are stated", () => {
    expect(renderChangelog(brief())).toContain("all services");
    expect(
      renderChangelog(brief({ query: { sinceMs: NOW - 1, nowMs: NOW, service: "pay" } })),
    ).toContain("pay");
  });

  test("an entry renders as a dated link, and an unlinked entry still renders", () => {
    const md = renderChangelog(
      brief({
        mergedPrs: [
          {
            id: "github:1",
            service: "github",
            title: "Fix auth",
            url: "https://x/1",
            atMs: NOW,
            timeSource: "event",
          },
          {
            id: "github:2",
            service: "github",
            title: "No link",
            url: null,
            atMs: NOW,
            timeSource: "event",
          },
        ],
        counts: { mergedPrs: 2, deployments: 0, incidentsOpened: 0, incidentsResolved: 0 },
      }),
    );
    expect(md).toContain("[Fix auth](https://x/1)");
    expect(md).toContain("No link");
    // The category that HAS entries must not also claim emptiness.
    expect(md.split("## Deployments")[0]).not.toContain("_None in this window._");
  });

  test("a connector-supplied title and url cannot break out of the link", () => {
    // Both halves are external input — a PR subject anyone can write, and a connector's
    // `canonical_url` — so both go through the same hardened helpers `negotiate` uses.
    const md = renderChangelog(
      brief({
        mergedPrs: [
          {
            id: "github:1",
            service: "github",
            title: "Oops](https://evil.example) rest",
            url: "javascript:alert(1)",
            atMs: NOW,
            timeSource: "event",
          },
        ],
      }),
    );
    // The unsafe scheme is refused outright, so the entry renders unlinked rather than
    // pointing somewhere a click would execute.
    expect(md).not.toContain("javascript:");
    // The `]` is escaped, so the title cannot close a link it never opened. Asserted on the
    // UNESCAPED sequence: `"](https://evil.example)"` alone still occurs after the backslash.
    expect(md).not.toContain("Oops](");
    expect(md).toContain("Oops\\](");
  });

  test("the preamble disclosure survives into preamble scope, where the I31 guard reads it", () => {
    // `preambleBody` stops at the first LEVEL-2 heading, so the header must be level 1 or the
    // disclosures land inside a section and `contractViolations` never sees them.
    const md = renderChangelog(brief());
    const preamble = md.split("\n## ")[0] ?? "";
    expect(preamble).toContain("cover only this window");
  });
});
