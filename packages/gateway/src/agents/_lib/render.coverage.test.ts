/**
 * render.coverage.test.ts — the arms of render.ts the per-brief render tests leave open: an
 * impact brief with empty categories, the why subject lines without a number / line, the glossary
 * miss and synonym modes, ownership's truncation / no-owner / unresolved-identity rows, the
 * decisions entry's optional lines, negotiate's stats-coverage and directories-only ownership,
 * citation hrefs that cannot be rendered safely, and oncall's CI run, unmapped service, runner-up,
 * diffstat and prior-incident fallbacks.
 */
import { describe, expect, test } from "bun:test";

import type { DecisionsBrief, DecisionsEntry } from "./decisions-types.ts";
import type { ImpactBrief } from "./findings.ts";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import type { OncallBrief } from "./oncall-types.ts";
import type { OwnershipBrief, OwnershipTargetView } from "./ownership-types.ts";
import {
  renderDecisions,
  renderGlossary,
  renderImpact,
  renderNegotiate,
  renderOncall,
  renderOwnership,
  renderWhy,
} from "./render.ts";
import type { WhyBrief } from "./why-types.ts";

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const DAY = 86_400_000;

describe("renderImpact", () => {
  test("a category with no rows gets no heading at all", () => {
    const brief: ImpactBrief = {
      kind: "impact",
      agentVersion: 1,
      generatedAt: T0,
      latencyMs: 100,
      gaps: [],
      query: { fileOrPrUrl: "src/a.ts" },
      startEntityId: "graph:code_symbol#1",
      affected: [
        {
          category: "pipeline",
          affectedItemId: "github:acme/a#actions/runs/1",
          affectedTitle: "CI run 1",
          serviceId: "github",
          hops: 2,
          pathSummary: "repo → triggers → ci_run",
        },
      ],
    };
    const md = renderImpact(brief);
    expect(md).toContain("## Pipelines\n\n- **CI run 1** (`github`, 2 hops)");
    for (const absent of ["## Services", "## Downstream Repos", "## Dashboards", "## Oncall"]) {
      expect(md).not.toContain(absent);
    }
    expect(md).not.toContain("_no downstream impact resolved_");
  });
});

function whyBrief(over: Partial<WhyBrief>): WhyBrief {
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: T0,
    latencyMs: 500,
    gaps: [],
    query: { ref: "src/a.ts", line: null },
    subject: null,
    findings: [],
    ...over,
  };
}

describe("renderWhy subject line", () => {
  test("a resolved change subject with no number renders the repo alone", () => {
    const md = renderWhy(
      whyBrief({
        query: { ref: "https://example.test/acme/app/merge/9", line: null },
        changeSubject: {
          itemId: "gitlab:acme/app!9",
          entityId: "e9",
          repo: "acme/app",
          number: null,
          url: "https://example.test/acme/app/merge/9",
          title: "Retry budget",
          modifiedAt: null,
        },
      }),
    );
    expect(md).toContain("`acme/app` — Retry budget");
    expect(md).not.toContain("`acme/app#");
    expect(md).toContain("authorship needs a line");
  });

  test("a resolved change subject WITH a number appends it", () => {
    const md = renderWhy(
      whyBrief({
        changeSubject: {
          itemId: "github:acme/app#12",
          entityId: "e12",
          repo: "acme/app",
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          title: "Retry budget",
          modifiedAt: null,
        },
      }),
    );
    expect(md).toContain("`acme/app#12` — Retry budget");
  });

  test("a file subject with no line number carries no `:line` suffix", () => {
    const md = renderWhy(
      whyBrief({
        subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: null, symbol: null },
      }),
    );
    expect(md).toContain("`src/a.ts` in `/repo`");
    expect(md).not.toContain("`src/a.ts:");
  });
});

function glossaryEntry(over: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    term: "CDR",
    definition: "Change data record.",
    definitionSource: "llm",
    docFreq: 4,
    score: 0.7,
    serviceSpread: 2,
    firstSeenAt: T0,
    lastSeenAt: T0 + 3 * DAY,
    topSources: [],
    synonyms: [],
    nearMisses: [],
    ...over,
  };
}

function glossaryBrief(over: Partial<GlossaryBrief>): GlossaryBrief {
  return {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: T0,
    latencyMs: 800,
    gaps: [],
    query: { term: "cdr", limit: 10 },
    mode: "term",
    entries: [],
    matchedVia: null,
    suggestions: [],
    stats: { total: 0, pending: 0, vetoed: 0, manual: 0, lastPassAt: null, truncatedSources: 0 },
    ...over,
  };
}

describe("renderGlossary", () => {
  test("miss mode names the term and offers suggestions when there are any", () => {
    const md = renderGlossary(
      glossaryBrief({
        mode: "miss",
        query: { term: "cdrx", limit: 10 },
        suggestions: ["cdr", "cdn"],
      }),
    );
    expect(md).toContain("_No glossary entry for `cdrx`._");
    expect(md).toContain("**Did you mean:** cdr, cdn");
    expect(md).not.toContain("## Terms");
  });

  test("miss mode with no suggestions offers none, and a null term renders empty", () => {
    const md = renderGlossary(
      glossaryBrief({ mode: "miss", query: { term: null, limit: 10 }, suggestions: [] }),
    );
    expect(md).toContain("_No glossary entry for ``._");
    expect(md).not.toContain("Did you mean");
  });

  test("term mode: synonym match, missing definition, aliases, near-misses and both source shapes", () => {
    const md = renderGlossary(
      glossaryBrief({
        matchedVia: "synonym",
        entries: [
          glossaryEntry({
            definition: null,
            definitionSource: null,
            synonyms: ["change record"],
            nearMisses: ["CDN"],
            topSources: [
              {
                itemId: "github:acme/a#1",
                title: "Design doc",
                url: "https://github.com/acme/a/pull/1",
                service: "github",
                modifiedAt: T0,
              },
              {
                itemId: "slack:C1/1",
                title: "standup thread",
                url: null,
                service: "slack",
                modifiedAt: T0 + DAY,
              },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("## CDR");
    expect(md).toContain('_Matched via synonym "cdr"._');
    expect(md).toContain("_No definition yet._");
    expect(md).toContain("- Seen in 4 item(s) across 2 service(s)");
    expect(md).toContain("- First seen 2023-11-14, last seen 2023-11-17");
    expect(md).toContain("- Also known as: change record");
    expect(md).toContain("- Easily confused with: CDN");
    expect(md).toContain("### Sources");
    expect(md).toContain("- [Design doc](https://github.com/acme/a/pull/1) — github, 2023-11-14");
    expect(md).toContain("- standup thread — slack, 2023-11-15");
    // A null definitionSource carries no provenance line.
    expect(md).not.toContain("no LLM configured");
    expect(md).not.toContain("not derived from indexed sources");
  });

  test("an exact match states no synonym line, and a null query term renders empty in one", () => {
    const exact = renderGlossary(
      glossaryBrief({ matchedVia: "exact", entries: [glossaryEntry()] }),
    );
    expect(exact).not.toContain("Matched via synonym");
    expect(exact).not.toContain("### Sources");
    const nullTerm = renderGlossary(
      glossaryBrief({
        matchedVia: "synonym",
        query: { term: null, limit: 10 },
        entries: [glossaryEntry()],
      }),
    );
    expect(nullTerm).toContain('_Matched via synonym ""._');
  });

  test("term mode with no entry renders the title and footer only", () => {
    const md = renderGlossary(glossaryBrief({ entries: [] }));
    expect(md).toBe("# Glossary\n_generated in 0.8 s_");
  });
});

function ownershipTarget(over: Partial<OwnershipTargetView> = {}): OwnershipTargetView {
  return {
    kind: "source_file",
    displayPath: "src/a.ts",
    owners: [],
    ownerCount: null,
    ownersAboveFloor: null,
    truncated: null,
    ...over,
  };
}

function ownershipBrief(over: Partial<OwnershipBrief>): OwnershipBrief {
  return {
    kind: "ownership",
    agentVersion: 1,
    generatedAt: T0,
    latencyMs: 300,
    gaps: [],
    query: { path: "src/a.ts", service: null, itemUrl: null },
    target: null,
    parentDirectory: null,
    service: null,
    coverage: {
      lastPassAt: T0,
      lastDurationMs: 10,
      rootsTotal: 1,
      rootsCovered: 1,
      rootsWithRemote: 1,
      filesCovered: 5,
      filesExcluded: 0,
      servicesBound: 1,
      ownersEmitted: 3,
      entitiesReaped: 0,
    },
    ...over,
  };
}

describe("renderOwnership", () => {
  test("a truncated owner list says how many it shows; an unresolved identity is marked", () => {
    const md = renderOwnership(
      ownershipBrief({
        target: ownershipTarget({
          owners: [
            { externalId: "person:ada", label: "Ada", share: 0.6, resolved: true },
            {
              externalId: "git:bob@example.com",
              label: "bob@example.com",
              share: 0.25,
              resolved: false,
            },
          ],
          ownerCount: 9,
          ownersAboveFloor: 4,
          truncated: true,
        }),
        service: { id: "checkout" },
      }),
    );
    expect(md).toContain("(4 of 9 contributor(s) clear the share floor; showing top 2)");
    expect(md).toMatch(/1\. Ada\s+60\.0%\n/);
    expect(md).toMatch(/2\. bob@example\.com\s+25\.0% {2}\(unresolved git identity\)/);
    expect(md).not.toMatch(/Ada\s+60\.0% {2}\(unresolved/);
    expect(md).toContain("### Rolls up to service: checkout");
  });

  test("no owners with a recorded zero floor result reads as 'none recorded', not 'none cleared'", () => {
    for (const ownerCount of [0, null]) {
      const md = renderOwnership(
        ownershipBrief({
          target: ownershipTarget({ ownerCount, ownersAboveFloor: 0 }),
        }),
      );
      expect(md).toContain("### Owners — src/a.ts\n\n_No owners recorded._");
      expect(md).not.toContain("_No owners cleared the share floor._");
      expect(md).not.toContain("not recorded for this path");
    }
  });
});

function decisionsEntry(over: Partial<DecisionsEntry> = {}): DecisionsEntry {
  return {
    id: "d1",
    statement: "Adopt Postgres",
    rationale: null,
    alternatives: [],
    confidence: 0.81,
    decidedAt: T0,
    hasAdr: true,
    extractionSource: "llm",
    evidence: [],
    explain: [],
    matchedVia: null,
    ...over,
  };
}

function decisionsBrief(entries: DecisionsEntry[], explain: boolean): DecisionsBrief {
  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: T0 + 10 * DAY,
    latencyMs: 20,
    gaps: [],
    query: { sinceMs: T0, service: null, minConfidence: 0, explain },
    entries,
    stats: { total: 1, pending: 0, extracted: 1, vetoed: 0, lastPassAt: null, truncatedSources: 0 },
  };
}

describe("renderDecisions", () => {
  test("an ADR-backed entry with no rationale, alternatives or explain terms is one line", () => {
    const md = renderDecisions(decisionsBrief([decisionsEntry()], true));
    expect(md).toContain("## Decisions · 10d · 1 found");
    expect(md).toContain("0.81  Adopt Postgres  2023-11-14");
    for (const absent of [
      "no ADR found",
      "rationale",
      "alternatives",
      "evidence",
      "confidence breakdown",
    ]) {
      expect(md).not.toContain(absent);
    }
  });

  test("explain terms render only when the query asked for them", () => {
    const entry = decisionsEntry({
      explain: [{ term: "corroboration", value: 0.4, detail: "2 sources" }],
    });
    const asked = renderDecisions(decisionsBrief([entry], true));
    expect(asked).toContain("confidence breakdown:");
    expect(asked).toContain("- corroboration (0.40): 2 sources");
    const notAsked = renderDecisions(decisionsBrief([entry], false));
    expect(notAsked).not.toContain("confidence breakdown");
  });
});

function negotiateBrief(over: Partial<NegotiateBrief> = {}): NegotiateBrief {
  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: T0 + 90 * DAY,
    latencyMs: 700,
    gaps: [],
    query: { sinceMs: T0 },
    subject: { personId: "person:me", source: "override", displayName: "Me", isOther: false },
    sources: {
      personalDocsConfigured: false,
      personalDocsRecognised: [],
      personalDocsUnrecognised: [],
      personalDocsConfigKey: "[negotiate] personal_sources",
    },
    unavailableEvidence: ["on-call shifts"],
    authoredPrs: null,
    reviewedPrs: null,
    incidents: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
    ...over,
  };
}

const NO_EVIDENCE = { refs: [], total: 0 } as const;

describe("renderNegotiate", () => {
  test("enriched PR stats print a coverage suffix only when coverage is partial", () => {
    const partial = renderNegotiate(
      negotiateBrief({
        authoredPrs: {
          count: 5,
          merged: 4,
          mergedCoverage: { covered: 4, total: 5 },
          evidence: NO_EVIDENCE,
          stats: { additions: 120, deletions: 30, changedFiles: 9 },
          statsCoverage: { covered: 3, total: 5 },
        },
      }),
    );
    expect(partial).toContain("5 PR(s), 4 merged (merge status known for 4/5)");
    expect(partial).toContain("- stats: +120 / -30 across 9 file(s) (stats coverage 3/5)");
    const full = renderNegotiate(
      negotiateBrief({
        authoredPrs: {
          count: 2,
          merged: 2,
          mergedCoverage: { covered: 2, total: 2 },
          evidence: NO_EVIDENCE,
          stats: { additions: 7, deletions: 1, changedFiles: 2 },
          statsCoverage: { covered: 2, total: 2 },
        },
      }),
    );
    expect(full).toContain("- stats: +7 / -1 across 2 file(s)\n");
    expect(full).not.toContain("stats coverage");
  });

  test("directories-only ownership lists no services line and states when the pass last ran", () => {
    const md = renderNegotiate(
      negotiateBrief({
        ownership: {
          services: [],
          directories: ["src/billing"],
          lastPassAt: T0,
          truncated: false,
          unmappedIdentitiesInIndex: 0,
        },
      }),
    );
    expect(md).toContain("- directories: src/billing");
    expect(md).not.toContain("- services:");
    expect(md).not.toContain("- no recorded ownership");
    expect(md).toContain(`- ownership pass last ran ${new Date(T0).toISOString()}`);
    expect(md).not.toContain("never run");
  });

  test("a citation url that is unparsable or not http(s) renders as plain text", () => {
    const md = renderNegotiate(
      negotiateBrief({
        tickets: {
          opened: 3,
          closedByAuthoredPr: 0,
          evidence: {
            refs: [
              { title: "Broken link", url: "not a url" },
              { title: "Script link", url: "javascript:alert(1)" },
              { title: "Paren (link)", url: "https://jira.example/browse/A-1?x=(y)" },
            ],
            total: 3,
          },
        },
      }),
    );
    expect(md).toContain("  - Broken link\n");
    expect(md).not.toContain("](not a url)");
    expect(md).toContain("  - Script link\n");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("  - [Paren (link)](https://jira.example/browse/A-1?x=%28y%29)");
  });
});

function oncallBrief(over: Partial<OncallBrief> = {}): OncallBrief {
  const now = T0 + 30 * DAY;
  return {
    kind: "oncall",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: now - DAY, nowMs: now },
    selection: "auto_service",
    incident: {
      id: "pagerduty:inc-1",
      title: "Checkout 500s",
      url: null,
      status: "triggered",
      severity: null,
      urgency: null,
      openedAtMs: now - 3_600_000,
      pagerdutyServiceId: null,
      assigneeEmails: [],
    },
    otherActiveIncidents: [],
    syncFreshness: { lastSyncMs: now, ageMs: 0, reason: null },
    binding: { nimbusServiceId: null, pagerdutyServiceId: null },
    deployment: null,
    change: null,
    ciRun: null,
    messages: [],
    priorIncidents: [],
    counts: { messages: 0, priorIncidents: 0 },
    truncatedCount: 0,
    ...over,
  };
}

describe("renderOncall", () => {
  test("a CI run renders its linked title, result and time", () => {
    const md = renderOncall(
      oncallBrief({
        ciRun: {
          id: "ci-9",
          title: "deploy pipeline #9",
          url: "https://ci.example/runs/9",
          service: "github_actions",
          conclusion: "failure",
          atMs: T0,
        },
      }),
    );
    expect(md).toContain(
      "## CI\n\n- **Run:** [deploy pipeline #9](https://ci.example/runs/9)\n- **Result:** failure\n" +
        "- **At:** 2023-11-14 22:13Z",
    );
  });

  test("a CI run with no conclusion and no url says the result was not recorded", () => {
    const md = renderOncall(
      oncallBrief({
        ciRun: {
          id: "ci-10",
          title: "nightly",
          url: null,
          service: "jenkins",
          conclusion: null,
          atMs: T0,
        },
      }),
    );
    expect(md).toContain("- **Run:** nightly\n- **Result:** _not recorded_");
  });

  test("an incident with no service binding at all says not recorded, never unmapped", () => {
    const md = renderOncall(oncallBrief());
    expect(md).toContain("- **Service:** _not recorded_");
    expect(md).not.toContain("_unmapped");
  });

  test("a runner-up with no open time carries no `(opened …)` clause", () => {
    const md = renderOncall(
      oncallBrief({
        otherActiveIncidents: [{ id: "pagerduty:inc-2", title: "Queue lag", openedAtMs: null }],
      }),
    );
    expect(md).toContain("Other active incidents on this service:");
    expect(md).toContain("- `pagerduty:inc-2` — Queue lag\n");
    expect(md).not.toContain("Queue lag (opened");
  });

  test("a partly-recorded diffstat counts the missing figures as zero; one file is singular", () => {
    const md = renderOncall(
      oncallBrief({
        change: {
          id: "pr-1",
          title: "Fix pool",
          url: null,
          service: "github",
          mergedAtMs: null,
          additions: null,
          deletions: 5,
          changedFiles: 1,
        },
      }),
    );
    expect(md).toContain("- **Merged:** _not recorded_");
    expect(md).toContain("- **Size:** +0 −5 across 1 file\n");
    const noFiles = renderOncall(
      oncallBrief({
        change: {
          id: "pr-2",
          title: "Bump",
          url: null,
          service: "github",
          mergedAtMs: T0,
          additions: 3,
          deletions: null,
          changedFiles: null,
        },
      }),
    );
    expect(noFiles).toContain("- **Size:** +3 −0 across 0 files");
  });

  test("a prior incident with no open time and no recorded resolver", () => {
    const md = renderOncall(
      oncallBrief({
        priorIncidents: [
          {
            id: "pagerduty:old-1",
            title: "Earlier 500s",
            url: null,
            openedAtMs: null,
            resolvedAtMs: T0,
            resolvedByEmail: null,
          },
        ],
        counts: { messages: 0, priorIncidents: 1 },
      }),
    );
    expect(md).toContain("- Earlier 500s — opened date unknown, closed 2023-11-14 22:13Z");
    expect(md).not.toContain("closed 2023-11-14 22:13Z by");
  });
});
