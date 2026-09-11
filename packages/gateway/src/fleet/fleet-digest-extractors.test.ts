import { describe, expect, test } from "bun:test";
import { compareSummaries } from "./fleet-digest.ts";
import { summarizeBrief } from "./fleet-digest-extractors.ts";

const base = { agentVersion: 1, generatedAt: 0, latencyMs: 0, gaps: [] };

describe("ghost extractor keys on IDENTITY only", () => {
  test("a rank change does NOT change the key", () => {
    const mk = (rank: string) =>
      JSON.stringify({
        ...base,
        kind: "ghost",
        query: { file: "a.ts" },
        startEntityId: null,
        findings: [{ peerId: "p1", expert: null, rank, context: [], suggestedContact: "" }],
      });
    const before = summarizeBrief("agents.ghost", mk("medium"));
    const after = summarizeBrief("agents.ghost", mk("high"));
    expect(before?.keys).toEqual(["p1"]);
    expect(after?.keys).toEqual(["p1"]);
    expect(before?.metrics["rank_medium"]).toBe(1);
    expect(after?.metrics["rank_high"]).toBe(1);
  });

  // I2 red-prove: a band shift must show up as what it is (spec § 4.4's worked example) — a
  // count moving from 1 to 0 — not as a fabricated schema change. `bandCounts` today only emits
  // `prefix_<band>` for bands that actually occur, so a band that drops to zero occurrences
  // vanishes from the metrics object entirely and `compareSummaries` reports it one-sided
  // ("no longer reported") instead of a real 1 -> 0 delta.
  test("a peer moving high<->medium reports rank_medium as 1 -> 0, not (no longer reported)", () => {
    const mk = (ranks: string[]) =>
      JSON.stringify({
        ...base,
        kind: "ghost",
        query: { file: "a.ts" },
        startEntityId: null,
        findings: ranks.map((rank, i) => ({
          peerId: `p${String(i)}`,
          expert: null,
          rank,
          context: [],
          suggestedContact: "",
        })),
      });
    const before = summarizeBrief("agents.ghost", mk(["high", "medium"]));
    const after = summarizeBrief("agents.ghost", mk(["high", "high"]));
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) throw new Error("unreachable");
    const cmp = compareSummaries(before, after, 1);
    expect(cmp.metrics["rank_medium"]).toEqual({ before: 1, after: 0, delta: -1 });
  });
});

describe("janitor encodes booleans as KEYS, not metrics", () => {
  test("idle true adds the key; idle false omits it", () => {
    const mk = (idle: boolean) =>
      JSON.stringify({
        ...base,
        kind: "janitor",
        query: { resourceRef: "r", idleDays: 30 },
        idle,
        proposalSuppressed: false,
        cleanupAction: null,
        peersClear: 2,
        peersTouched: [{ peerId: "p1", who: null, lastSeenDaysAgo: 3 }],
      });
    expect(summarizeBrief("agents.janitor", mk(true))?.keys).toEqual(["idle", "peer:p1"]);
    expect(summarizeBrief("agents.janitor", mk(false))?.keys).toEqual(["peer:p1"]);
    expect(summarizeBrief("agents.janitor", mk(true))?.metrics["idle"]).toBeUndefined();
  });

  test("proposalSuppressed is keyed too, never metric-encoded", () => {
    const mk = (proposalSuppressed: boolean) =>
      JSON.stringify({
        ...base,
        kind: "janitor",
        query: { resourceRef: "r", idleDays: 30 },
        idle: false,
        proposalSuppressed,
        cleanupAction: null,
        peersClear: 0,
        peersTouched: [],
      });
    expect(summarizeBrief("agents.janitor", mk(true))?.keys).toEqual(["proposal_suppressed"]);
    expect(summarizeBrief("agents.janitor", mk(false))?.keys).toEqual([]);
    expect(
      summarizeBrief("agents.janitor", mk(true))?.metrics["proposal_suppressed"],
    ).toBeUndefined();
  });
});

describe("catchup and expert", () => {
  test("catchup keys on service:item and counts involvement", () => {
    const json = JSON.stringify({
      ...base,
      kind: "catchup",
      query: { sinceMs: 0 },
      selfPersonId: null,
      involvement: {
        ownedServices: ["s1"],
        activeRepos: ["r1", "r2"],
        incidentServices: [],
        collaboratorPersonIds: ["p1"],
      },
      sections: [
        {
          serviceId: "github",
          totalItemsInWindow: 5,
          items: [
            { itemId: "i1", title: "t", modifiedAt: 0, relevanceScore: 1, relevanceReasons: [] },
          ],
        },
      ],
    });
    const s = summarizeBrief("agents.catchup", json);
    expect(s?.keys).toEqual(["github:i1"]);
    expect(s?.metrics).toMatchObject({
      items_total: 1,
      sections: 1,
      active_repos: 2,
      collaborators: 1,
    });
  });

  test("expert keys on personId and counts confidence bands", () => {
    const json = JSON.stringify({
      ...base,
      kind: "expert",
      query: { topicOrFile: "auth" },
      ranked: [
        { personId: "p2", displayName: "B", evidence: [], score: 1, confidence: "high" },
        { personId: "p1", displayName: "A", evidence: [{}, {}], score: 2, confidence: "low" },
      ],
    });
    const s = summarizeBrief("agents.expert", json);
    expect(s?.keys).toEqual(["p1", "p2"]); // sorted by codeUnitCompare
    expect(s?.metrics).toMatchObject({
      experts: 2,
      evidence_total: 2,
      confidence_high: 1,
      confidence_low: 1,
    });
  });
});

describe("malformed input never throws", () => {
  test.each([
    ["not json at all", "{{{"],
    ["json of the wrong shape", JSON.stringify({ kind: "ghost" })],
    ["a bare primitive", JSON.stringify(7)],
    ["null", JSON.stringify(null)],
  ])("%s yields undefined", (_label, json) => {
    expect(summarizeBrief("agents.ghost", json)).toBeUndefined();
  });

  test("an unknown agent method yields undefined without parsing", () => {
    expect(summarizeBrief("agents.nope", "{}")).toBeUndefined();
    expect(summarizeBrief("constructor", "{}")).toBeUndefined();
  });

  test("a guard-passing brief with a malformed nested item yields undefined, not a throw", () => {
    // The SDK guards check that `findings` is an ARRAY, not the shape of its items, so this
    // legacy-shaped row passes isGhostBrief and then blows up inside the extractor.
    const json = JSON.stringify({
      ...base,
      kind: "ghost",
      query: { file: "a.ts" },
      startEntityId: null,
      findings: [{ peerId: "p1", rank: "high" }], // no `context`
    });
    expect(() => summarizeBrief("agents.ghost", json)).not.toThrow();
    expect(summarizeBrief("agents.ghost", json)).toBeUndefined();
  });

  // Every non-ghost extractor's other tests above only ever feed it a WELL-FORMED brief of its
  // own kind, so the guard's "this is not my kind" arm was exercised only for ghost. Each of
  // these feeds the mismatched-kind shape to the OTHER seven, closing the same arm for them.
  test.each([
    "agents.catchup",
    "agents.conflicts",
    "agents.expert",
    "agents.huddle",
    "agents.impact",
    "agents.janitor",
    "agents.why",
  ] as const)("%s rejects a brief of the wrong kind", (method) => {
    const json = JSON.stringify({ ...base, kind: "not-a-real-brief-kind" });
    expect(summarizeBrief(method, json)).toBeUndefined();
  });
});

describe("impact keys on the stable affectedItemId", () => {
  test("category and id compose the key; per-category counts are metrics", () => {
    const json = JSON.stringify({
      ...base,
      kind: "impact",
      query: { fileOrPrUrl: "a.ts" },
      startEntityId: null,
      affected: [
        {
          category: "service",
          affectedItemId: "svc1",
          affectedTitle: "T",
          serviceId: "s",
          hops: 1,
          pathSummary: "",
        },
        {
          category: "dashboard",
          affectedItemId: "d1",
          affectedTitle: "D",
          serviceId: "s",
          hops: 2,
          pathSummary: "",
        },
      ],
    });
    const s = summarizeBrief("agents.impact", json);
    expect(s?.keys).toEqual(["dashboard:d1", "service:svc1"]);
    expect(s?.metrics).toMatchObject({
      affected_total: 2,
      category_service: 1,
      category_dashboard: 1,
    });
  });
});

describe("why keys on lane:title deliberately", () => {
  test("a null entityId does not affect the key", () => {
    const json = JSON.stringify({
      ...base,
      kind: "why",
      query: { ref: "a.ts", line: null },
      subject: null,
      findings: [
        {
          lane: "authorship",
          title: "Alice wrote it",
          detail: "",
          url: null,
          occurredAt: null,
          entityId: null,
        },
        { lane: "ticket", title: "NIM-1", detail: "", url: null, occurredAt: null, entityId: "e1" },
      ],
    });
    const s = summarizeBrief("agents.why", json);
    expect(s?.keys).toEqual(["authorship:Alice wrote it", "ticket:NIM-1"]);
    expect(s?.metrics).toMatchObject({ findings_total: 2, lane_authorship: 1, lane_ticket: 1 });
  });

  test("STATED BOUND: retitling reads as one resolved plus one appeared", () => {
    const mk = (title: string) =>
      JSON.stringify({
        ...base,
        kind: "why",
        query: { ref: "a.ts", line: null },
        subject: null,
        findings: [
          { lane: "ticket", title, detail: "", url: null, occurredAt: null, entityId: "e1" },
        ],
      });
    expect(summarizeBrief("agents.why", mk("NIM-1"))?.keys).toEqual(["ticket:NIM-1"]);
    expect(summarizeBrief("agents.why", mk("NIM-1 renamed"))?.keys).toEqual([
      "ticket:NIM-1 renamed",
    ]);
  });
});

describe("conflicts and huddle", () => {
  test("conflicts compose peer, type, service and title", () => {
    const json = JSON.stringify({
      ...base,
      kind: "conflict",
      query: { file: "a.ts" },
      startEntityId: null,
      collisions: [
        {
          peerId: "p1",
          who: null,
          service: "github",
          collisionType: "open_pr",
          title: "PR 1",
          snippet: "",
          modifiedAt: 0,
        },
      ],
    });
    const s = summarizeBrief("agents.conflicts", json);
    expect(s?.keys).toEqual(["p1:open_pr:github:PR 1"]);
    expect(s?.metrics).toMatchObject({ collisions_total: 1, type_open_pr: 1 });
  });

  test("huddle keys each contributed item under its peer", () => {
    const item = { title: "X", snippet: "", service: "github", modifiedAt: 0 };
    const json = JSON.stringify({
      ...base,
      kind: "huddle",
      query: { sinceMs: 0 },
      contributions: [{ peerId: "p1", who: null, prs: [item], tickets: [], incidents: [] }],
    });
    const s = summarizeBrief("agents.huddle", json);
    expect(s?.keys).toEqual(["p1:pr:github:X"]);
    expect(s?.metrics).toMatchObject({ peers: 1, prs: 1, tickets: 0, incidents: 0 });
  });

  test("huddle keys all three buckets, exercising the ticket and incident literals too", () => {
    const pr = { title: "PR", snippet: "", service: "github", modifiedAt: 0 };
    const ticket = { title: "T", snippet: "", service: "jira", modifiedAt: 0 };
    const incident = { title: "I", snippet: "", service: "pagerduty", modifiedAt: 0 };
    const json = JSON.stringify({
      ...base,
      kind: "huddle",
      query: { sinceMs: 0 },
      contributions: [
        { peerId: "p1", who: null, prs: [pr], tickets: [ticket], incidents: [incident] },
      ],
    });
    const s = summarizeBrief("agents.huddle", json);
    expect(s?.keys).toEqual(["p1:incident:pagerduty:I", "p1:pr:github:PR", "p1:ticket:jira:T"]);
    expect(s?.metrics).toMatchObject({ peers: 1, prs: 1, tickets: 1, incidents: 1 });
  });

  test("STATED BOUND: conflicts retitling reads as one resolved plus one appeared", () => {
    const mk = (title: string) =>
      JSON.stringify({
        ...base,
        kind: "conflict",
        query: { file: "a.ts" },
        startEntityId: null,
        collisions: [
          {
            peerId: "p1",
            who: null,
            service: "github",
            collisionType: "open_pr",
            title,
            snippet: "",
            modifiedAt: 0,
          },
        ],
      });
    expect(summarizeBrief("agents.conflicts", mk("PR 1"))?.keys).toEqual([
      "p1:open_pr:github:PR 1",
    ]);
    expect(summarizeBrief("agents.conflicts", mk("PR 1 renamed"))?.keys).toEqual([
      "p1:open_pr:github:PR 1 renamed",
    ]);
  });
});

describe("gateway-local briefs", () => {
  test("glossary keys on term and lifts stats to metrics", () => {
    const json = JSON.stringify({
      ...base,
      kind: "glossary",
      query: { term: null, limit: 20 },
      mode: "list",
      entries: [{ term: "vault" }, { term: "brief" }],
      matchedVia: null,
      suggestions: [],
      stats: { total: 9, pending: 2, vetoed: 1, manual: 3, lastPassAt: null },
    });
    const s = summarizeBrief("agents.glossary", json);
    expect(s?.keys).toEqual(["brief", "vault"]);
    expect(s?.metrics).toMatchObject({
      total: 9,
      pending: 2,
      vetoed: 1,
      manual: 3,
      entries_listed: 2,
    });
  });

  test("ownership keys on owner externalId and is EMPTY in coverage mode", () => {
    const coverage = {
      lastPassAt: null,
      lastDurationMs: 0,
      rootsTotal: 2,
      rootsCovered: 1,
      rootsWithRemote: 1,
      filesCovered: 40,
      filesExcluded: 3,
      servicesBound: 1,
      ownersEmitted: 5,
      entitiesReaped: 0,
    };
    const withTarget = JSON.stringify({
      ...base,
      kind: "ownership",
      query: { path: "src", service: null, itemUrl: null },
      target: {
        kind: "directory",
        displayPath: "src",
        owners: [{ externalId: "git:a@b.c", label: "A", share: 1, resolved: true }],
        ownerCount: 1,
        ownersAboveFloor: 1,
        truncated: false,
      },
      parentDirectory: null,
      service: null,
      coverage,
    });
    const summaryMode = JSON.stringify({
      ...base,
      kind: "ownership",
      query: { path: null, service: null, itemUrl: null },
      target: null,
      parentDirectory: null,
      service: null,
      coverage,
    });
    expect(summarizeBrief("agents.ownership", withTarget)?.keys).toEqual(["git:a@b.c"]);
    expect(summarizeBrief("agents.ownership", summaryMode)?.keys).toEqual([]);
    expect(summarizeBrief("agents.ownership", summaryMode)?.metrics).toMatchObject({
      files_covered: 40,
      files_excluded: 3,
      roots_covered: 1,
      owners_emitted: 5,
    });
  });

  test("a malformed ownership target is a shape failure, not coverage mode", () => {
    const coverage = {
      lastPassAt: null,
      lastDurationMs: 0,
      rootsTotal: 1,
      rootsCovered: 1,
      rootsWithRemote: 0,
      filesCovered: 1,
      filesExcluded: 0,
      servicesBound: 0,
      ownersEmitted: 0,
      entitiesReaped: 0,
    };
    const withTarget = (target: unknown) =>
      JSON.stringify({
        ...base,
        kind: "ownership",
        query: { path: null, service: null, itemUrl: null },
        target,
        parentDirectory: null,
        service: null,
        coverage,
      });
    // null is the ONLY legitimate empty case.
    expect(summarizeBrief("agents.ownership", withTarget(null))?.keys).toEqual([]);
    // These are corrupted rows and must NOT be reported as "no owners".
    expect(summarizeBrief("agents.ownership", withTarget("oops"))).toBeUndefined();
    expect(summarizeBrief("agents.ownership", withTarget([]))).toBeUndefined();
    expect(summarizeBrief("agents.ownership", withTarget(7))).toBeUndefined();
  });

  test("decisions keys on entry id", () => {
    const json = JSON.stringify({
      ...base,
      kind: "decisions",
      query: { sinceMs: 0, service: null, minConfidence: 0, explain: false },
      entries: [{ id: "d1" }],
      stats: {
        total: 4,
        pending: 1,
        extracted: 3,
        vetoed: 0,
        lastPassAt: null,
        truncatedSources: 2,
      },
    });
    const s = summarizeBrief("agents.decisions", json);
    expect(s?.keys).toEqual(["d1"]);
    expect(s?.metrics).toMatchObject({ total: 4, pending: 1, extracted: 3, truncated_sources: 2 });
  });

  test("a glossary brief missing stats yields undefined, not a throw", () => {
    const json = JSON.stringify({ ...base, kind: "glossary", entries: [] });
    expect(summarizeBrief("agents.glossary", json)).toBeUndefined();
  });

  test("the changelog extractor tracks entry identities and per-category counts", () => {
    // `counts` is the TRUE pre-cap total for the window (`ChangelogCounts`'s own doc comment);
    // the entry arrays are capped at `CHANGELOG_CATEGORY_CAP` and can legitimately be shorter.
    // `mergedPrs: 53` here vs. two LISTED entries below is that gap, deliberately reproduced
    // rather than "fixed" by making the two agree — metrics must come from `counts`, never from
    // `.length`.
    const json = JSON.stringify({
      ...base,
      kind: "changelog",
      query: { sinceMs: 0, nowMs: 0, service: null },
      counts: { mergedPrs: 53, deployments: 1, incidentsOpened: 0, incidentsResolved: 2 },
      mergedPrs: [{ id: "github:1" }, { id: "github:2" }],
      deployments: [{ id: "gha:9" }],
      incidentsOpened: [],
      incidentsResolved: [{ id: "pd:1" }],
      indexTimedCount: 0,
      nonGithubMergedPrs: 0,
      truncatedCount: 51,
    });
    const s = summarizeBrief("agents.changelog", json);
    // `summary()` sorts with `codeUnitCompare` — NOT insertion order.
    expect(s?.keys).toEqual(["gha:9", "github:1", "github:2", "pd:1"]);
    expect(s?.metrics).toEqual({
      mergedPrs: 53,
      deployments: 1,
      incidentsOpened: 0,
      incidentsResolved: 2,
    });
  });

  test("a brief of the wrong kind is not summarizable", () => {
    expect(
      summarizeBrief("agents.changelog", JSON.stringify({ kind: "ownership" })),
    ).toBeUndefined();
  });

  /**
   * The four shape guards, each exercised on its own.
   *
   * `summarizeBrief` answers `undefined` for both "this JSON did not parse" and "this JSON is
   * not the shape I expect" because the caller's response to either is identical — disclose the
   * brief as not summarizable rather than drop it. That makes the guards easy to leave untested:
   * every one of them returns the same value the happy path returns on malformed input, so a
   * regression that removed one would not change any existing assertion here. Each case below
   * is a `changelog` brief that is well-formed EXCEPT for one field, so it can only fail for
   * the reason it names.
   */
  const changelogBrief = (over: Record<string, unknown>): string =>
    JSON.stringify({
      ...base,
      kind: "changelog",
      query: { sinceMs: 0, nowMs: 0, service: null },
      counts: { mergedPrs: 1, deployments: 0, incidentsOpened: 0, incidentsResolved: 0 },
      mergedPrs: [{ id: "github:1" }],
      deployments: [],
      incidentsOpened: [],
      incidentsResolved: [],
      indexTimedCount: 0,
      nonGithubMergedPrs: 0,
      truncatedCount: 0,
      ...over,
    });

  test("the control: the brief this suite mutates IS summarizable when untouched", () => {
    // Without this, a typo in `changelogBrief` would make all four guard tests below pass for
    // the wrong reason — they would be rejecting a brief that was malformed to begin with.
    expect(summarizeBrief("agents.changelog", changelogBrief({}))?.metrics).toEqual({
      mergedPrs: 1,
      deployments: 0,
      incidentsOpened: 0,
      incidentsResolved: 0,
    });
  });

  test("a missing `counts` object is not summarizable", () => {
    expect(summarizeBrief("agents.changelog", changelogBrief({ counts: null }))).toBeUndefined();
  });

  test("a `counts` field that is not a number is not summarizable", () => {
    // A string where a number belongs is the shape connector-written JSON actually produces;
    // reporting it as a metric would put a non-numeric value into a delta comparison.
    expect(
      summarizeBrief(
        "agents.changelog",
        changelogBrief({
          counts: { mergedPrs: "1", deployments: 0, incidentsOpened: 0, incidentsResolved: 0 },
        }),
      ),
    ).toBeUndefined();
  });

  test("an entry field that is not an array is not summarizable", () => {
    expect(
      summarizeBrief("agents.changelog", changelogBrief({ deployments: { id: "gha:9" } })),
    ).toBeUndefined();
  });

  test("an entry whose `id` is not a string is not summarizable", () => {
    expect(
      summarizeBrief("agents.changelog", changelogBrief({ mergedPrs: [{ id: 42 }] })),
    ).toBeUndefined();
  });
});
