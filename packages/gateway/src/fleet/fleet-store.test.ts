import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import { FleetStore } from "./fleet-store.ts";

let db: Database;
let store: FleetStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(FLEET_V60_SQL);
  for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
  store = new FleetStore(db);
});

/**
 * Shared helper for the digest-read tests below: one brief, defaulted so callers state only what
 * they mean. Opens its own run per call — sharing one `runId` across a whole test (via a
 * module-level `beforeEach`) would add an extra `fleet_run` row that pre-existing tests like
 * `pruneRuns` never expected and do not filter out.
 */
function insertBrief(b: {
  jobId: string;
  subjectKey?: string;
  createdAt: number;
  expiresAt?: number;
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
    agentMethod: "agents.catchup",
    briefMarkdown: "x",
    findingsJson: "{}",
    synthesisJson: null,
    createdAt: b.createdAt,
    expiresAt: b.expiresAt ?? b.createdAt + 86_400_000,
  });
}

describe("FleetStore", () => {
  test("records a run and its briefs", () => {
    const runId = store.openRun({
      startedAt: 1000,
      hostPower: "ac",
      hostIdleMs: 900_000,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId: "morning_catchup",
      subjectKey: "morning_catchup",
      agentMethod: "agents.catchup",
      briefMarkdown: "# Catchup",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 1100,
      expiresAt: 1100 + 86_400_000,
    });
    store.closeRun(runId, {
      endedAt: 2000,
      outcome: "completed",
      jobsInScope: 1,
      jobsAttempted: 1,
      jobsCompleted: 1,
      jobsSkippedNotDue: 0,
      remoteCallsMade: 0,
      subjectsInScope: 0,
      subjectsAttempted: 0,
      subjectsCompleted: 0,
    });

    const briefs = store.listBriefs({ limit: 10, now: 0 });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.agentMethod).toBe("agents.catchup");
  });

  test("closeRun round-trips jobs_skipped_not_due as a value distinct from the other counters", () => {
    // Three DIFFERENT numbers, so a column swap or a copied bind parameter cannot pass. Persisted
    // rather than derived because the summary object is gone the moment `runOnce` returns, and
    // reconstructing "how many were not due" after the fact from config + fleet_job_state is a
    // guess: the intervals may have been edited since.
    const runId = store.openRun({
      startedAt: 10,
      hostPower: "ac",
      hostIdleMs: 900_000,
      hostSource: "measured",
      remoteCallBudget: 7,
    });
    store.closeRun(runId, {
      endedAt: 20,
      outcome: "yielded",
      jobsInScope: 9,
      jobsAttempted: 3,
      jobsCompleted: 2,
      jobsSkippedNotDue: 5,
      remoteCallsMade: 1,
      subjectsInScope: 0,
      subjectsAttempted: 0,
      subjectsCompleted: 0,
    });

    const row = db
      .query(
        `SELECT jobs_in_scope, jobs_attempted, jobs_completed, jobs_skipped_not_due,
                remote_calls_made, outcome
           FROM fleet_run WHERE id = ?`,
      )
      .get(runId) as {
      jobs_in_scope: number;
      jobs_attempted: number;
      jobs_completed: number;
      jobs_skipped_not_due: number;
      remote_calls_made: number;
      outcome: string;
    } | null;
    expect(row).toMatchObject({
      jobs_in_scope: 9,
      jobs_attempted: 3,
      jobs_completed: 2,
      jobs_skipped_not_due: 5,
      remote_calls_made: 1,
      outcome: "yielded",
    });
  });

  test("a run row that is opened and never closed reports zero skipped, not NULL", () => {
    // The column is NOT NULL DEFAULT 0, so an in-flight run reads as 0 rather than NULL. A reader
    // must not have to handle a third state for a row that simply has not finished yet.
    const runId = store.openRun({
      startedAt: 10,
      hostPower: "unknown",
      hostIdleMs: null,
      hostSource: "power_only",
      remoteCallBudget: 0,
    });
    const row = db
      .query(
        `SELECT jobs_skipped_not_due AS n, jobs_in_scope AS scope, outcome
           FROM fleet_run WHERE id = ?`,
      )
      .get(runId) as { n: number; scope: number; outcome: string | null } | null;
    expect(row?.n).toBe(0);
    expect(row?.scope).toBe(0);
    expect(row?.outcome).toBeNull();
  });

  test("deleting a run cascades to its briefs — the cascade is live, not decorative", () => {
    const runId = store.openRun({
      startedAt: 1,
      hostPower: "unknown",
      hostIdleMs: null,
      hostSource: "power_only",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId: "j",
      subjectKey: "j",
      agentMethod: "agents.catchup",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 1,
      expiresAt: 2,
    });
    db.run("DELETE FROM fleet_run WHERE id = ?", [runId]);
    expect(store.listBriefs({ limit: 10, now: 0 })).toHaveLength(0);
  });

  test("failure backoff is exponential and capped at 24h", () => {
    for (let i = 0; i < 8; i++) store.recordJobFailure("j", 0, "boom");
    const state = store.loadJobState("j");
    expect(state?.consecutiveFailures).toBe(8);
    expect(state?.backoffUntil).toBe(24 * 60 * 60 * 1000);
    expect(state?.lastError).toBe("boom");
  });

  test("a success clears the backoff", () => {
    store.recordJobFailure("j", 0, "boom");
    store.recordJobSuccess("j", 500);
    const state = store.loadJobState("j");
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.backoffUntil).toBeNull();
  });

  test("prune removes only expired briefs", () => {
    const runId = store.openRun({
      startedAt: 0,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    for (const [id, exp] of [
      ["old", 100],
      ["new", 10_000],
    ] as const) {
      store.recordBrief({
        runId,
        jobId: id,
        subjectKey: id,
        agentMethod: "agents.catchup",
        briefMarkdown: "x",
        findingsJson: "{}",
        synthesisJson: null,
        createdAt: 0,
        expiresAt: exp,
      });
    }
    expect(store.pruneBriefs(500)).toBe(1);
    expect(store.listBriefs({ limit: 10, now: 0 })).toHaveLength(1);
  });

  test("getBrief is a point lookup that finds a brief beyond any list page", () => {
    const runId = store.openRun({
      startedAt: 0,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    let target = "";
    // More than any plausible list limit: a scan-and-find implementation returns undefined here.
    for (let i = 0; i < 1_200; i++) {
      const id = store.recordBrief({
        runId,
        jobId: `j${i}`,
        subjectKey: `j${i}`,
        agentMethod: "agents.catchup",
        briefMarkdown: "x",
        findingsJson: "{}",
        synthesisJson: null,
        createdAt: i,
        expiresAt: 10_000_000,
      });
      if (i === 0) target = id; // the OLDEST, so it sorts last by created_at DESC
    }
    expect(store.getBrief(target, 0)?.jobId).toBe("j0");
    expect(store.getBrief("no-such-id", 0)).toBeUndefined();
  });

  test("pruning a run cascades its briefs away", () => {
    const runId = store.openRun({
      startedAt: 100,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId: "j",
      subjectKey: "j",
      agentMethod: "agents.catchup",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 100,
      // Deliberately far in the future: the RUN's age is what retires it, and the cascade is
      // what removes the brief. Without pruneRuns, fleet_run grows one row per tick forever.
      expiresAt: 10_000_000,
    });
    expect(store.pruneRuns(500)).toBe(1);
    expect(store.listBriefs({ limit: 10, now: 0 })).toHaveLength(0);
  });

  test("an expired brief is excluded from both reads even though its row still exists", () => {
    // Pruning runs at gateway boot and at the end of each fleet RUN — so on a gateway whose fleet
    // is disabled, or simply between runs, a brief past its `expires_at` is still in the table,
    // and a read surface that still returned it would
    // make retention a lie. This proves the exclusion happens on READ, independent of `pruneBriefs`
    // ever having run: the row is left in place deliberately (no prune call in this test at all).
    const runId = store.openRun({
      startedAt: 0,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    const id = store.recordBrief({
      runId,
      jobId: "stale",
      subjectKey: "stale",
      agentMethod: "agents.catchup",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 0,
      expiresAt: 1000,
    });

    // The row is still physically present …
    const raw = db.query(`SELECT id FROM fleet_brief WHERE id = ?`).get(id);
    expect(raw).not.toBeNull();

    // … but both read paths refuse it once `now` is past `expires_at`.
    expect(store.getBrief(id, 2000)).toBeUndefined();
    expect(store.listBriefs({ limit: 10, now: 2000 })).toHaveLength(0);
    expect(store.listBriefs({ limit: 10, jobId: "stale", now: 2000 })).toHaveLength(0);

    // Sanity: the same brief IS visible before its expiry.
    expect(store.getBrief(id, 500)?.id).toBe(id);
    expect(store.listBriefs({ limit: 10, now: 500 })).toHaveLength(1);
  });

  test("a brief round-trips its subject key through every read", () => {
    const runId = store.openRun({
      startedAt: 1000,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    const id = store.recordBrief({
      runId,
      jobId: "bus-factor",
      subjectKey: "paths:file:/r:src/a.ts",
      agentMethod: "agents.ownership",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 1100,
      expiresAt: 1100 + 86_400_000,
    });
    expect(store.getBrief(id, 1200)?.subjectKey).toBe("paths:file:/r:src/a.ts");
    expect(store.listBriefs({ limit: 5, now: 1200 })[0]?.subjectKey).toBe("paths:file:/r:src/a.ts");
  });
});

describe("briefPairForSubject implements spec § 2.1", () => {
  test("prefers the newest brief BEFORE the window over an in-window one", () => {
    // Window is [1000, now]. Briefs at 500, 1100, 1200 — an hourly-job shape.
    insertBrief({ jobId: "j", createdAt: 500 });
    insertBrief({ jobId: "j", createdAt: 1100 });
    insertBrief({ jobId: "j", createdAt: 1200 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 1000,
      now: 9999,
    });
    expect(pair.current?.createdAt).toBe(1200);
    expect(pair.predecessor?.createdAt).toBe(500); // NOT 1100
  });

  test("falls back to the oldest in-window brief when nothing precedes the window", () => {
    insertBrief({ jobId: "j", createdAt: 1100 });
    insertBrief({ jobId: "j", createdAt: 1200 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 1000,
      now: 9999,
    });
    expect(pair.current?.createdAt).toBe(1200);
    expect(pair.predecessor?.createdAt).toBe(1100);
  });

  test("a lone brief has no predecessor", () => {
    insertBrief({ jobId: "j", createdAt: 1100 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 1000,
      now: 9999,
    });
    expect(pair.current?.createdAt).toBe(1100);
    expect(pair.predecessor).toBeUndefined();
  });

  test("two briefs sharing a timestamp: the tied row is the predecessor, not skipped", () => {
    // `fleet_brief` has no per-job uniqueness on `created_at` and `recordBrief` takes a
    // caller-supplied clock, so a tie is expressible. The old `created_at < current.createdAt`
    // fallback excluded BOTH tied rows and jumped to an older brief — reporting a comparison span
    // against the wrong one. Nothing precedes the window here, so this is spec § 2.1 case 2.
    insertBrief({ jobId: "j", createdAt: 5000 });
    insertBrief({ jobId: "j", createdAt: 5000 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 4000,
      now: 9999,
    });
    expect(pair.current).toBeDefined();
    expect(pair.predecessor).toBeDefined();
    expect(pair.predecessor?.createdAt).toBe(5000);
    // The pair must be two DIFFERENT rows — a brief is never its own predecessor.
    expect(pair.predecessor?.id).not.toBe(pair.current?.id);
  });

  test("current is deterministic when timestamps tie", () => {
    insertBrief({ jobId: "j", createdAt: 5000 });
    insertBrief({ jobId: "j", createdAt: 5000 });
    const ids = new Set(
      Array.from(
        { length: 10 },
        () =>
          store.briefPairForSubject({ jobId: "j", subjectKey: "j", windowStartMs: 4000, now: 9999 })
            .current?.id,
      ),
    );
    // `ORDER BY created_at DESC` alone leaves the winner to SQLite; the digest claims the same
    // database renders the same report, so the tie-break has to be part of the ordering.
    expect(ids.size).toBe(1);
  });

  test("a future-dated brief is never selected as current", () => {
    // An NTP correction moving the clock backwards leaves rows ahead of `now`, and their expiry is
    // ahead too, so the retention filter alone does not exclude them.
    insertBrief({ jobId: "j", createdAt: 1200 });
    insertBrief({ jobId: "j", createdAt: 99_000 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 1000,
      now: 5000,
    });
    expect(pair.current?.createdAt).toBe(1200);
  });

  test("expired briefs are invisible to both halves", () => {
    insertBrief({ jobId: "j", createdAt: 500, expiresAt: 600 });
    insertBrief({ jobId: "j", createdAt: 1200 });
    const pair = store.briefPairForSubject({
      jobId: "j",
      subjectKey: "j",
      windowStartMs: 1000,
      now: 9999,
    });
    expect(pair.predecessor).toBeUndefined();
  });

  test("(red-prove) the oldest-in-window fallback is subject-scoped too", () => {
    // Nothing precedes the window, so the pair falls back to the OLDEST brief inside it. Without
    // `subject_key = ?` on that query, subject a's predecessor would be subject b's earlier brief.
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 1100 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 1200 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 1500 });
    const pair = store.briefPairForSubject({
      jobId: "bus",
      subjectKey: "paths:a",
      windowStartMs: 1000,
      now: 2000,
    });
    expect(pair.current?.createdAt).toBe(1500);
    expect(pair.predecessor?.createdAt).toBe(1200);
    expect(pair.predecessor?.subjectKey).toBe("paths:a");
  });
});

describe("jobIdsWithBriefsInWindow", () => {
  test("returns distinct ids inside the window only, sorted", () => {
    insertBrief({ jobId: "b", createdAt: 1100 });
    insertBrief({ jobId: "a", createdAt: 1100 });
    insertBrief({ jobId: "a", createdAt: 1200 });
    insertBrief({ jobId: "old", createdAt: 500 });
    expect(store.jobIdsWithBriefsInWindow({ windowStartMs: 1000, now: 9999 })).toEqual(["a", "b"]);
  });

  // I1 red-prove: `briefPairForSubject`'s `current` arm carries `created_at <= now` (an NTP
  // correction can leave a future-dated row whose `expires_at` is future too, so it passes the
  // retention filter alone). This query must agree, or a future-dated brief puts a job in the
  // union while `briefPairForSubject` then finds no `current` for it — reported as
  // `noBriefInWindow` for a job that in fact produced a brief.
  test("excludes a future-dated brief, matching briefPairForSubject's own bound", () => {
    insertBrief({ jobId: "j", createdAt: 99_000 });
    expect(store.jobIdsWithBriefsInWindow({ windowStartMs: 1000, now: 5000 })).toEqual([]);
  });
});

describe("sweep state", () => {
  test("enumeration records kind/total/reason; the cursor advances by key", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:file:/r:b.ts");
    expect(store.loadSweepState("bus")).toEqual({
      kind: "paths",
      cursor: "paths:file:/r:b.ts",
      subjectsTotal: 3,
      emptyReason: null,
    });
  });

  test("a re-enumeration of the SAME kind keeps the cursor", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:k2");
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 4, emptyReason: null });
    expect(store.loadSweepState("bus")?.cursor).toBe("paths:k2");
    expect(store.loadSweepState("bus")?.subjectsTotal).toBe(4);
  });

  test("a CHANGED kind resets the cursor rather than comparing keys of another kind", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:k2");
    store.recordSweepEnumeration("bus", { kind: "services", subjectsTotal: 1, emptyReason: null });
    expect(store.loadSweepState("bus")?.cursor).toBeNull();
    expect(store.loadSweepState("bus")?.kind).toBe("services");
  });

  test("(red-prove) recordJobSuccess and recordJobFailure leave sweep columns untouched", () => {
    // Both statements use ON CONFLICT DO UPDATE SET with an explicit column list, which leaves
    // unlisted columns alone. Pinned because the next edit to either statement is where it breaks.
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 7, emptyReason: "x" });
    store.advanceSweepCursor("bus", "paths", "paths:k5");
    store.recordJobSuccess("bus", 10);
    store.recordJobFailure("bus", 20, "boom");
    expect(store.loadSweepState("bus")).toEqual({
      kind: "paths",
      cursor: "paths:k5",
      subjectsTotal: 7,
      emptyReason: "x",
    });
  });
});

describe("subject-scoped brief reads", () => {
  test("briefPairForSubject pairs within ONE subject, never across subjects of a job", () => {
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 100 });
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 150 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 5000 });
    const pair = store.briefPairForSubject({
      jobId: "bus",
      subjectKey: "paths:a",
      windowStartMs: 1000,
      now: 6000,
    });
    expect(pair.current?.createdAt).toBe(5000);
    expect(pair.predecessor?.createdAt).toBe(100);
    expect(pair.predecessor?.subjectKey).toBe("paths:a");
  });

  test("subjectKeysWithBriefsInWindow is distinct and code-unit sorted", () => {
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 2000 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 2001 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 2002 });
    insertBrief({ jobId: "other", subjectKey: "paths:z", createdAt: 2003 });
    expect(
      store.subjectKeysWithBriefsInWindow({ jobId: "bus", windowStartMs: 1000, now: 3000 }),
    ).toEqual(["paths:a", "paths:b"]);
  });

  test("listBriefs filters by subjectKey across jobs", () => {
    insertBrief({ jobId: "j1", subjectKey: "services:checkout", createdAt: 2000 });
    insertBrief({ jobId: "j2", subjectKey: "services:checkout", createdAt: 2001 });
    insertBrief({ jobId: "j2", subjectKey: "services:billing", createdAt: 2002 });
    const rows = store.listBriefs({ limit: 10, subjectKey: "services:checkout", now: 3000 });
    expect(rows.map((r) => r.jobId).sort()).toEqual(["j1", "j2"]);
  });

  test("closeRun persists subject counters", () => {
    const runId = store.openRun({
      startedAt: 1,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.closeRun(runId, {
      endedAt: 2,
      outcome: "completed",
      jobsInScope: 1,
      jobsAttempted: 1,
      jobsCompleted: 1,
      jobsSkippedNotDue: 0,
      remoteCallsMade: 0,
      subjectsInScope: 4,
      subjectsAttempted: 4,
      subjectsCompleted: 3,
    });
    const row = db
      .query(
        "SELECT subjects_in_scope, subjects_attempted, subjects_completed FROM fleet_run WHERE id = ?",
      )
      .get(runId) as {
      subjects_in_scope: number;
      subjects_attempted: number;
      subjects_completed: number;
    };
    expect(row).toEqual({ subjects_in_scope: 4, subjects_attempted: 4, subjects_completed: 3 });
  });
});
