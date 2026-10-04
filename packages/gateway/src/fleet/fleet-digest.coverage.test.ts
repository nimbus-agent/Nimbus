/**
 * Fleet-digest outcomes `fleet-digest.test.ts` leaves unexercised, on a real `FleetStore`:
 *  - exactly ONE side of a pair unreadable — the other side must NOT be reported as unreadable too
 *    (both the config-named job walk and the sweep subject walk);
 *  - an unconfigured sweep whose subject keys carry no known sweep prefix — its kind is unknown,
 *    and the heading says so rather than guessing;
 *  - several metrics withheld at once (the plural disclosure line);
 *  - fractional hour and day spans in the rendered Markdown.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import { buildFleetDigest, renderFleetDigest } from "./fleet-digest.ts";
import { FleetStore } from "./fleet-store.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: Database;
let store: FleetStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(FLEET_V60_SQL);
  for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
  store = new FleetStore(db);
});

afterEach(() => {
  db.close();
});

function job(name: string, digestMinDelta = 1): NimbusFleetJobToml {
  return { name, agent: "ghost", intervalSeconds: 3600, params: {}, digestMinDelta, sweep: null };
}

function ghostFindings(peerIds: readonly string[]): string {
  return JSON.stringify({
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [],
    kind: "ghost",
    query: { file: "a.ts" },
    startEntityId: null,
    findings: peerIds.map((peerId) => ({
      peerId,
      expert: null,
      rank: "medium",
      context: [],
      suggestedContact: "",
    })),
  });
}

/** One run per brief, as `fleet-digest.test.ts` does — a shared run id adds a stray run row. */
function insertBrief(b: {
  jobId: string;
  subjectKey?: string;
  createdAt: number;
  findingsJson: string;
}): string {
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
    agentMethod: "agents.ghost",
    briefMarkdown: "x",
    findingsJson: b.findingsJson,
    synthesisJson: null,
    createdAt: b.createdAt,
    expiresAt: b.createdAt + DAY,
  });
  return runId;
}

describe("exactly one side unreadable", () => {
  test("job walk: an unreadable CURRENT brief is disclosed once, as current only", () => {
    insertBrief({ jobId: "j1", createdAt: 4000, findingsJson: ghostFindings(["p1"]) });
    insertBrief({ jobId: "j1", createdAt: 4500, findingsJson: "{{{" });
    const r = buildFleetDigest({
      store,
      jobs: [job("j1")],
      windowMs: 1000,
      now: 5000,
      retentionDays: 14,
    });
    expect(r.notCompared.notSummarizable).toEqual([
      {
        jobId: "j1",
        briefId: expect.any(String),
        role: "current",
        reason: "unreadable agents.ghost brief",
        configured: true,
      },
    ]);
    expect(r.jobs).toEqual([]);
  });

  const SWEEP: NimbusFleetJobToml = {
    ...job("sym"),
    sweep: { kind: "symbols", maxSubjects: 2, pathPrefix: null },
  };

  test.each([
    ["current", "}}}", ghostFindings(["p1"])],
    ["predecessor", ghostFindings(["p1"]), "}}}"],
  ] as const)(
    "sweep walk: only the %s brief unreadable yields ONE entry naming that role",
    (role, currentJson, predecessorJson) => {
      insertBrief({
        jobId: "sym",
        subjectKey: "symbols:z",
        createdAt: 100,
        findingsJson: predecessorJson,
      });
      insertBrief({
        jobId: "sym",
        subjectKey: "symbols:z",
        createdAt: 5000,
        findingsJson: currentJson,
      });
      const r = buildFleetDigest({
        store,
        jobs: [SWEEP],
        windowMs: 1000,
        now: 5500,
        retentionDays: 14,
      });
      const s = r.sweeps[0];
      expect(s?.notSummarizable).toEqual([
        {
          subjectKey: "symbols:z",
          briefId: expect.any(String),
          reason: `unreadable agents.ghost brief (${role})`,
        },
      ]);
      expect(s?.moved).toEqual([]);
      expect(r.markdown).toContain("Not summarizable: 1");
      expect(r.markdown).toContain(`- symbols:z — unreadable agents.ghost brief (${role})`);
    },
  );
});

describe("an unconfigured sweep with no recognisable subject prefix", () => {
  test("reports its kind as unknown rather than guessing one", () => {
    insertBrief({
      jobId: "legacy",
      subjectKey: "repos:acme/api",
      createdAt: 5000,
      findingsJson: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5500, retentionDays: 14 });
    expect(r.sweeps).toHaveLength(1);
    expect(r.sweeps[0]).toMatchObject({ jobId: "legacy", sweepKind: null, configured: false });
    expect(r.markdown).toContain("## legacy (sweep: unknown) [unconfigured]");
  });

  test("control: a recognised prefix names the kind", () => {
    insertBrief({
      jobId: "legacy",
      // The shape a real paths subject has (`paths:` + the ownership node id `file:<root>:<rel>`):
      // several colons, so only the text before the FIRST one is the sweep kind.
      subjectKey: "paths:file:/repo:src/api",
      createdAt: 5000,
      findingsJson: ghostFindings(["p1"]),
    });
    const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5500, retentionDays: 14 });
    expect(r.sweeps[0]?.sweepKind).toBe("paths");
    expect(r.markdown).toContain("## legacy (sweep: paths) [unconfigured]");
  });
});

describe("withheld metrics", () => {
  test("two metrics under digest_min_delta are disclosed with the plural count", () => {
    insertBrief({ jobId: "j1", createdAt: 4000, findingsJson: ghostFindings(["p1"]) });
    // p2 appears (a key change — never suppressed), while ghost_peers and rank_medium each move by
    // one, below the job's threshold of 5.
    insertBrief({ jobId: "j1", createdAt: 4500, findingsJson: ghostFindings(["p1", "p2"]) });
    const r = buildFleetDigest({
      store,
      jobs: [job("j1", 5)],
      windowMs: 1000,
      now: 5000,
      retentionDays: 14,
    });
    expect(r.jobs[0]).toMatchObject({
      status: "changed",
      metricsSuppressed: 2,
      keysAppeared: ["p2"],
    });
    expect(r.markdown).toContain("2 metrics withheld below digest_min_delta = 5");
    expect(r.markdown).not.toContain("2 metric withheld");
  });
});

describe("rendered spans", () => {
  const NONE = { firstObservation: [], notSummarizable: [], noBriefInWindow: [], agentChanged: [] };

  test("a fractional hour window and a fractional day span keep one decimal", () => {
    const md = renderFleetDigest({
      windowMs: 1.5 * HOUR,
      generatedAt: 0,
      sweeps: [],
      notCompared: NONE,
      jobs: [
        {
          jobId: "every-60h",
          agentMethod: "agents.ghost",
          configured: true,
          status: "unchanged",
          minDelta: 1,
          currentBriefId: "c",
          currentCreatedAt: 0,
          predecessorBriefId: "p",
          predecessorCreatedAt: 0,
          comparisonSpanMs: 2.5 * DAY,
          metrics: {},
          metricsSuppressed: 0,
          keysAppeared: [],
          keysResolved: [],
        },
      ],
    });
    expect(md).toContain("Window: the last 1.5h.");
    expect(md).toContain("agents.ghost · compared over 2.5d · unchanged");
  });
});
