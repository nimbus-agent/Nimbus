import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import { buildFleetDigest, compareSummaries, renderFleetDigest } from "./fleet-digest.ts";
import type { FleetJobDigest } from "./fleet-digest-types.ts";
import { FleetStore } from "./fleet-store.ts";

const s = (keys: string[], metrics: Record<string, number>) => ({ keys, metrics });

describe("compareSummaries", () => {
  test("identical summaries are unchanged", () => {
    const r = compareSummaries(s(["a"], { n: 1 }), s(["a"], { n: 1 }), 1);
    expect(r.status).toBe("unchanged");
    expect(r.keysAppeared).toEqual([]);
    expect(r.metrics).toEqual({});
  });

  test("keys appearing and resolving are both reported, sorted", () => {
    const r = compareSummaries(s(["a", "b"], {}), s(["b", "c"], {}), 1);
    expect(r.keysAppeared).toEqual(["c"]);
    expect(r.keysResolved).toEqual(["a"]);
    expect(r.status).toBe("changed");
  });

  test("a metric moving below minDelta is suppressed and the status says so", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 12 }), 5);
    expect(r.metrics).toEqual({});
    expect(r.status).toBe("unchanged_within_threshold");
  });

  test("a metric at exactly minDelta reports", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 15 }), 5);
    expect(r.metrics["n"]).toEqual({ before: 10, after: 15, delta: 5 });
    expect(r.status).toBe("changed");
  });

  test("a key change is NEVER suppressed by the threshold", () => {
    const r = compareSummaries(s(["a"], { n: 10 }), s(["a", "b"], { n: 11 }), 99);
    expect(r.keysAppeared).toEqual(["b"]);
    expect(r.status).toBe("changed");
  });

  test("a metric present on one side only is not synthesized into 0 -> N", () => {
    const added = compareSummaries(s([], {}), s([], { n: 7 }), 1);
    expect(added.metrics["n"]).toEqual({ before: null, after: 7, delta: null });
    const dropped = compareSummaries(s([], { n: 7 }), s([], {}), 1);
    expect(dropped.metrics["n"]).toEqual({ before: 7, after: null, delta: null });
  });

  // Task 7 review carry-over: every existing one-sided case uses a non-zero present value, so a
  // regression from `av ?? null` to `av || null` (which would coerce a present ZERO to `null`,
  // same as absent) would slip past every test above. Several real extractors emit legitimate
  // zeros (`huddle`'s tickets/incidents, `janitor`'s peers_clear), so this is realistic input.
  test("a one-sided metric whose present side is ZERO is not coerced to absent", () => {
    const added = compareSummaries(s([], {}), s([], { n: 0 }), 1);
    expect(added.metrics["n"]).toEqual({ before: null, after: 0, delta: null });
    const dropped = compareSummaries(s([], { n: 0 }), s([], {}), 1);
    expect(dropped.metrics["n"]).toEqual({ before: 0, after: null, delta: null });
  });

  test("a one-sided metric is reported regardless of minDelta", () => {
    const r = compareSummaries(s([], {}), s([], { n: 1 }), 1000);
    expect(r.metrics["n"]).toBeDefined();
    expect(r.status).toBe("changed");
  });

  test("a metric moving by exactly zero is not reported and does not mark suppression", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 10 }), 1);
    expect(r.metrics).toEqual({});
    expect(r.status).toBe("unchanged");
  });

  test("a negative delta below the threshold in magnitude is suppressed the same as positive", () => {
    const r = compareSummaries(s([], { n: 12 }), s([], { n: 10 }), 5);
    expect(r.metrics).toEqual({});
    expect(r.status).toBe("unchanged_within_threshold");
  });

  test("a negative delta at or beyond the threshold reports the true signed value", () => {
    const r = compareSummaries(s([], { n: 15 }), s([], { n: 10 }), 5);
    expect(r.metrics["n"]).toEqual({ before: 15, after: 10, delta: -5 });
    expect(r.status).toBe("changed");
  });

  test("returned metrics record is frozen", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 20 }), 1);
    expect(Object.isFrozen(r.metrics)).toBe(true);
  });

  test("keysAppeared and keysResolved are independently populated when both sides shrink/grow", () => {
    const r = compareSummaries(s(["a", "b", "c"], {}), s(["b"], {}), 1);
    expect(r.keysAppeared).toEqual([]);
    expect(r.keysResolved).toEqual(["a", "c"]);
    expect(r.status).toBe("changed");
  });

  test("one metric below threshold and another above both surface only the qualifying one, still changed", () => {
    const r = compareSummaries(s([], { small: 10, big: 10 }), s([], { small: 12, big: 20 }), 5);
    expect(r.metrics).toEqual({ big: { before: 10, after: 20, delta: 10 } });
    expect(r.status).toBe("changed");
  });

  // I4 red-prove: a threshold-suppressed metric must leave a trace even when the job ALSO changed
  // some other way — today `suppressed` is consulted only in the `!changed` branch, so a mixed job
  // (one metric above the threshold, one below) reports nothing at all about the withheld metric.
  test("a suppressed metric is counted even when another metric changes (mixed case)", () => {
    const r = compareSummaries(s([], { small: 4, big: 10 }), s([], { small: 5, big: 20 }), 5);
    expect(r.metrics).toEqual({ big: { before: 10, after: 20, delta: 10 } });
    expect(r.status).toBe("changed");
    expect(r.metricsSuppressed).toBe(1);
  });

  test("metricsSuppressed counts every withheld metric in the all-suppressed case too", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 12 }), 5);
    expect(r.status).toBe("unchanged_within_threshold");
    expect(r.metricsSuppressed).toBe(1);
  });

  test("metricsSuppressed is zero when nothing was withheld", () => {
    const r = compareSummaries(s([], { n: 10 }), s([], { n: 20 }), 1);
    expect(r.metricsSuppressed).toBe(0);
  });
});

describe("buildFleetDigest assembles the job union", () => {
  let db: Database;
  let store: FleetStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(FLEET_V60_SQL);
    for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
    store = new FleetStore(db);
  });

  function job(name: string, agent: string, digestMinDelta = 1): NimbusFleetJobToml {
    return { name, agent, intervalSeconds: 3600, params: {}, digestMinDelta, sweep: null };
  }

  const ghostBase = { agentVersion: 1, generatedAt: 0, latencyMs: 0, gaps: [] };

  function ghostFindings(peerIds: string[]): string {
    return JSON.stringify({
      ...ghostBase,
      kind: "ghost",
      query: { file: "a.ts" },
      startEntityId: null,
      findings: peerIds.map((p) => ({
        peerId: p,
        expert: null,
        rank: "medium",
        context: [],
        suggestedContact: "",
      })),
    });
  }

  function catchupFindings(): string {
    return JSON.stringify({
      ...ghostBase,
      kind: "catchup",
      query: { sinceMs: 0 },
      selfPersonId: null,
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      sections: [],
    });
  }

  /**
   * Opens its own run per call, following `fleet-store.test.ts`'s `insertBrief` shape — sharing
   * one `runId` across a whole test added an extra `fleet_run` row that broke a neighbouring test
   * earlier in this plan.
   */
  function insertBrief(b: {
    jobId: string;
    subjectKey?: string;
    agentMethod: string;
    createdAt: number;
    findings?: string;
    findingsJson?: string;
    markdown?: string;
  }): void {
    const runId = store.openRun({
      startedAt: b.createdAt,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId: b.jobId,
      subjectKey: b.subjectKey ?? b.jobId,
      agentMethod: b.agentMethod,
      briefMarkdown: b.markdown ?? "x",
      findingsJson: b.findings ?? b.findingsJson ?? "{}",
      synthesisJson: null,
      createdAt: b.createdAt,
      expiresAt: b.createdAt + 86_400_000,
    });
  }

  test("a configured job with no brief in window lands in noBriefInWindow", () => {
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.notCompared.noBriefInWindow).toEqual([
      { jobId: "j1", agent: "ghost", configured: true },
    ]);
    expect(r.jobs).toEqual([]);
  });

  // I1 red-prove: a future-dated brief (NTP correction) must not put an unconfigured job into
  // `noBriefInWindow` at all — `jobIdsWithBriefsInWindow` and `briefPairForSubject` must agree on
  // the upper bound, or the union admits the job while the pair query then finds no `current` for it.
  test("a future-dated brief for an unconfigured job does not appear in noBriefInWindow", () => {
    insertBrief({
      jobId: "retired-ghost",
      agentMethod: "agents.ghost",
      createdAt: 99_000,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5000 });
    expect(r.notCompared.noBriefInWindow).toEqual([]);
    expect(r.jobs).toEqual([]);
    expect(r.notCompared.firstObservation).toEqual([]);
  });

  // I3 red-prove: the `[unconfigured]` marker must survive into every `notCompared` population,
  // not only `FleetJobDigest`. firstObservation and agentChanged are each reachable for a job that
  // was removed from config but still has real in-window briefs.
  test("firstObservation carries configured:false for a retired job", () => {
    insertBrief({
      jobId: "retired",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5000 });
    expect(r.notCompared.firstObservation).toEqual([
      { jobId: "retired", briefId: expect.any(String), createdAt: 4500, configured: false },
    ]);
  });

  test("agentChanged carries configured:false for a retired job", () => {
    insertBrief({
      jobId: "retired",
      agentMethod: "agents.catchup",
      createdAt: 4000,
      findings: catchupFindings(),
    });
    insertBrief({
      jobId: "retired",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5000 });
    expect(r.notCompared.agentChanged).toEqual([
      { jobId: "retired", from: "agents.catchup", to: "agents.ghost", configured: false },
    ]);
  });

  test("a job with briefs but no config is reported with configured:false", () => {
    insertBrief({
      jobId: "retired",
      agentMethod: "agents.ghost",
      createdAt: 4000,
      findings: ghostFindings(["p1"]),
    });
    insertBrief({
      jobId: "retired",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1", "p2"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5000 });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]?.configured).toBe(false);
    expect(r.jobs[0]?.keysAppeared).toEqual(["p2"]);
  });

  test("a single brief lands in firstObservation, not as all-new", () => {
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.jobs).toEqual([]);
    expect(r.notCompared.firstObservation[0]?.jobId).toBe("j1");
  });

  test("an unreadable brief is disclosed with its ROLE, not dropped", () => {
    insertBrief({ jobId: "j1", agentMethod: "agents.ghost", createdAt: 4000, findingsJson: "{{{" });
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.notCompared.notSummarizable[0]).toMatchObject({ jobId: "j1", role: "predecessor" });
  });

  test("both sides unreadable produce TWO notSummarizable entries, one per role", () => {
    insertBrief({ jobId: "j1", agentMethod: "agents.ghost", createdAt: 4000, findingsJson: "{{{" });
    insertBrief({ jobId: "j1", agentMethod: "agents.ghost", createdAt: 4500, findingsJson: "}}}" });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.notCompared.notSummarizable).toHaveLength(2);
    expect(r.notCompared.notSummarizable).toContainEqual(
      expect.objectContaining({ jobId: "j1", role: "current" }),
    );
    expect(r.notCompared.notSummarizable).toContainEqual(
      expect.objectContaining({ jobId: "j1", role: "predecessor" }),
    );
    expect(r.jobs).toEqual([]);
    expect(r.notCompared.firstObservation).toEqual([]);
    expect(r.notCompared.noBriefInWindow).toEqual([]);
    expect(r.notCompared.agentChanged).toEqual([]);
  });

  test("a job repointed at a different agent is NOT diffed across shapes", () => {
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.catchup",
      createdAt: 4000,
      findings: catchupFindings(),
    });
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.jobs).toEqual([]);
    expect(r.notCompared.agentChanged).toEqual([
      { jobId: "j1", from: "agents.catchup", to: "agents.ghost", configured: true },
    ]);
    // NOT in notSummarizable: both briefs read fine, the comparison is what failed.
    expect(r.notCompared.notSummarizable).toEqual([]);
  });

  test("SPEC § 1: differing markdown with identical findings is UNCHANGED", () => {
    // The whole basis of the design. A synthesized brief differs run to run on an unchanged index,
    // so if this ever reports "changed" the comparison has drifted onto brief_markdown.
    const findings = ghostFindings(["p1"]);
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4000,
      findings,
      markdown: "# One phrasing",
    });
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings,
      markdown: "# Totally different prose",
    });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.jobs[0]?.status).toBe("unchanged");
  });

  test("comparisonSpanMs is the pair's span, not the window", () => {
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 1000,
      findings: ghostFindings([]),
    });
    insertBrief({
      jobId: "j1",
      agentMethod: "agents.ghost",
      createdAt: 4500,
      findings: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5000 });
    expect(r.jobs[0]?.comparisonSpanMs).toBe(3500);
    expect(r.windowMs).toBe(1000);
  });
});

describe("renderFleetDigest", () => {
  const empty = {
    firstObservation: [],
    notSummarizable: [],
    noBriefInWindow: [],
    agentChanged: [],
  };

  test("the preamble states the window AND that predecessors may predate it", () => {
    const md = renderFleetDigest({
      windowMs: 86_400_000,
      generatedAt: 0,
      jobs: [],
      notCompared: empty,
    });
    expect(md).toContain("24h");
    expect(md).toMatch(/may be older than/i);
  });

  test("every Not compared subsection is present even when empty", () => {
    const md = renderFleetDigest({ windowMs: 1000, generatedAt: 0, jobs: [], notCompared: empty });
    expect(md).toContain("## Not compared");
    expect(md).toContain("First observation: 0");
    expect(md).toContain("Not summarizable: 0");
    expect(md).toContain("No brief in window: 0");
    expect(md).toContain("Agent changed: 0");
  });

  test("the default window renders as 24h, not 1.0d", () => {
    // The 24h boundary sits on the HOURS side: the default window is exactly 86_400_000 and
    // "the last 1.0d" is a worse way to say "the last 24h".
    const md = renderFleetDigest({
      windowMs: 86_400_000,
      generatedAt: 0,
      jobs: [],
      notCompared: empty,
    });
    expect(md).toContain("24h");
    expect(md).not.toContain("1.0d");
  });

  test("a week-long comparison span renders as 7d", () => {
    const md = renderFleetDigest({
      windowMs: 86_400_000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        {
          jobId: "weekly",
          agentMethod: "agents.ghost",
          configured: true,
          status: "unchanged",
          minDelta: 1,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 7 * 86_400_000,
          metrics: {},
          metricsSuppressed: 0,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toContain("7d");
  });

  test("an unchanged job gets a line, never silent omission", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        {
          jobId: "j1",
          agentMethod: "agents.ghost",
          configured: true,
          status: "unchanged",
          minDelta: 1,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 0,
          metrics: {},
          metricsSuppressed: 0,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toContain("j1");
    expect(md).toMatch(/unchanged/i);
  });

  test("an unconfigured job is marked", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        {
          jobId: "retired",
          agentMethod: "agents.ghost",
          configured: false,
          status: "unchanged",
          minDelta: 1,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 0,
          metrics: {},
          metricsSuppressed: 0,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toContain("[unconfigured]");
  });

  test("a suppressed change names the threshold", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        {
          jobId: "j1",
          agentMethod: "agents.ghost",
          configured: true,
          status: "unchanged_within_threshold",
          minDelta: 5,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 0,
          metrics: {},
          metricsSuppressed: 1,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toContain("5");
    expect(md).toMatch(/threshold/i);
  });

  // I4 red-prove: a job that changed AND had a metric withheld below the threshold must disclose
  // the withholding, naming the threshold — today nothing prints when `status` is "changed".
  test("a withheld metric is disclosed even on a job reported as changed", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        {
          jobId: "j1",
          agentMethod: "agents.ghost",
          configured: true,
          status: "changed",
          minDelta: 5,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 0,
          metrics: { big: { before: 10, after: 20, delta: 10 } },
          metricsSuppressed: 1,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toMatch(/1 metric withheld below digest_min_delta = 5/);
  });

  /**
   * Base job for the populated-render tests below, so each test overrides only the fields it
   * cares about rather than restating all thirteen every time.
   */
  function baseJob(overrides: Partial<FleetJobDigest> = {}): FleetJobDigest {
    return {
      jobId: "j1",
      agentMethod: "agents.ghost",
      configured: true,
      status: "changed",
      minDelta: 1,
      currentBriefId: "c",
      currentCreatedAt: 0,
      predecessorBriefId: "p",
      predecessorCreatedAt: 0,
      comparisonSpanMs: 0,
      metrics: {},
      metricsSuppressed: 0,
      keysAppeared: [],
      keysResolved: [],
      ...overrides,
    };
  }

  // --- Finding 1: untrusted strings must not be able to break table/structure. ---

  test("a metric name containing a pipe keeps the table at four columns", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [baseJob({ metrics: { "weird|name": { before: 1, after: 2, delta: 1 } } })],
    });
    const row = md.split("\n").find((l) => l.includes("weird"));
    expect(row).toBeDefined();
    // Split on an UNESCAPED pipe only — an escaped `\|` must not count as a column delimiter.
    // "| metric | before | after | delta |" splits into 6 pieces: leading "", 4 cells, trailing "".
    const cols = (row ?? "").split(/(?<!\\)\|/);
    expect(cols).toHaveLength(6);
  });

  test("a BACKSLASH before a pipe does not smuggle a live delimiter through the escape", () => {
    // CodeQL: "incomplete string escaping". Escaping the pipe alone turns `a\|b` into `a\\|b`,
    // where Markdown reads `\\` as one literal backslash and the pipe after it is LIVE — so the
    // row breaks anyway. The escape character has to be escaped first.
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [baseJob({ metrics: { "a\\|b": { before: 1, after: 2, delta: 1 } } })],
    });
    const row = md.split("\n").find((l) => l.includes("a\\")) ?? "";
    expect(row).not.toBe("");
    // Assert the EXACT escaped form, not a column count. The `(?<!\\)\|` split used by the test
    // above cannot tell these two apart — it reports six columns for the broken output and the
    // fixed one alike, because it does not model Markdown's backslash pairing. Checked: a test
    // written that way passes before the fix as well as after, which makes it no test at all.
    //
    // One backslash in the input must become two (a literal backslash), and the pipe must gain its
    // own — three in total, then the pipe. The pre-fix output had exactly two.
    const bs = "\\";
    expect(row).toContain(`a${bs}${bs}${bs}|b`);
    const backslashes = (row.match(/\\/g) ?? []).length;
    expect(backslashes).toBe(3);
  });

  test("a finding key containing a newline plus a forged heading does not produce a second heading", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [baseJob({ keysAppeared: ["p1:open_pr:github:Fix\n## Forged heading"] })],
    });
    // A newline in a finding key must not let it escape its bullet and become its own heading line.
    expect(md).not.toMatch(/^## Forged heading$/m);
  });

  // --- Finding 2: assert the actual rendered text of the populated paths, not just no-throw. ---

  test("a two-sided metric renders a plain delta row", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [baseJob({ metrics: { open_prs: { before: 10, after: 15, delta: 5 } } })],
    });
    expect(md).toContain("| open_prs | 10 | 15 | 5 |");
  });

  test("a one-sided metric shows (new metric) / (no longer reported) with an em dash, never 0 or null", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [
        baseJob({
          metrics: {
            newer: { before: null, after: 7, delta: null },
            gone: { before: 7, after: null, delta: null },
          },
        }),
      ],
    });
    expect(md).toContain("| newer (new metric) | — | 7 | — |");
    expect(md).toContain("| gone (no longer reported) | 7 | — | — |");
    expect(md).not.toContain("| 0 |");
    expect(md).not.toContain("null");
  });

  test("a populated Appeared and Resolved list renders the count and every entry", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      notCompared: empty,
      jobs: [baseJob({ keysAppeared: ["p2"], keysResolved: ["p1"] })],
    });
    expect(md).toContain("Appeared (1):");
    expect(md).toContain("- p2");
    expect(md).toContain("Resolved (1):");
    expect(md).toContain("- p1");
  });

  test("a populated firstObservation entry renders its bullet text", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        firstObservation: [{ jobId: "new-job", briefId: "b1", createdAt: 0, configured: true }],
      },
    });
    expect(md).toContain("First observation: 1");
    expect(md).toContain("- new-job — one brief so far, nothing to compare");
  });

  test("an unconfigured firstObservation entry is marked", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        firstObservation: [{ jobId: "retired", briefId: "b1", createdAt: 0, configured: false }],
      },
    });
    expect(md).toContain("- retired [unconfigured] — one brief so far, nothing to compare");
  });

  test("a populated notSummarizable entry renders its role and reason", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        notSummarizable: [
          {
            jobId: "j2",
            briefId: "b2",
            role: "current",
            reason: "unreadable agents.ghost brief",
            configured: true,
          },
        ],
      },
    });
    expect(md).toContain("Not summarizable: 1");
    expect(md).toContain("- j2 (current) — unreadable agents.ghost brief");
  });

  test("an unconfigured notSummarizable entry is marked", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        notSummarizable: [
          {
            jobId: "retired",
            briefId: "b2",
            role: "current",
            reason: "unreadable agents.ghost brief",
            configured: false,
          },
        ],
      },
    });
    expect(md).toContain("- retired [unconfigured] (current) — unreadable agents.ghost brief");
  });

  test("a populated noBriefInWindow entry renders its configured agent", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        noBriefInWindow: [{ jobId: "j3", agent: "ghost", configured: true }],
      },
    });
    expect(md).toContain("No brief in window: 1");
    expect(md).toContain("- j3 (ghost) — configured, produced nothing");
  });

  test("a populated agentChanged entry renders the from/to agent methods", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        agentChanged: [
          { jobId: "j4", from: "agents.catchup", to: "agents.ghost", configured: true },
        ],
      },
    });
    expect(md).toContain("Agent changed: 1");
    expect(md).toContain("- j4 — agents.catchup → agents.ghost, not comparable");
  });

  test("an unconfigured agentChanged entry is marked", () => {
    const md = renderFleetDigest({
      windowMs: 1000,
      generatedAt: 0,
      jobs: [],
      notCompared: {
        ...empty,
        agentChanged: [
          { jobId: "retired", from: "agents.catchup", to: "agents.ghost", configured: false },
        ],
      },
    });
    expect(md).toContain(
      "- retired [unconfigured] — agents.catchup → agents.ghost, not comparable",
    );
  });
});
