import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml, NimbusFleetToml } from "../config/fleet-toml.ts";
import { DEFAULT_FLEET_CONFIG } from "../config/fleet-toml.ts";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import type { HostActivityProbe } from "../platform/host-activity.ts";
import type { FleetInvoker, FleetJobOutcome } from "./fleet-invoker.ts";
import type { FleetRunBudget, FleetRunSummary } from "./fleet-scheduler.ts";
import { DEFAULT_TICK_MS, FleetScheduler, isJobDue } from "./fleet-scheduler.ts";
import { FleetStore } from "./fleet-store.ts";
import { createFleetRemoteBudget, wrapFleetSynthesisRouter } from "./fleet-synthesis-router.ts";

const AC_IDLE: HostActivityProbe = { power: "ac", idleMs: 3_600_000, source: "measured" };
const ON_BATTERY: HostActivityProbe = { power: "battery", idleMs: 3_600_000, source: "measured" };

const JOBS: readonly NimbusFleetJobToml[] = [
  { name: "a", agent: "catchup", intervalSeconds: 1, params: {}, digestMinDelta: 1, sweep: null },
  { name: "b", agent: "ownership", intervalSeconds: 1, params: {}, digestMinDelta: 1, sweep: null },
];

const NOW = 1_000_000;

function done(name: string): FleetJobOutcome {
  return {
    status: "done",
    briefMarkdown: `# ${name}`,
    findingsJson: JSON.stringify({ job: name }),
    synthesisJson: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let db: Database;
let store: FleetStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(FLEET_V60_SQL);
  for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
  store = new FleetStore(db);
});

function build(opts: {
  probes: readonly HostActivityProbe[];
  invoke: FleetInvoker;
  jobs?: readonly NimbusFleetJobToml[];
  config?: Partial<NimbusFleetToml>;
  remoteBudget?: FleetRunBudget;
  tickMs?: number;
  onProbe?: () => void;
}): FleetScheduler {
  let i = 0;
  const config: NimbusFleetToml = { ...DEFAULT_FLEET_CONFIG, enabled: true, ...opts.config };
  return new FleetScheduler({
    store,
    jobs: opts.jobs ?? JOBS,
    config,
    capabilityDisabled: false,
    hostActivity: {
      probe: async (): Promise<HostActivityProbe> => {
        opts.onProbe?.();
        // Clamps rather than wrapping: a test that probes more often than it listed should keep
        // seeing the LAST state it described, not silently restart the sequence.
        const p = opts.probes[Math.min(i, opts.probes.length - 1)];
        i += 1;
        if (p === undefined) throw new Error("test bug: no probes configured");
        return p;
      },
    },
    invoke: opts.invoke,
    now: () => NOW,
    // A REAL budget derived from the same config, so a test that says nothing about the budget
    // still gets the one its config implies rather than a stub. Tests that care pass their own.
    remoteBudget:
      opts.remoteBudget ?? createFleetRemoteBudget(config.allowRemote, config.remoteCallBudget),
    ...(opts.tickMs === undefined ? {} : { tickMs: opts.tickMs }),
  });
}

/** Narrows `runId` without an assertion, and fails the test loudly if a run row was expected. */
function requireRunId(summary: FleetRunSummary): string {
  if (summary.runId === null) throw new Error("expected the run to have opened a fleet_run row");
  return summary.runId;
}

interface FleetRunRow {
  outcome: string | null;
  jobs_in_scope: number;
  jobs_attempted: number;
  jobs_completed: number;
  jobs_skipped_not_due: number;
  remote_calls_made: number;
}

function runRow(runId: string): FleetRunRow {
  const row = db
    .query(
      `SELECT outcome, jobs_in_scope, jobs_attempted, jobs_completed, jobs_skipped_not_due,
              remote_calls_made
         FROM fleet_run WHERE id = ?`,
    )
    .get(runId) as FleetRunRow | null;
  if (row === null) throw new Error(`no fleet_run row for ${runId}`);
  return row;
}

/** The `remote_call_budget` the run row recorded — what that run actually had available. */
function recordedBudget(runId: string): number {
  const row = db.query(`SELECT remote_call_budget AS b FROM fleet_run WHERE id = ?`).get(runId) as {
    b: number;
  } | null;
  if (row === null) throw new Error(`no fleet_run row for ${runId}`);
  return row.b;
}

/**
 * The property the persisted counters exist for: the row alone answers "how many jobs did not get
 * to run", with no access to the config that produced it. Asserted against the SUMMARY's own
 * `jobsUnattempted` so the durable record and the live answer cannot drift apart.
 */
function expectRowIsSelfDescribing(summary: FleetRunSummary): FleetRunRow {
  const row = runRow(requireRunId(summary));
  expect(row.jobs_in_scope - row.jobs_attempted - row.jobs_skipped_not_due).toBe(
    summary.jobsUnattempted,
  );
  expect(row.jobs_attempted).toBe(summary.jobsAttempted);
  expect(row.jobs_completed).toBe(summary.jobsCompleted);
  expect(row.jobs_skipped_not_due).toBe(summary.jobsSkippedNotDue);
  return row;
}

describe("isJobDue", () => {
  const job: NimbusFleetJobToml = {
    name: "a",
    agent: "catchup",
    intervalSeconds: 1,
    params: {},
    digestMinDelta: 1,
    sweep: null,
  };

  test("a job with no state at all is due", () => {
    expect(isJobDue(job, undefined, NOW)).toBe(true);
  });

  test("a job that has only ever failed is due once its backoff expires", () => {
    // Keyed on lastSuccessAt, not lastAttemptAt: a failed job must retry when the backoff ends,
    // not wait a further full interval on top of it.
    const state = {
      jobId: "a",
      lastAttemptAt: NOW - 10,
      lastSuccessAt: null,
      consecutiveFailures: 3,
      backoffUntil: NOW - 1,
      lastError: "boom",
    };
    expect(isJobDue(job, state, NOW)).toBe(true);
    expect(isJobDue(job, { ...state, backoffUntil: NOW + 1 }, NOW)).toBe(false);
  });

  test("the interval is measured from the last SUCCESS", () => {
    const base = {
      jobId: "a",
      lastAttemptAt: NOW,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastError: null,
    };
    expect(isJobDue(job, { ...base, lastSuccessAt: NOW - 999 }, NOW)).toBe(false);
    expect(isJobDue(job, { ...base, lastSuccessAt: NOW - 1_000 }, NOW)).toBe(true);
  });
});

describe("FleetScheduler.runOnce", () => {
  test("runs jobs strictly one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
        return done(job.name);
      },
    });
    const summary = await s.runOnce();
    expect(maxInFlight).toBe(1);
    expect(summary.outcome).toBe("completed");
    expect(summary.jobsCompleted).toBe(2);
    expect(summary.jobsUnattempted).toBe(0);
    // Counters agreeing is not proof the work happened: assert the persisted effect too.
    expect(
      store
        .listBriefs({ limit: 10, now: NOW })
        .map((b) => b.jobId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(summary.runId).not.toBeNull();
    expect(runRow(requireRunId(summary))).toMatchObject({
      outcome: "completed",
      jobs_attempted: 2,
      jobs_completed: 2,
    });
  });

  test("refuses on battery and records deferred, attempting nothing", async () => {
    let called = 0;
    const s = build({
      probes: [ON_BATTERY],
      invoke: async (job) => {
        called += 1;
        return done(job.name);
      },
    });
    const summary = await s.runOnce();
    expect(summary.outcome).toBe("deferred");
    expect(called).toBe(0);
    // The refusal is DISCLOSED, not silent: a deferred run row records the host state that
    // caused it, which is the only way an owner can tell "never ran" from "kept deferring".
    expect(summary.runId).not.toBeNull();
    expect(runRow(requireRunId(summary))).toMatchObject({
      outcome: "deferred",
      jobs_attempted: 0,
      // Nothing was assessed for dueness, so nothing may be reported as not-due.
      jobs_skipped_not_due: 0,
    });
    expect(store.listBriefs({ limit: 10, now: NOW })).toHaveLength(0);
  });

  test("yields at a job boundary when the user returns mid-run", async () => {
    // Probe 1 admits the run; probe 2 (between jobs) shows the user back.
    const s = build({ probes: [AC_IDLE, ON_BATTERY], invoke: async (job) => done(job.name) });
    const summary = await s.runOnce();
    expect(summary.outcome).toBe("yielded");
    expect(summary.jobsCompleted).toBe(1);
    expect(summary.jobsUnattempted).toBe(1);
    // Stopped at a boundary, not mid-brief: the one completed job's brief is intact and there is
    // no second, partial row.
    expect(store.listBriefs({ limit: 10, now: NOW }).map((b) => b.jobId)).toEqual(["a"]);
  });

  test("a failing job backs off and the run continues", async () => {
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) =>
        job.name === "a" ? { status: "failed", error: "boom" } : done(job.name),
    });
    const summary = await s.runOnce();
    expect(summary.outcome).toBe("completed");
    expect(summary.jobsAttempted).toBe(2);
    expect(summary.jobsCompleted).toBe(1);
    expect(store.loadJobState("a")?.consecutiveFailures).toBe(1);
    expect(store.loadJobState("a")?.backoffUntil).toBeGreaterThan(NOW);
    expect(store.loadJobState("a")?.lastError).toBe("boom");
    // The failure is isolated: the later job still produced its brief.
    expect(store.listBriefs({ limit: 10, now: NOW }).map((b) => b.jobId)).toEqual(["b"]);
  });

  test("a job that ran within its interval is NOT due", async () => {
    // Without this check the 60-second tick reruns every job every minute: a daily job would
    // produce 60 briefs an hour all night, and `interval_seconds` would be parsed and never read.
    store.recordJobSuccess("a", NOW - 500); // 0.5 s ago; interval is 1 s
    const ran: string[] = [];
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    const summary = await s.runOnce();
    expect(ran).toEqual(["b"]);
    expect(summary.jobsAttempted).toBe(1);
    // "not due" is NOT "unattempted": job `a` was never going to run this tick, so reporting it as
    // unattempted would make an ordinary tick read as a run that gave up on a job.
    expect(summary.jobsSkippedNotDue).toBe(1);
    expect(summary.jobsUnattempted).toBe(0);
    // And it is PERSISTED, not just returned: the summary object is gone the moment `runOnce`
    // returns, so a `nimbus fleet status` reading history from SQLite must see the same number.
    expect(runRow(requireRunId(summary))).toMatchObject({
      outcome: "completed",
      jobs_attempted: 1,
      jobs_completed: 1,
      jobs_skipped_not_due: 1,
    });
    // A not-due job must not leave a brief behind either — the counter and the table must agree.
    expect(store.listBriefs({ limit: 10, now: NOW }).map((b) => b.jobId)).toEqual(["b"]);
  });

  test("not-due and stopped-short are reported as DISTINCT numbers", async () => {
    // Three jobs, three different fates in one run: `a` is not due, `b` runs, and the re-probe
    // before `c` shows the user back so the run yields with `c` never attempted.
    //
    // This is the test that fails if the two are conflated: summing them gives
    // jobsUnattempted === 2, which reads as "the fleet was stopped before it got to two jobs" when
    // only ONE job was actually cut short. The spec calls a run that under-reports what it was
    // configured for a disclosure failure; over-reporting what it abandoned is the same failure.
    const jobs: readonly NimbusFleetJobToml[] = [
      {
        name: "a",
        agent: "catchup",
        intervalSeconds: 1,
        params: {},
        digestMinDelta: 1,
        sweep: null,
      },
      {
        name: "b",
        agent: "ownership",
        intervalSeconds: 1,
        params: {},
        digestMinDelta: 1,
        sweep: null,
      },
      {
        name: "c",
        agent: "impact",
        intervalSeconds: 1,
        params: {},
        digestMinDelta: 1,
        sweep: null,
      },
    ];
    store.recordJobSuccess("a", NOW); // not due: zero elapsed against a 1 s interval
    const ran: string[] = [];
    const s = build({
      jobs,
      probes: [AC_IDLE, ON_BATTERY],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    const summary = await s.runOnce();
    expect(ran).toEqual(["b"]);
    expect(summary.outcome).toBe("yielded");
    expect(summary.jobsAttempted).toBe(1);
    expect(summary.jobsCompleted).toBe(1);
    expect(summary.jobsSkippedNotDue).toBe(1); // a
    expect(summary.jobsUnattempted).toBe(1); // c — and NOT 2
    // The distinction survives into the row a later reader will see, not only into the summary.
    expect(runRow(requireRunId(summary))).toMatchObject({
      outcome: "yielded",
      jobs_attempted: 1,
      jobs_completed: 1,
      jobs_skipped_not_due: 1,
    });
  });

  test("a job whose interval has elapsed is due again", async () => {
    // The inverse control for the test above: a due check that refused EVERYTHING would satisfy
    // that one and fail this one, so the pair pins the predicate from both sides.
    store.recordJobSuccess("a", NOW - 5_000); // 5 s ago; interval is 1 s
    const ran: string[] = [];
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    await s.runOnce();
    expect(ran).toEqual(["a", "b"]);
  });

  test("a second tick while a run is in flight is refused, not run concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20);
        concurrent -= 1;
        return done(job.name);
      },
    });
    // A run can outlast the 60 s tick — a cold `ownership` + `impact` with synthesis easily does.
    const [first, second] = await Promise.all([s.runOnce(), s.runOnce()]);
    expect(maxConcurrent).toBe(1);
    expect([first.outcome, second.outcome].sort()).toEqual(["completed", "deferred"]);
    expect([first.runId, second.runId]).toContain(null); // the refused one opened no run row
    // The refused tick evaluated nothing for dueness, so it must claim no not-due skips.
    const refused = first.runId === null ? first : second;
    expect(refused.jobsUnattempted).toBe(2);
    expect(refused.jobsSkippedNotDue).toBe(0);
    // Exactly ONE `fleet_run` row exists. Without the guard the second tick opens its own row and
    // interleaves its writes with the first — the counter check alone would not see that.
    const runs = db.query(`SELECT COUNT(*) AS n FROM fleet_run`).get() as { n: number };
    expect(runs.n).toBe(1);
    expect(store.listBriefs({ limit: 10, now: NOW })).toHaveLength(2);
  });

  test("the in-flight guard is released after a run, so the next tick proceeds", async () => {
    // A guard that latches is as broken as no guard: the fleet would run exactly once per boot.
    const s = build({ probes: [AC_IDLE], invoke: async (job) => done(job.name) });
    await s.runOnce();
    const second = await s.runOnce({ force: true });
    expect(second.outcome).toBe("completed");
    expect(second.runId).not.toBeNull();
  });

  test("a throwing invoker closes the run as failed and releases the guard", async () => {
    // The invoker CONTRACT returns `{ status: "failed" }`, so a throw means something below it
    // broke that contract. The run row must still be closed: an `outcome` left NULL reads as
    // "still running" forever, and a latched `inFlight` would wedge the fleet until the next boot.
    let boom = true;
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        if (boom) {
          boom = false;
          throw new Error("invoker exploded");
        }
        return done(job.name);
      },
    });
    await expect(s.runOnce()).rejects.toThrow(/invoker exploded/);
    const failed = db
      .query(`SELECT COUNT(*) AS n FROM fleet_run WHERE outcome = 'failed'`)
      .get() as {
      n: number;
    };
    expect(failed.n).toBe(1);

    const after = await s.runOnce({ force: true });
    expect(after.runId).not.toBeNull();
    expect(after.outcome).toBe("completed");
  });

  // in_scope - attempted - skipped_not_due === unattempted, on all three outcomes. That identity
  // is the property worth pinning, more than any single field: it is what lets a human read a
  // fleet_run row months later and answer "how many jobs did not get to run" without the config
  // that produced it — which by then may have been edited. One test per outcome rather than three
  // runs in one body, because a run leaves `fleet_job_state` behind and a later run in the same
  // database would be judged against the earlier one's successes.
  const THREE_JOBS: readonly NimbusFleetJobToml[] = [
    { name: "a", agent: "catchup", intervalSeconds: 1, params: {}, digestMinDelta: 1, sweep: null },
    {
      name: "b",
      agent: "ownership",
      intervalSeconds: 1,
      params: {},
      digestMinDelta: 1,
      sweep: null,
    },
    { name: "c", agent: "impact", intervalSeconds: 1, params: {}, digestMinDelta: 1, sweep: null },
  ];

  test("a COMPLETED run's row is self-describing", async () => {
    const summary = await build({
      probes: [AC_IDLE],
      invoke: async (job) => done(job.name),
    }).runOnce();
    expect(summary.outcome).toBe("completed");
    expect(summary.jobsUnattempted).toBe(0);
    expect(expectRowIsSelfDescribing(summary)).toMatchObject({
      jobs_in_scope: 2,
      jobs_attempted: 2,
      jobs_skipped_not_due: 0,
    });
  });

  test("a YIELDED run's row is self-describing, with a not-due job in the mix", async () => {
    store.recordJobSuccess("a", NOW); // `a` not due; `c` cut off by the mid-run re-probe
    const summary = await build({
      jobs: THREE_JOBS,
      probes: [AC_IDLE, ON_BATTERY],
      invoke: async (job) => done(job.name),
    }).runOnce();
    expect(summary.outcome).toBe("yielded");
    expect(summary.jobsUnattempted).toBe(1);
    expect(expectRowIsSelfDescribing(summary)).toMatchObject({
      jobs_in_scope: 3,
      jobs_attempted: 1,
      jobs_skipped_not_due: 1,
    });
  });

  test("a DEFERRED run's row is self-describing — the case that motivated jobs_in_scope", async () => {
    // Attempted 0, skipped 0, and before `jobs_in_scope` no record whatsoever of how many jobs were
    // waiting behind the refusal: the row could not tell "nothing configured" from "three jobs, all
    // held". This is the read a human makes after a night on battery.
    const summary = await build({
      jobs: THREE_JOBS,
      probes: [ON_BATTERY],
      invoke: async (job) => done(job.name),
    }).runOnce();
    expect(summary.outcome).toBe("deferred");
    expect(summary.jobsUnattempted).toBe(3);
    expect(expectRowIsSelfDescribing(summary)).toMatchObject({
      jobs_in_scope: 3,
      jobs_attempted: 0,
      jobs_skipped_not_due: 0,
    });
  });

  test("a close() failure does not mask the error that failed the run", async () => {
    // `close()` writes to SQLite and can itself throw. If it did, its error would REPLACE the one
    // that actually broke the run and the diagnosis would be lost — the row ends up unclosed
    // either way, so masking the cause buys nothing. Here the table is dropped mid-run so the
    // `UPDATE fleet_run` in `close("failed")` fails; the caller must still see `invoker exploded`.
    const s = build({
      probes: [AC_IDLE],
      invoke: async () => {
        db.run("DROP TABLE fleet_brief");
        db.run("DROP TABLE fleet_run");
        throw new Error("invoker exploded");
      },
    });
    await expect(s.runOnce()).rejects.toThrow(/invoker exploded/);
  });

  test("runOnce({ jobName }) runs only that job", async () => {
    const ran: string[] = [];
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    await s.runOnce({ jobName: "b", force: true });
    expect(ran).toEqual(["b"]);
  });

  test("an unknown jobName throws rather than running everything", async () => {
    let called = 0;
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        called += 1;
        return done(job.name);
      },
    });
    await expect(s.runOnce({ jobName: "nope" })).rejects.toThrow(/no such fleet job/);
    expect(called).toBe(0);
  });

  test("a job inside its backoff window is skipped", async () => {
    store.recordJobFailure("a", NOW, "boom"); // backoff ends 1h later
    const ran: string[] = [];
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    await s.runOnce();
    expect(ran).toEqual(["b"]);
  });

  test("force runs on battery — admission is what it overrides", async () => {
    let called = 0;
    const s = build({
      probes: [ON_BATTERY],
      invoke: async (job) => {
        called += 1;
        return done(job.name);
      },
    });
    const summary = await s.runOnce({ force: true });
    expect(called).toBe(2);
    expect(summary.outcome).toBe("completed");
  });

  test("force does NOT override the interval or the backoff — its scope is admission only", async () => {
    store.recordJobSuccess("a", NOW); // not due
    store.recordJobFailure("b", NOW, "boom"); // inside its backoff
    const ran: string[] = [];
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        ran.push(job.name);
        return done(job.name);
      },
    });
    const summary = await s.runOnce({ force: true });
    expect(ran).toEqual([]);
    expect(summary.jobsSkippedNotDue).toBe(2);
  });

  // The schedule bypass keys on NAMING a job, not on `--force`. Two triggers, two scopes: a person
  // asking for one job by name has made the scheduling decision themselves, while `--force` speaks
  // only to host admission. A scheduled tick passes neither and is bound by both.
  describe("naming a job bypasses the schedule, a tick does not", () => {
    test("a named run of a not-yet-due job RUNS", async () => {
      store.recordJobSuccess("a", NOW); // ran this instant; interval_seconds = 1
      const ran: string[] = [];
      const s = build({
        probes: [AC_IDLE],
        invoke: async (job) => {
          ran.push(job.name);
          return done(job.name);
        },
      });
      const summary = await s.runOnce({ jobName: "a" });
      expect(ran).toEqual(["a"]);
      expect(summary.jobsAttempted).toBe(1);
      expect(summary.jobsSkippedNotDue).toBe(0);
    });

    test("a named run of a job inside its backoff RUNS", async () => {
      store.recordJobFailure("b", NOW, "boom"); // backoff armed, expires in the future
      const ran: string[] = [];
      const s = build({
        probes: [AC_IDLE],
        invoke: async (job) => {
          ran.push(job.name);
          return done(job.name);
        },
      });
      const summary = await s.runOnce({ jobName: "b" });
      expect(ran).toEqual(["b"]);
      expect(summary.jobsAttempted).toBe(1);
      expect(summary.jobsSkippedNotDue).toBe(0);
    });

    test("a scheduled tick runs NEITHER — both are still held by the schedule", async () => {
      store.recordJobSuccess("a", NOW); // not due
      store.recordJobFailure("b", NOW, "boom"); // inside its backoff
      const ran: string[] = [];
      const s = build({
        probes: [AC_IDLE],
        invoke: async (job) => {
          ran.push(job.name);
          return done(job.name);
        },
      });
      const summary = await s.runOnce();
      expect(ran).toEqual([]);
      expect(summary.jobsAttempted).toBe(0);
      expect(summary.jobsSkippedNotDue).toBe(2);
    });

    test("a named run still records its outcome, so backoff re-arms for the scheduled path", async () => {
      store.recordJobFailure("b", NOW, "boom");
      const s = build({
        probes: [AC_IDLE],
        invoke: async () => ({ status: "failed", error: "boom again" }) as const,
      });
      await s.runOnce({ jobName: "b" });
      const state = store.loadJobState("b");
      expect(state?.consecutiveFailures).toBe(2);
      // And the scheduled path is still refused by that re-armed backoff.
      const ran: string[] = [];
      const s2 = build({
        probes: [AC_IDLE],
        invoke: async (job) => {
          ran.push(job.name);
          return done(job.name);
        },
      });
      const tick = await s2.runOnce();
      expect(ran).toEqual(["a"]);
      expect(tick.jobsSkippedNotDue).toBe(1);
    });
  });

  // Boot-only pruning left `fleet_run` growing one row per 60-second tick between restarts — every
  // tick opens a row before admission is even checked, so ~1,440 a day on an enabled fleet and
  // ~43,000 on a gateway up a month, none of them collected until the next restart.
  describe("a run prunes past-retention rows at its own end, not only at boot", () => {
    const staleRun = (): string =>
      store.openRun({
        startedAt: NOW - 30 * 86_400_000, // 30 days back, well outside a 14-day window
        hostPower: "ac",
        hostIdleMs: 0,
        hostSource: "measured",
        remoteCallBudget: 0,
      });
    const runCount = (id: string): number =>
      (db.query(`SELECT COUNT(*) AS n FROM fleet_run WHERE id = ?`).get(id) as { n: number }).n;

    test("a completed run collects them, and does not collect itself", async () => {
      const stale = staleRun();
      const s = build({
        probes: [AC_IDLE],
        invoke: async (job) => done(job.name),
        config: { retentionDays: 14 },
      });
      const summary = await s.runOnce();
      expect(runCount(stale)).toBe(0);
      expect(runRow(requireRunId(summary)).outcome).toBe("completed");
    });

    test("a DEFERRED run collects them too — it opened a row like any other", async () => {
      const stale = staleRun();
      const s = build({
        probes: [ON_BATTERY],
        invoke: async (job) => done(job.name),
        config: { retentionDays: 14 },
      });
      const summary = await s.runOnce();
      expect(summary.outcome).toBe("deferred");
      expect(runCount(stale)).toBe(0);
    });

    test("a run INSIDE the window survives — the prune is a window, not a truncation", async () => {
      const recent = store.openRun({
        startedAt: NOW - 86_400_000, // yesterday
        hostPower: "ac",
        hostIdleMs: 0,
        hostSource: "measured",
        remoteCallBudget: 0,
      });
      const s = build({
        probes: [AC_IDLE],
        invoke: async (job) => done(job.name),
        config: { retentionDays: 14 },
      });
      await s.runOnce();
      expect(runCount(recent)).toBe(1);
    });
  });

  test("a disabled capability refuses even with force", async () => {
    const s = new FleetScheduler({
      store,
      jobs: JOBS,
      config: { ...DEFAULT_FLEET_CONFIG, enabled: true },
      capabilityDisabled: true,
      hostActivity: { probe: async () => AC_IDLE },
      invoke: async (job) => done(job.name),
      now: () => 1,
      // Refused before any run opens, so nothing here reads the budget — the default cap is the
      // honest value rather than a number this test would be implying something about.
      remoteBudget: createFleetRemoteBudget(false, 0),
    });
    await expect(s.runOnce({ force: true })).rejects.toThrow(/org policy/);
    const runs = db.query(`SELECT COUNT(*) AS n FROM fleet_run`).get() as { n: number };
    expect(runs.n).toBe(0);
  });

  test("a disabled config refuses before it probes anything", async () => {
    let probed = 0;
    const s = new FleetScheduler({
      store,
      jobs: JOBS,
      config: DEFAULT_FLEET_CONFIG, // enabled: false
      capabilityDisabled: false,
      hostActivity: {
        probe: async (): Promise<HostActivityProbe> => {
          probed += 1;
          return AC_IDLE;
        },
      },
      invoke: async (job) => done(job.name),
      now: () => 1,
      // Refused before any run opens, so nothing here reads the budget — the default cap is the
      // honest value rather than a number this test would be implying something about.
      remoteBudget: createFleetRemoteBudget(false, 0),
    });
    await expect(s.runOnce()).rejects.toThrow(/disabled/);
    expect(probed).toBe(0);
  });

  test("records the run's remote spend against its budget", async () => {
    // A REAL `FleetRemoteBudget`, spent through its own `consume()`, not a fake counter. The
    // scheduler's job here is to report what the budget says, and a fake would let the two agree on
    // a contract the real object does not have.
    const budget = createFleetRemoteBudget(true, 4);
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => {
        budget.consume(); // this job's brief synthesised through a granted remote provider
        return done(job.name);
      },
      config: { allowRemote: true, remoteCallBudget: 4 },
      remoteBudget: budget,
    });
    const summary = await s.runOnce();
    expect(summary.runId).not.toBeNull();
    expect(runRow(requireRunId(summary)).remote_calls_made).toBe(2); // one per job in JOBS
    expect(recordedBudget(requireRunId(summary))).toBe(4);
  });

  test("two consecutive runs EACH get the full budget — the cap is per RUN, not per process", async () => {
    // `[fleet] remote_call_budget` is documented per run, and `platform/assemble.ts` builds ONE
    // budget for the process, so without the run-boundary reset a cap of 2 would mean two remote
    // calls for the gateway's entire lifetime: run 1 spends both, run 2 gets none, and a machine up
    // for a week gets two in total. Each job here spends until the budget refuses, so the count IS
    // the cap the run actually had.
    const budget = createFleetRemoteBudget(true, 2);
    const s = build({
      probes: [AC_IDLE],
      jobs: [JOBS[0] as NimbusFleetJobToml],
      invoke: async (job) => {
        while (budget.consume());
        return done(job.name);
      },
      config: { allowRemote: true, remoteCallBudget: 2 },
      remoteBudget: budget,
    });
    // Named rather than forced: naming a job is what bypasses the schedule, so the second run is
    // not refused as not-due by the first run's success. `--force` would not have helped here — its
    // scope is host admission, and these probes admit already.
    const first = await s.runOnce({ jobName: "a" });
    const second = await s.runOnce({ jobName: "a" });
    expect(runRow(requireRunId(first)).remote_calls_made).toBe(2);
    // The load-bearing one: without the reset this is 0, and the run row would still claim a budget
    // of 2 it never had.
    expect(runRow(requireRunId(second)).remote_calls_made).toBe(2);
    expect(recordedBudget(requireRunId(second))).toBe(2);
  });

  test("the recorded budget is the EFFECTIVE cap, not the raw config number", async () => {
    // The parser refuses `allow_remote = true` with no budget, but accepts the opposite pairing —
    // so `allow_remote = false, remote_call_budget = 5` is legal config, and
    // `createFleetRemoteBudget` clamps its cap to 0. Recording the config number would have the row
    // claim a budget of 5 on a run that could not spend a single call of it.
    const budget = createFleetRemoteBudget(false, 5);
    const s = build({
      probes: [AC_IDLE],
      invoke: async (job) => done(job.name),
      config: { allowRemote: false, remoteCallBudget: 5 },
      remoteBudget: budget,
    });
    expect(recordedBudget(requireRunId(await s.runOnce()))).toBe(0);
  });

  test("allow_remote = false records 0 because the REAL gate refused, not because nothing is wired", async () => {
    // "0" is the value a missing dep also produces, so the assertion is only worth anything with the
    // real I38 pieces in the loop: a real `createFleetRemoteBudget`, a real
    // `wrapFleetSynthesisRouter`, and a real non-local provider handed to it. The positive control
    // below runs the IDENTICAL harness with `allow_remote = true` and must record 2 — without it,
    // this test would pass for a scheduler that persists a hardcoded zero.
    const remote = { providerId: "anthropic", modelName: "opus", isLocal: false };
    const runWith = async (allowRemote: boolean, cap: number, suffix: string): Promise<number> => {
      const budget = createFleetRemoteBudget(allowRemote, cap);
      const router = wrapFleetSynthesisRouter(
        {
          resolveForSynthesis: async () => remote,
          generateMarkdown: async () => "md",
        },
        budget,
      );
      const s = build({
        probes: [AC_IDLE],
        // Per-arm job NAMES, because both arms share the module-level store: reusing them would
        // leave the second arm's jobs not-due from the first, attempting nothing, and make the
        // positive control read 0 for a reason that has nothing to do with the budget. (Neither
        // `--force` nor a job name fixes that here — `--force` no longer touches the schedule, and
        // a named run would only run one of the two jobs the positive control counts.)
        jobs: JOBS.map((j) => ({ ...j, name: `${j.name}-${suffix}` })),
        invoke: async (job) => {
          // What a fleet job's synthesis does: resolve, then generate if anything was resolved.
          const p = await router.resolveForSynthesis(true);
          if (p !== undefined) await router.generateMarkdown("prompt", p);
          return done(job.name);
        },
        config: { allowRemote, remoteCallBudget: cap },
        remoteBudget: budget,
      });
      return runRow(requireRunId(await s.runOnce())).remote_calls_made;
    };
    expect(await runWith(false, 0, "off")).toBe(0);
    expect(await runWith(true, 4, "on")).toBe(2); // positive control: the same harness DOES count
  });
});

describe("FleetScheduler.start/stop", () => {
  test("start() ticks the loop and stop() halts it", async () => {
    let probed = 0;
    const s = build({
      probes: [ON_BATTERY], // defers immediately: the tick is what is under test, not the work
      invoke: async (job) => done(job.name),
      tickMs: 5,
      onProbe: () => {
        probed += 1;
      },
    });
    s.start();
    await sleep(60);
    const afterStart = probed;
    expect(afterStart).toBeGreaterThan(0);
    s.stop();
    await sleep(40);
    expect(probed).toBe(afterStart);
  });

  test("start() is idempotent — a second call installs no second interval", async () => {
    // The assertion that makes this real: if `start()` installed a second timer, `stop()` would
    // clear only the most recent one and the first would keep probing forever.
    let probed = 0;
    const s = build({
      probes: [ON_BATTERY],
      invoke: async (job) => done(job.name),
      tickMs: 5,
      onProbe: () => {
        probed += 1;
      },
    });
    s.start();
    s.start();
    s.stop();
    await sleep(50);
    expect(probed).toBe(0);
  });

  test("stop() before start() is a no-op, and the default tick installs cleanly", () => {
    // No `tickMs`, so this exercises the production `DEFAULT_TICK_MS` arm. A 60 s interval will
    // not fire inside the test; `unref` is what keeps it from holding the runner open. Exercising
    // the arm proves nothing about the VALUE, and a regression to 60 ms would turn the fleet into
    // a hot loop while every test here stayed green — so assert the constant outright.
    expect(DEFAULT_TICK_MS).toBe(60_000);
    const s = build({ probes: [AC_IDLE], invoke: async (job) => done(job.name) });
    expect(() => s.stop()).not.toThrow();
    s.start();
    expect(() => s.stop()).not.toThrow();
  });

  test("a tick whose run rejects is swallowed, not left as an unhandled rejection", async () => {
    // `runOnce` throws on the disabled arms, and a timer callback has no caller to catch for it.
    // An unhandled rejection from the fleet timer would take the whole gateway process down —
    // over an optional, default-off feature.
    let rejections = 0;
    const onRejection = (): void => {
      rejections += 1;
    };
    process.on("unhandledRejection", onRejection);
    const s = new FleetScheduler({
      store,
      jobs: JOBS,
      config: { ...DEFAULT_FLEET_CONFIG, enabled: true },
      capabilityDisabled: true, // every tick rejects
      hostActivity: { probe: async () => AC_IDLE },
      invoke: async (job) => done(job.name),
      now: () => NOW,
      tickMs: 5,
      remoteBudget: createFleetRemoteBudget(false, 0),
    });
    s.start();
    await sleep(40);
    s.stop();
    process.off("unhandledRejection", onRejection);
    expect(rejections).toBe(0);
  });
});
