import { describe, expect, test } from "bun:test";
import { contractViolations, requiredPhrases } from "./brief-contract.ts";
import { oncallDisclosures, standupDisclosures } from "./brief-disclosures.ts";
import type { SynthInput } from "./brief-kinds.ts";
import type { OncallBrief } from "./oncall-types.ts";
import { renderOncall, renderStandup } from "./render.ts";
import type { StandupBrief } from "./standup-types.ts";

/**
 * The I31 guard for the two preamble-disclosure kinds `brief-contract.test.ts` never routes
 * through `requiredPhrases` — `oncall` and `standup` — plus the glossary arm's empty-term case and
 * the exhaustiveness backstop. For the two preamble kinds the property is the one the guard rests
 * on: what it REQUIRES is exactly what the renderer EMITTED, derived from the brief's own fields,
 * so the renderer's own output passes and a rewrite that drops a caveat does not.
 */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function oncallBrief(over: Partial<OncallBrief> = {}): OncallBrief {
  return {
    kind: "oncall",
    agentVersion: 1,
    generatedAt: NOW,
    latencyMs: 9,
    gaps: [],
    query: { sinceMs: NOW - DAY, nowMs: NOW },
    selection: "auto_assigned",
    incident: {
      id: "pagerduty:inc-1",
      title: "Checkout 500s",
      url: null,
      status: "triggered",
      severity: "P1",
      urgency: "high",
      openedAtMs: NOW - 2 * HOUR,
      pagerdutyServiceId: "PSERVICE1",
      assigneeEmails: ["ada@example.com"],
    },
    otherActiveIncidents: [],
    syncFreshness: { lastSyncMs: NOW - 5 * 60_000, ageMs: 5 * 60_000, reason: null },
    binding: { nimbusServiceId: "checkout", pagerdutyServiceId: "PSERVICE1" },
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

const DEPLOYMENT: NonNullable<OncallBrief["deployment"]> = {
  id: "dep-1",
  title: "Deploy prod",
  url: null,
  provider: "github-actions",
  environment: "prod",
  sha: "abc123",
  ref: "refs/heads/main",
  startedAtMs: NOW - 3 * HOUR,
  finishedAtMs: NOW - 3 * HOUR + 60_000,
  conclusion: "success",
  workflowUrl: null,
  ciRunExternalId: "run-9",
};

function standupBrief(over: Partial<StandupBrief> = {}): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: NOW,
    latencyMs: 5,
    gaps: [],
    query: { sinceMs: NOW - DAY, nowMs: NOW },
    identity: {
      personId: "person-me",
      source: "git",
      displayName: "Ada Lovelace",
      personRowExists: true,
    },
    prsActive: [],
    prsMerged: [],
    reviews: [],
    ticketsOpened: [],
    incidents: [],
    messages: [],
    counts: { prsActive: 0, prsMerged: 0, reviews: 0, ticketsOpened: 0, incidents: 0, messages: 0 },
    threadCount: 0,
    approximateCount: 0,
    nonGithubMergedPrs: 0,
    truncatedCount: 0,
    ...over,
  };
}

describe("requiredPhrases — oncall", () => {
  test("every requirement is derived from the brief's own fields", () => {
    const brief = oncallBrief({
      deployment: DEPLOYMENT,
      otherActiveIncidents: [
        { id: "pagerduty:inc-2", title: "Queue lag", openedAtMs: NOW - HOUR },
        { id: "pagerduty:inc-3", title: "Disk full", openedAtMs: null },
      ],
      truncatedCount: 3,
    });

    expect(requiredPhrases(brief)).toEqual(
      oncallDisclosures({
        syncAgeMs: 5 * 60_000,
        syncUnknown: false,
        hasDeployment: true,
        otherActiveCount: 2,
        assigneeScoped: true,
        truncatedCount: 3,
      }),
    );
    expect(requiredPhrases(brief)).toHaveLength(4);
  });

  test("an unknown sync state and a by-service selection pick the matching sentences", () => {
    const brief = oncallBrief({
      selection: "auto_service",
      syncFreshness: { lastSyncMs: null, ageMs: null, reason: "never_synced" },
      otherActiveIncidents: [{ id: "pagerduty:inc-2", title: "Queue lag", openedAtMs: null }],
    });

    const lines = requiredPhrases(brief).map((d) => d.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("has no record of one having completed");
    expect(lines[1]).toContain("on this service");
    expect(lines[1]).not.toContain("assigned to you");
  });

  test("the renderer's own output satisfies the guard; dropping the sync caveat does not", () => {
    const brief = oncallBrief({ deployment: DEPLOYMENT });
    const md = renderOncall(brief);
    expect(contractViolations(brief, md)).toEqual([]);

    const rewritten = md.replaceAll("may have been closed", "is still open");
    expect(contractViolations(brief, rewritten)).toEqual([
      'the brief preamble dropped required phrase "may have been closed"',
    ]);
  });
});

describe("requiredPhrases — standup", () => {
  test("every requirement is derived from the brief's own counters", () => {
    const brief = standupBrief({ approximateCount: 2, truncatedCount: 1 });
    expect(requiredPhrases(brief)).toEqual(
      standupDisclosures({ approximateCount: 2, truncatedCount: 1 }),
    );
    // The two conditional sentences are required only when they applied.
    expect(requiredPhrases(standupBrief()).length).toBeLessThan(requiredPhrases(brief).length);
  });

  test("the renderer's own output satisfies the guard; dropping the window bound does not", () => {
    const brief = standupBrief();
    const md = renderStandup(brief);
    expect(contractViolations(brief, md)).toEqual([]);

    const rewritten = md.replaceAll("cover only this window", "cover recent work");
    expect(contractViolations(brief, rewritten)).toEqual([
      'the brief preamble dropped required phrase "cover only this window"',
    ]);
  });
});

describe("requiredPhrases — glossary term mode", () => {
  test("a resolved term with no entry requires nothing", () => {
    const brief = { kind: "glossary", mode: "term", entries: [] } as unknown as SynthInput;
    expect(requiredPhrases(brief)).toEqual([]);
  });

  test("a resolved, authored term requires its provenance sentence (positive control)", () => {
    const brief = {
      kind: "glossary",
      mode: "term",
      entries: [{ term: "CDR", definitionSource: "manual" }],
    } as unknown as SynthInput;
    const required = requiredPhrases(brief);
    expect(required).toHaveLength(1);
    expect(required[0]?.anchors).toEqual(["not derived from indexed sources"]);
  });
});

describe("requiredPhrases — exhaustiveness backstop", () => {
  test("an unrecognised kind throws rather than silently requiring nothing", () => {
    const bogus = { kind: "horoscope" } as unknown as SynthInput;
    expect(() => requiredPhrases(bogus)).toThrow("synthesize: unhandled brief kind horoscope");
    expect(() => contractViolations(bogus, "# anything")).toThrow("unhandled brief kind");
  });
});
