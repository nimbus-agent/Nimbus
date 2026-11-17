import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  DEBT_DAY as DAY,
  incident,
  DEBT_NOW as NOW,
  DEBT_ROOT as ROOT,
  seedGraph,
} from "../incident/__fixtures__/debt-seed.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import { readEvidence } from "./debt-evidence.ts";
import { scanDebt } from "./debt-scan.ts";
import type { ConfiguredRoot, DebtInput } from "./debt-types.ts";
import type { GitHistory, GitHistoryReader, GitHistoryResult } from "./git-history.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const INPUT: DebtInput = {
  nowMs: NOW,
  sinceDays: 365,
  untouchedDays: 180,
  minIncidents: 2,
  limit: 50,
};
const ROOTS: ConfiguredRoot[] = [{ path: ROOT, gitAware: true }];

function history(
  over: Partial<GitHistory> & { touch?: Record<string, number> } = {},
): GitHistoryResult {
  const touch = over.touch ?? {};
  return {
    ok: true,
    history: {
      prefix: over.prefix ?? "",
      tracked: over.tracked ?? new Set(Object.keys(touch)),
      lastTouchMs: over.lastTouchMs ?? new Map(Object.entries(touch)),
      oldestCommitMs:
        "oldestCommitMs" in over ? (over.oldestCommitMs as number | null) : NOW - 1000 * DAY,
      complete: over.complete ?? true,
    },
  };
}

const gitOf =
  (r: GitHistoryResult, seen: string[] = []): GitHistoryReader =>
  async (root) => {
    seen.push(root);
    return r;
  };

const OLD = NOW - 400 * DAY;
const RECENT = NOW - 20 * DAY;

describe("scanDebt", () => {
  test("a symbol in a file two incidents pointed at and nobody touched for 180 days is listed", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge", "refund"], "src/other.ts": ["x"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts", "src/other.ts"] });
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ touch: { "src/pay.ts": OLD, "src/other.ts": OLD } })),
    );
    expect(r.status).toBe("ok");
    expect(r.symbols.map((s) => `${s.name}@${s.file}`)).toEqual([
      "charge@src/pay.ts",
      "refund@src/pay.ts",
    ]);
    expect(r.symbols[0]).toMatchObject({ incidentCount: 2, lastTouchMs: OLD, root: ROOT });
    expect(r.symbols[0]?.incidents).toHaveLength(2);
    expect(r.counts).toMatchObject({ incidentsScanned: 2, rootsScanned: 1, filesJudged: 1 });
  });

  test("one incident is below the default threshold; --min-incidents 1 lists it", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    const git = gitOf(history({ touch: { "src/pay.ts": OLD } }));
    expect((await scanDebt(d, INPUT, ROOTS, git)).status).toBe("none");
    expect((await scanDebt(d, { ...INPUT, minIncidents: 1 }, ROOTS, git)).symbols).toHaveLength(1);
  });

  test("a file touched inside the untouched period is not debt; exactly at the threshold is not either", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    for (const at of [RECENT, NOW - 180 * DAY]) {
      const r = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: { "src/pay.ts": at } })));
      expect(r.symbols).toEqual([]);
    }
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ touch: { "src/pay.ts": NOW - 180 * DAY - 1 } })),
    );
    expect(r.symbols).toHaveLength(1);
  });

  test("the window is by the record's open time", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"], openedAtMs: NOW - 500 * DAY });
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: { "src/pay.ts": OLD } })));
    expect(r.symbols).toEqual([]);
    const wide = await scanDebt(
      d,
      { ...INPUT, sinceDays: 600 },
      ROOTS,
      gitOf(history({ touch: { "src/pay.ts": OLD } })),
    );
    expect(wide.symbols).toHaveLength(1);
  });

  test("a file the PR removed is not debt; an untracked file is never judged", async () => {
    const d = db();
    seedGraph(d, { files: { "src/gone.ts": ["g"], "src/new.ts": ["n"] } });
    incident(d, { pr: 1, files: ["src/gone.ts"], status: "removed" });
    incident(d, { pr: 2, files: ["src/gone.ts"], status: "removed" });
    incident(d, { pr: 3, files: ["src/new.ts"] });
    incident(d, { pr: 4, files: ["src/new.ts"] });
    // gone.ts is still tracked in this checkout (a stale one) and old: only the PR status keeps it out.
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ touch: { "src/gone.ts": OLD }, tracked: new Set(["src/gone.ts"]) })),
    );
    expect(r.symbols).toEqual([]);
    expect(r.counts.filesJudged).toBe(0);
    // new.ts is on the PR but not tracked here: never judged
    const u = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: {}, tracked: new Set() })));
    expect(u.counts.filesJudged).toBe(0);
  });

  test("a repo no configured root tracks is a Gap and git is never called", async () => {
    const d = db();
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const seen: string[] = [];
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history(), seen));
    expect(seen).toEqual([]);
    expect(r.gaps.map((g) => g.category)).toContain("repo_not_local");
    expect(r.gaps.find((g) => g.category === "repo_not_local")?.detail).toContain(
      "github:acme/web",
    );
  });

  test("a root the graph knows but the owner did not configure is never scanned", async () => {
    const d = db();
    const stray = resolve("/elsewhere/web");
    seedGraph(d, { root: stray, files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const seen: string[] = [];
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ touch: { "src/pay.ts": OLD } }), seen),
    );
    expect(seen).toEqual([]);
    expect(r.symbols).toEqual([]);
  });

  test("git receives the owner's configured spelling of the root, never the index's", async () => {
    const d = db();
    const graphSpelling = `${ROOT}/`;
    expect(graphSpelling).not.toBe(ROOT);
    seedGraph(d, { root: graphSpelling, files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const seen: string[] = [];
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ touch: { "src/pay.ts": OLD } }), seen),
    );
    expect(seen).toEqual([ROOT]);
    expect(r.symbols).toHaveLength(1);
  });

  test("a root that is not git-aware is skipped; no git-aware root at all is no_roots", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const seen: string[] = [];
    const off: ConfiguredRoot[] = [{ path: ROOT, gitAware: false }];
    const r = await scanDebt(d, INPUT, off, gitOf(history(), seen));
    expect(r).toMatchObject({ status: "no_roots", symbols: [] });
    expect(seen).toEqual([]);
    expect((await scanDebt(d, INPUT, [], gitOf(history()))).status).toBe("no_roots");
  });

  test("no incident in the window is no_incidents, never 'no debt'", async () => {
    const d = db();
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history()));
    expect(r.status).toBe("no_incidents");
  });

  test("git failures become named gaps", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    for (const reason of ["not_a_repo", "shallow", "git_failed", "too_large"] as const) {
      const r = await scanDebt(d, INPUT, ROOTS, gitOf({ ok: false, reason }));
      expect(r.status).toBe("none");
      expect(r.gaps.map((g) => g.category)).toEqual([
        {
          not_a_repo: "not_a_repo",
          shallow: "history_shallow",
          git_failed: "git_failed",
          too_large: "history_too_large",
        }[reason],
      ]);
      expect(r.gaps[0]?.detail).toContain(ROOT);
      expect(r.counts.rootsScanned).toBe(0);
    }
  });

  test("a capped history: unseen files are debt only when the oldest commit read is older than the threshold", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const tracked = new Set(["src/pay.ts"]);
    const deep = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ tracked, complete: false, oldestCommitMs: NOW - 300 * DAY })),
    );
    expect(deep.symbols[0]).toMatchObject({ name: "charge", lastTouchMs: null });
    const shallowHist = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ tracked, complete: false, oldestCommitMs: NOW - 30 * DAY })),
    );
    expect(shallowHist.symbols).toEqual([]);
    expect(shallowHist.gaps.map((g) => g.category)).toContain("history_truncated");
    const none = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ tracked, complete: false, oldestCommitMs: null })),
    );
    expect(none.gaps.map((g) => g.category)).toContain("history_truncated");
  });

  test("a tracked file with no commit in a COMPLETE history is a gap, not debt", async () => {
    const d = db();
    seedGraph(d, { files: { "src/pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["src/pay.ts"] });
    incident(d, { pr: 2, files: ["src/pay.ts"] });
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ tracked: new Set(["src/pay.ts"]), complete: true })),
    );
    expect(r.symbols).toEqual([]);
    expect(r.gaps.map((g) => g.category)).toContain("last_touch_unknown");
  });

  test("a root inside a repository: the prefix is stripped and paths outside it are ignored", async () => {
    const d = db();
    seedGraph(d, { files: { "pay.ts": ["charge"] } });
    incident(d, { pr: 1, files: ["svc/web/pay.ts", "other/pay.ts"] });
    incident(d, { pr: 2, files: ["svc/web/pay.ts"] });
    const r = await scanDebt(
      d,
      INPUT,
      ROOTS,
      gitOf(history({ prefix: "svc/web/", touch: { "pay.ts": OLD } })),
    );
    expect(r.symbols.map((s) => `${s.name}@${s.file}`)).toEqual(["charge@pay.ts"]);
  });

  test("two roots tracking one repo are both scanned; ordering is by incident count, then oldest touch", async () => {
    const d = db();
    const root2 = resolve("/work/web2");
    seedGraph(d, { files: { "a.ts": ["alpha"], "b.ts": ["beta"] } });
    seedGraph(d, { root: root2, files: { "a.ts": ["alpha"] } });
    incident(d, { pr: 1, files: ["a.ts", "b.ts"] });
    incident(d, { pr: 2, files: ["a.ts", "b.ts"] });
    incident(d, { pr: 3, files: ["a.ts"] });
    const seen: string[] = [];
    const r = await scanDebt(
      d,
      INPUT,
      [...ROOTS, { path: root2, gitAware: true }],
      gitOf(history({ touch: { "a.ts": OLD, "b.ts": OLD - DAY } }), seen),
    );
    expect(seen.sort()).toEqual([ROOT, root2].sort());
    expect(
      r.symbols.map((s) => `${s.name}:${s.incidentCount}:${s.root === ROOT ? "1" : "2"}`),
    ).toEqual(["alpha:3:1", "alpha:3:2", "beta:2:1"]);
  });

  test("limit cuts the list and reports how many were omitted", async () => {
    const d = db();
    seedGraph(d, { files: { "a.ts": ["a1", "a2", "a3"] } });
    incident(d, { pr: 1, files: ["a.ts"] });
    incident(d, { pr: 2, files: ["a.ts"] });
    const r = await scanDebt(
      d,
      { ...INPUT, limit: 2 },
      ROOTS,
      gitOf(history({ touch: { "a.ts": OLD } })),
    );
    expect(r.symbols).toHaveLength(2);
    expect(r.omitted).toBe(1);
  });

  test("a PR without indexed files, a truncated one and a record without a PR are named gaps", async () => {
    const d = db();
    seedGraph(d, { files: { "a.ts": ["a1"] } });
    incident(d, { pr: 1 }); // no pr_files_state row
    const trunc = incident(d, { pr: 2, files: ["a.ts"] });
    d.run("UPDATE pr_files_state SET truncated = 1");
    expect(trunc).toMatch(/^inc_/);
    upsertIncidentRecord(d, {
      record: buildRecord({ itemId: "pagerduty:NOPR", openedAtMs: NOW - DAY }),
      markdown: "m",
      recordSha256: "nopr",
      citedServices: ["pagerduty"],
      nowMs: NOW,
    });
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: { "a.ts": OLD } })));
    const cats = r.gaps.map((g) => g.category);
    expect(cats).toEqual(
      expect.arrayContaining(["pr_files_unknown", "pr_files_truncated", "no_pr_evidence"]),
    );
  });

  test("a record_json that cannot be read is counted and skipped, not thrown", async () => {
    const d = db();
    seedGraph(d, { files: { "a.ts": ["a1"] } });
    incident(d, { pr: 1, files: ["a.ts"] });
    d.run("UPDATE incident_record SET record_json = '{not json'");
    const ev = readEvidence(d, NOW, 365);
    expect(ev).toMatchObject({ malformed: 1, rows: [] });
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history()));
    expect(r.gaps.map((g) => g.category)).toContain("record_unreadable");
    for (const json of ['"x"', "{}", '{"change":{"pr":5}}', '{"change":{"pr":{"id":"x"}}}']) {
      d.run("UPDATE incident_record SET record_json = ?", [json]);
      expect(readEvidence(d, NOW, 365).malformed).toBe(1);
    }
  });

  test("a qualifying file with no indexed symbol is a Gap, never silent", async () => {
    const d = db();
    seedGraph(d, { files: { Dockerfile: [] } });
    incident(d, { pr: 1, files: ["Dockerfile"] });
    incident(d, { pr: 2, files: ["Dockerfile"] });
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: { Dockerfile: OLD } })));
    expect(r.status).toBe("none");
    expect(r.gaps.map((g) => g.category)).toContain("no_symbols_indexed");
  });

  test("a window no longer than the untouched period says no incident can qualify", async () => {
    const d = db();
    seedGraph(d, { files: { "a.ts": ["a1"] } });
    incident(d, { pr: 1, files: ["a.ts"] });
    const ok = await scanDebt(d, INPUT, ROOTS, gitOf(history()));
    expect(ok.gaps.map((g) => g.category)).not.toContain("window_too_short");
    for (const sinceDays of [180, 90]) {
      const r = await scanDebt(d, { ...INPUT, sinceDays }, ROOTS, gitOf(history()));
      expect(r.gaps.map((g) => g.category)).toContain("window_too_short");
    }
  });

  test("a symbol whose metadata is unreadable falls back to its label", async () => {
    const d = db();
    seedGraph(d, { files: { "a.ts": ["named"] } });
    d.run("UPDATE graph_entity SET metadata = 'junk' WHERE type = 'symbol'");
    incident(d, { pr: 1, files: ["a.ts"] });
    incident(d, { pr: 2, files: ["a.ts"] });
    const r = await scanDebt(d, INPUT, ROOTS, gitOf(history({ touch: { "a.ts": OLD } })));
    expect(r.symbols.map((s) => s.name)).toEqual(["named"]);
  });
});
