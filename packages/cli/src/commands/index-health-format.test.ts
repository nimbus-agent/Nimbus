import { describe, expect, test } from "bun:test";

import { formatIndexHealth, type IndexHealthReport } from "./index-health-format.ts";

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY_MS = 86_400_000;

function report(over: Partial<IndexHealthReport> = {}): IndexHealthReport {
  return {
    totalItems: 100,
    embeddingCoveragePercent: 90,
    connectors: [
      {
        service: "github",
        items: 100,
        embeddedItems: 90,
        embeddingCoveragePercent: 90,
        lastSyncMs: NOW - 2 * 3_600_000,
        staleDays: 0.1,
        stale: false,
        staleReason: null,
      },
    ],
    sparseTypes: [],
    confidence: 94,
    confidenceUnavailableReason: null,
    confidenceInputs: {
      embeddingCoveragePercent: 90,
      freshItemPercent: 100,
      coverageWeight: 0.6,
      freshnessWeight: 0.4,
    },
    staleThresholdDays: 7,
    generatedAtMs: NOW,
    ...over,
  };
}

describe("formatIndexHealth — the confidence line", () => {
  test("shows the score and BOTH inputs it was derived from", () => {
    // A bare score makes the user guess which half is bad. Both halves are always printed.
    const out = formatIndexHealth(report(), { nowMs: NOW, noColor: true });
    expect(out).toContain("94/100");
    expect(out).toMatch(/coverage 90%/);
    expect(out).toMatch(/freshness 100%/);
  });

  test("an empty index says so instead of printing a score", () => {
    const out = formatIndexHealth(
      report({
        totalItems: 0,
        connectors: [],
        confidence: null,
        confidenceUnavailableReason: "empty_index",
        embeddingCoveragePercent: 0,
        confidenceInputs: {
          embeddingCoveragePercent: 0,
          freshItemPercent: 0,
          coverageWeight: 0.6,
          freshnessWeight: 0.4,
        },
      }),
      { nowMs: NOW, noColor: true },
    );
    expect(out).toMatch(/index is empty/i);
    // The failure this guards: rendering `null` as 0 and telling a new user their brand-new
    // install scores zero out of a hundred.
    expect(out).not.toContain("0/100");
    // Real bug, not demo-specific: `nimbus sync` is not a registered command
    // (COMMAND_NAMES has no `sync`) — the hint must name a command that exists.
    expect(out).toContain("nimbus connector sync <service>");
    expect(out).not.toContain("nimbus sync`");
  });

  test("a low score is called out as low", () => {
    const out = formatIndexHealth(report({ confidence: 41 }), { nowMs: NOW, noColor: true });
    expect(out).toContain("41/100");
    expect(out).toMatch(/low/i);
  });

  test("a healthy score is not called low", () => {
    const out = formatIndexHealth(report({ confidence: 88 }), { nowMs: NOW, noColor: true });
    expect(out).not.toMatch(/\blow\b/i);
  });
});

describe("formatIndexHealth — connectors", () => {
  test("a stale connector is marked, a fresh one is not", () => {
    const out = formatIndexHealth(
      report({
        connectors: [
          {
            service: "jira",
            items: 50,
            embeddedItems: 20,
            embeddingCoveragePercent: 40,
            lastSyncMs: NOW - 12 * DAY_MS,
            staleDays: 12,
            stale: true,
            staleReason: "threshold_exceeded",
          },
          {
            service: "github",
            items: 50,
            embeddedItems: 50,
            embeddingCoveragePercent: 100,
            lastSyncMs: NOW - 3_600_000,
            staleDays: 0,
            stale: false,
            staleReason: null,
          },
        ],
      }),
      { nowMs: NOW, noColor: true },
    );
    const jira = out.split("\n").find((l) => l.includes("jira")) ?? "";
    const github = out.split("\n").find((l) => l.includes("github")) ?? "";
    expect(jira).toMatch(/stale/i);
    expect(github).not.toMatch(/stale/i);
  });

  test("a never-synced connector says 'never', not a fabricated age", () => {
    const out = formatIndexHealth(
      report({
        connectors: [
          {
            service: "slack",
            items: 10,
            embeddedItems: 0,
            embeddingCoveragePercent: 0,
            lastSyncMs: null,
            staleDays: null,
            stale: true,
            staleReason: "never_synced",
          },
        ],
      }),
      { nowMs: NOW, noColor: true },
    );
    const slack = out.split("\n").find((l) => l.includes("slack")) ?? "";
    expect(slack).toMatch(/never/i);
    // A null age must not render as "0d ago" — that would claim it synced moments ago.
    expect(slack).not.toMatch(/\b0d\b|\bNaN\b|\bnull\b|\bundefined\b/);
  });

  test("a connector with no sync record is distinguished from one that never synced", () => {
    // Different causes, different fixes: "never synced" means authenticated but not yet run;
    // "no sync record" means nothing has ever registered the connector at all.
    const out = formatIndexHealth(
      report({
        connectors: [
          {
            service: "orphan",
            items: 10,
            embeddedItems: 0,
            embeddingCoveragePercent: 0,
            lastSyncMs: null,
            staleDays: null,
            stale: true,
            staleReason: "no_sync_record",
          },
        ],
      }),
      { nowMs: NOW, noColor: true },
    );
    expect(out).toMatch(/no sync record/i);
  });
});

describe("formatIndexHealth — sparse metadata", () => {
  test("names the type, the share affected and which fields are missing", () => {
    const out = formatIndexHealth(
      report({
        sparseTypes: [
          {
            type: "pr",
            items: 100,
            sparseItems: 40,
            missingUrl: 40,
            missingModifiedAt: 0,
            missingMetadata: 12,
            sparsePercent: 40,
          },
        ],
      }),
      { nowMs: NOW, noColor: true },
    );
    expect(out).toContain("pr");
    expect(out).toMatch(/40 of 100/);
    expect(out).toMatch(/url 40/);
    expect(out).toMatch(/metadata 12/);
    // A zero column is omitted rather than printed as noise.
    expect(out).not.toMatch(/modified_at 0\b/);
  });

  test("says so explicitly when nothing is sparse, rather than printing an empty heading", () => {
    const out = formatIndexHealth(report({ sparseTypes: [] }), { nowMs: NOW, noColor: true });
    expect(out).toMatch(/no sparse metadata|every indexed type/i);
  });
});

describe("formatIndexHealth — disclosure", () => {
  test("always states the stale threshold the report was computed against", () => {
    // Without it, "12d ago STALE" is unfalsifiable — the reader cannot tell whether the verdict
    // came from a 7-day default or a 1-day flag.
    const out = formatIndexHealth(report({ staleThresholdDays: 14 }), {
      nowMs: NOW,
      noColor: true,
    });
    expect(out).toMatch(/14 days/);
  });

  test("NO_COLOR output carries no ANSI escapes", () => {
    const out = formatIndexHealth(report({ confidence: 20 }), { nowMs: NOW, noColor: true });
    expect(out).not.toMatch(new RegExp(String.fromCodePoint(27)));
  });

  test("a TTY without NO_COLOR does colour the low-confidence score", () => {
    const out = formatIndexHealth(report({ confidence: 20 }), { nowMs: NOW, noColor: false });
    expect(out).toMatch(new RegExp(String.fromCodePoint(27)));
  });
});

describe("formatIndexHealth — empty connectors are hidden by default", () => {
  // Found by running against a live gateway, not by any unit test: the gateway registers a
  // `sync_state` row for EVERY known connector at boot, so a real install renders 97 rows of which
  // ~90 hold zero items and have never been configured. The six that matter are buried.
  const withEmpties = (n: number): IndexHealthReport =>
    report({
      totalItems: 10,
      connectors: [
        {
          service: "github",
          items: 10,
          embeddedItems: 10,
          embeddingCoveragePercent: 100,
          lastSyncMs: NOW - 3_600_000,
          staleDays: 0,
          stale: false,
          staleReason: null,
        },
        ...Array.from({ length: n }, (_, i) => ({
          service: `empty${i}`,
          items: 0,
          embeddedItems: 0,
          embeddingCoveragePercent: 0,
          lastSyncMs: null,
          staleDays: null,
          stale: true,
          staleReason: "never_synced" as const,
        })),
      ],
    });

  test("a connector with zero items is omitted from the default render", () => {
    const out = formatIndexHealth(withEmpties(3), { nowMs: NOW, noColor: true });
    expect(out).toContain("github");
    expect(out).not.toContain("empty0");
  });

  test("the omission is DISCLOSED with a count, never silent", () => {
    // Hiding rows without saying so would make the table lie by omission — a user looking for a
    // connector they configured would conclude it is not indexed at all.
    const out = formatIndexHealth(withEmpties(90), { nowMs: NOW, noColor: true });
    expect(out).toMatch(/90 connector/);
    expect(out).toMatch(/--all/);
  });

  test("--all shows them", () => {
    const out = formatIndexHealth(withEmpties(3), { nowMs: NOW, noColor: true, all: true });
    expect(out).toContain("empty0");
    expect(out).toContain("empty2");
  });

  test("no disclosure line when there is nothing to hide", () => {
    const out = formatIndexHealth(withEmpties(0), { nowMs: NOW, noColor: true });
    expect(out).not.toMatch(/--all/);
  });

  test("the connector COUNT in the summary still counts every connector", () => {
    // The count is a fact about the install, not about what this render chose to print.
    const out = formatIndexHealth(withEmpties(90), { nowMs: NOW, noColor: true });
    expect(out).toMatch(/91 connector\(s\)/);
  });
});

describe("formatIndexHealth — the omission disclosure cannot be lost", () => {
  test("discloses omitted connectors even when EVERY connector is empty", () => {
    // Caught in review: the disclosure lived inside `if (shown.length > 0)`, so an install where
    // every registered connector holds zero items printed no connector section AND no disclosure —
    // silently hiding all 97 rows. That is precisely the "hiding without saying so" failure the
    // `--all` disclosure exists to prevent, and the original test missed it because every fixture
    // had at least one non-empty connector.
    const out = formatIndexHealth(
      report({
        totalItems: 0,
        connectors: [
          {
            service: "empty0",
            items: 0,
            embeddedItems: 0,
            embeddingCoveragePercent: 0,
            lastSyncMs: null,
            staleDays: null,
            stale: true,
            staleReason: "never_synced",
          },
          {
            service: "empty1",
            items: 0,
            embeddedItems: 0,
            embeddingCoveragePercent: 0,
            lastSyncMs: null,
            staleDays: null,
            stale: true,
            staleReason: "never_synced",
          },
        ],
        confidence: null,
        confidenceUnavailableReason: "empty_index",
      }),
      { nowMs: NOW, noColor: true },
    );
    expect(out).toMatch(/2 connector/);
    expect(out).toMatch(/--all/);
  });
});
