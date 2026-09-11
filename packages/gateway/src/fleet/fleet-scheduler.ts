import type { NimbusFleetJobToml, NimbusFleetToml } from "../config/fleet-toml.ts";
import type { HostActivity, HostActivityProbe } from "../platform/host-activity.ts";
import type { AdmissionVerdict } from "./fleet-admission.ts";
import { admitFleetRun } from "./fleet-admission.ts";
import type { FleetInvoker } from "./fleet-invoker.ts";
import type { FleetJobState, FleetRunOutcome, FleetStore } from "./fleet-store.ts";

/**
 * The `AI_V2_CAPABILITIES` member (`policy/types.ts`) an org policy disables to turn the fleet off
 * gateway-wide (I22). Exported so a test can pin it against that frozen list rather than repeating
 * the string — a typo here would read as "never disabled", which is the direction that fails open.
 */
export const FLEET_CAPABILITY = "agent_fleet";

/** The local `[fleet] enabled` kill-switch, or the org-policy lockoff (I22). */
export class FleetDisabledError extends Error {}

/**
 * A `jobName` that matches nothing. Deliberately NOT a `FleetDisabledError`: nothing is disabled,
 * the caller mistyped, and a consumer mapping errors to exit codes or RPC codes needs to tell
 * "the owner turned this off" apart from "that job does not exist".
 */
export class FleetJobNotFoundError extends Error {}

export interface FleetRunSummary {
  /** `null` when no `fleet_run` row was opened — the run was refused before any work began. */
  readonly runId: string | null;
  readonly outcome: FleetRunOutcome;
  readonly jobsAttempted: number;
  readonly jobsCompleted: number;
  /**
   * In scope and did not run, having NOT been classified as not-due — the yield and abandon cases.
   *
   * A job that was simply not scheduled yet is NOT counted here; it is `jobsSkippedNotDue`. The
   * two are different facts and a human acts differently on each: "the fleet was stopped before it
   * got to 2 jobs" is a reason to look at the machine, "2 jobs are not due yet" is the scheduler
   * working exactly as configured. Folding them together makes every ordinary tick on a
   * daily-interval fleet look like a run that gave up — a disclosure failure wearing the shape of
   * a smaller number, which is precisely what this counter exists to avoid.
   *
   * NOTE FOR AN AGGREGATOR: on a `deferred` run this is `jobs.length`, every time. A deferred run
   * is refused BEFORE any job is assessed for dueness, so no job can be classified as not-due and
   * every job in scope genuinely did not run — `jobs.length` is the honest number, not a fallback.
   * The consequence is that this field is not directly comparable across a deferred run and a
   * completed one: averaging the two averages two different meanings. Nothing in this codebase
   * aggregates these rows today; whoever first does must bucket by `outcome`.
   */
  readonly jobsUnattempted: number;
  /** In scope but outside its `interval_seconds` or inside its backoff. Not a failure. */
  readonly jobsSkippedNotDue: number;
}

/**
 * `jobName?: string | undefined` rather than `jobName?: string`, because the repo compiles with
 * `exactOptionalPropertyTypes: true` and the RPC caller forwards an optional param straight
 * through (`{ jobName: params.job }`, where `params.job` may legitimately be undefined). The
 * alternative is every caller rebuilding the object conditionally to express "no job named".
 */
export interface FleetRunOptions {
  readonly force?: boolean | undefined;
  readonly jobName?: string | undefined;
}

/**
 * The budget surface the SCHEDULER needs: reset it at the run boundary, then report what the run
 * had and what it spent.
 *
 * Deliberately a STRUCTURAL SUBSET of `FleetRemoteBudget` rather than that type itself, the same
 * technique `SynthesisRouter` uses over `LlmRouter`. `consume()` is the INVOKER's capability —
 * spending is what the wrapped synthesis router does behind I38's two doors — and a scheduler able
 * to spend the fleet's remote budget is a capability nothing needs and no reader would expect. A
 * real `FleetRemoteBudget` satisfies this by structure, so production passes the one instance and
 * the narrowing costs nothing.
 */
export interface FleetRunBudget {
  reset(): void;
  spent(): number;
  remaining(): number;
}

export interface FleetSchedulerDeps {
  readonly store: FleetStore;
  readonly jobs: readonly NimbusFleetJobToml[];
  readonly config: NimbusFleetToml;
  /** `EnforcedPolicy.capabilitiesDisabled.has("agent_fleet")`, resolved by the caller (I22). */
  readonly capabilityDisabled: boolean;
  readonly hostActivity: HostActivity;
  readonly invoke: FleetInvoker;
  readonly now: () => number;
  /**
   * The SAME `FleetRemoteBudget` instance the invoker caps against (I38) — production passes the
   * one object `platform/assemble.ts` constructs, so the run boundary this scheduler owns and the
   * spending the invoker does are the same accounting.
   *
   * REQUIRED, and that is the point. It was optional, this call site did not pass it, and both
   * `fleet_run.remote_calls_made` and `remote_call_budget` then recorded numbers that were wrong on
   * every production run. An optional dep whose absence produces a silently wrong PERSISTED value
   * needs a compile error, not a test — the same reasoning `closeRun`'s parameters are required
   * for. A scheduler with no budget to account against is not a thing this type admits: an
   * `allow_remote = false` fleet still has a budget, it is just clamped to 0.
   */
  readonly remoteBudget: FleetRunBudget;
  /** Test seam only. Production leaves it at `DEFAULT_TICK_MS`. */
  readonly tickMs?: number | undefined;
}

export const DEFAULT_TICK_MS = 60_000;

/**
 * Whether a job is due: past its backoff, and at least `interval_seconds` since its last SUCCESS.
 *
 * Keyed on `lastSuccessAt`, not `lastAttemptAt`: a job that failed should be retried when its
 * backoff expires, not held off for a full interval on top. A job that has never succeeded is due.
 *
 * Without this the 60-second tick reruns every job every minute — a daily job producing 60 briefs
 * an hour all night, and `interval_seconds` parsed by the config layer and read by nothing.
 */
export function isJobDue(
  job: NimbusFleetJobToml,
  state: FleetJobState | undefined,
  now: number,
): boolean {
  if (state?.backoffUntil != null && state.backoffUntil > now) return false;
  if (state?.lastSuccessAt == null) return true;
  return now - state.lastSuccessAt >= job.intervalSeconds * 1000;
}

export class FleetScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Re-entrancy guard. `start()` ticks every 60 s, and a real run — a cold `ownership` plus an
   * `impact` with synthesis — routinely takes minutes. Without this, tick N+1 opens a second
   * `fleet_run`, interleaves its writes with the first, and puts two jobs on the local model at
   * once: the exact concurrency the sequential invoker exists to prevent, reintroduced one level
   * up. It is set and cleared around a single `await` in `runOnce`, so no caller can observe it
   * half-applied, and the `finally` clears it on the throwing path too.
   */
  private inFlight = false;

  constructor(private readonly deps: FleetSchedulerDeps) {}

  start(): void {
    if (this.timer !== undefined) return;
    // `unref` so a pending tick never holds the process open — a hung fleet timer would make
    // `bun test` and a clean gateway shutdown hang identically.
    this.timer = setInterval(
      () => void this.runOnce().catch(() => undefined),
      this.deps.tickMs ?? DEFAULT_TICK_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass. TWO different bypasses, with two different triggers — they are not interchangeable
   * and neither widens into the other:
   *
   * - NAMING a job (`opts.jobName`) skips the SCHEDULE: both `interval_seconds` and the failure
   *   backoff. A person typing `nimbus fleet run morning-catchup` has asked for that one job, once.
   *   Backoff exists to stop an UNATTENDED loop hammering a failing job; it is not there to refuse
   *   a human's explicit single request. The run still records its outcome, so backoff re-arms for
   *   the scheduled path exactly as before.
   * - `force` skips ADMISSION ONLY — the idle/power checks, which exist to protect the user's
   *   machine and which an owner typing the command is by definition present to override.
   *
   * Neither skips the config kill-switch, the org-policy lockoff, agent eligibility (resolved
   * inside the invoker) or I38's remote budget (enforced by the wrapped synthesis router).
   */
  async runOnce(opts?: FleetRunOptions): Promise<FleetRunSummary> {
    // Ordering mirrors I33: local kill-switch, then org policy, BOTH before any work — so a
    // disabled capability never advertises itself by probing hardware or opening a run row.
    if (!this.deps.config.enabled) {
      throw new FleetDisabledError("fleet is disabled ([fleet] enabled = false)");
    }
    if (this.deps.capabilityDisabled) {
      throw new FleetDisabledError("fleet is disabled by org policy");
    }

    const jobName = opts?.jobName;
    const jobs =
      jobName === undefined ? this.deps.jobs : this.deps.jobs.filter((j) => j.name === jobName);
    // Throws rather than running everything: `nimbus fleet run typo` must not become
    // "run every configured job", which is the worst possible reading of a typo.
    if (jobName !== undefined && jobs.length === 0) {
      throw new FleetJobNotFoundError(`no such fleet job: ${jobName}`);
    }

    if (this.inFlight) {
      return {
        runId: null,
        outcome: "deferred",
        jobsAttempted: 0,
        jobsCompleted: 0,
        // Nothing was evaluated for dueness, so nothing can be classified as not-due: every job in
        // scope is genuinely unattempted because another run held the lane.
        jobsUnattempted: jobs.length,
        jobsSkippedNotDue: 0,
      };
    }
    this.inFlight = true;
    try {
      return await this.execute(jobs, opts?.force === true, jobName !== undefined);
    } finally {
      this.inFlight = false;
    }
  }

  private admit(probe: HostActivityProbe): AdmissionVerdict {
    return admitFleetRun(probe, {
      requireAcPower: this.deps.config.requireAcPower,
      minIdleSeconds: this.deps.config.minIdleSeconds,
    });
  }

  /**
   * Re-probe BETWEEN jobs, not only at the start. Stopping at a boundary rather than mid-brief is
   * why the boundary exists: a half-written brief is worse than an absent one. The first job of a
   * run is exempt — `execute` already probed for it — and `--force` skips the check entirely.
   */
  private async stillAdmitted(attempted: number, force: boolean): Promise<boolean> {
    if (attempted === 0 || force) return true;
    const again = await this.deps.hostActivity.probe();
    return this.admit(again).admitted;
  }

  /**
   * One job's turn. Returns whether it COMPLETED — a failure is isolated, not fatal: a run that
   * aborted on the first bad config line would let one stale entry silence every other brief
   * indefinitely, and overnight nobody notices.
   */
  private async runOneJob(
    job: NimbusFleetJobToml,
    runId: string,
    expiresAt: number,
  ): Promise<boolean> {
    const outcome = await this.deps.invoke(job);
    if (outcome.status !== "done") {
      this.deps.store.recordJobFailure(job.name, this.deps.now(), outcome.error);
      return false;
    }
    this.deps.store.recordBrief({
      runId,
      jobId: job.name,
      agentMethod: `agents.${job.agent}`,
      briefMarkdown: outcome.briefMarkdown,
      findingsJson: outcome.findingsJson,
      synthesisJson: outcome.synthesisJson,
      createdAt: this.deps.now(),
      expiresAt,
    });
    this.deps.store.recordJobSuccess(job.name, this.deps.now());
    return true;
  }

  private async execute(
    jobs: readonly NimbusFleetJobToml[],
    force: boolean,
    /**
     * True when the caller NAMED a job. Skips the schedule (interval + backoff) for that one run.
     * Deliberately not `force`: the two bypasses have different triggers and different scopes, and
     * a scheduled tick never sets either.
     */
    namedJob: boolean,
  ): Promise<FleetRunSummary> {
    const probe = await this.deps.hostActivity.probe();
    const admitted = this.admit(probe).admitted;

    // The run boundary. `[fleet] remote_call_budget` is PER RUN, and one instance is shared with
    // the invoker for the process lifetime, so this is the line that makes the key mean what it
    // says. Before `openRun`, so the row records what this run actually HAS. Safe because
    // `runOnce`'s `inFlight` guard serialises every entry path — the tick, `--force` and a named
    // job all reach `execute` only through it — so no reset can land mid-run.
    this.deps.remoteBudget.reset();

    const startedAt = this.deps.now();
    const runId = this.deps.store.openRun({
      startedAt,
      hostPower: probe.power,
      hostIdleMs: probe.idleMs,
      hostSource: probe.source,
      // What the run HAS, read off the freshly reset budget — not the raw config value. The two
      // differ whenever `allow_remote = false`: `createFleetRemoteBudget` clamps the cap to 0,
      // while the parser happily accepts `remote_call_budget = 5` alongside it (it refuses only the
      // opposite pairing). Recording the config number there would have the row claim a budget the
      // run could not spend a single call of — which is why there is no `?? config.remoteCallBudget`
      // fallback here: a fallback to the wrong number is the false record with a longer fuse.
      remoteCallBudget: this.deps.remoteBudget.remaining(),
    });

    // ONE mutable tally, read by `close` rather than threaded through it as arguments. Every exit
    // (deferred, yielded, failed, completed) then reports the same numbers by construction — three
    // positional counters at four call sites is how one of them ends up stale on one path.
    const tally = { attempted: 0, completed: 0, skippedNotDue: 0 };

    const close = (outcome: FleetRunOutcome): FleetRunSummary => {
      this.deps.store.closeRun(runId, {
        endedAt: this.deps.now(),
        outcome,
        // Written on EVERY exit, the deferred path included — that is the case the row could not
        // previously describe at all: attempted 0, skipped 0, and no record of how many jobs were
        // waiting behind the refusal.
        jobsInScope: jobs.length,
        jobsAttempted: tally.attempted,
        jobsCompleted: tally.completed,
        jobsSkippedNotDue: tally.skippedNotDue,
        remoteCallsMade: this.deps.remoteBudget.spent(),
      });
      // Prune HERE as well as at boot, and on every exit including `deferred` — because every exit
      // opened a row. `openRun` runs before the admission check, so an enabled fleet writes one
      // `fleet_run` per 60-second tick whether or not any job ran: ~1,440 rows a day, ~43,000 on a
      // gateway up a month, all of them waiting on the next restart to be collected. Same window
      // as the boot prune (`config.retentionDays` is already policy-floored by
      // `assembleFleetRuntime` before the scheduler is constructed), and the same order — runs
      // first, so the FK cascade takes their briefs, then any brief that outlived its own run.
      this.deps.store.pruneRuns(this.deps.now() - this.deps.config.retentionDays * 86_400_000);
      this.deps.store.pruneBriefs(this.deps.now());
      return {
        runId,
        outcome,
        jobsAttempted: tally.attempted,
        jobsCompleted: tally.completed,
        // Not-due jobs are subtracted OUT: they were never going to run this tick, so counting
        // them as unattempted would report an ordinary tick as a run that gave up.
        jobsUnattempted: jobs.length - tally.attempted - tally.skippedNotDue,
        jobsSkippedNotDue: tally.skippedNotDue,
      };
    };

    if (!admitted && !force) return close("deferred");

    const expiresAt = startedAt + this.deps.config.retentionDays * 86_400_000;

    try {
      for (const job of jobs) {
        if (!(await this.stillAdmitted(tally.attempted, force))) return close("yielded");

        // Due check AND backoff, both inside `isJobDue`. NAMING a job (not `--force`) is what
        // overrides the schedule: an owner asking for one job by name has made the decision this
        // check exists to make on their behalf. It overrides neither the capability, nor
        // eligibility, nor I38's budget. `--force` deliberately does NOT reach here — its scope is
        // host admission, and a scheduled tick passes neither flag.
        if (!namedJob && !isJobDue(job, this.deps.store.loadJobState(job.name), this.deps.now())) {
          tally.skippedNotDue += 1;
          continue;
        }

        tally.attempted += 1;
        if (await this.runOneJob(job, runId, expiresAt)) tally.completed += 1;
      }
    } catch (err) {
      // The invoker CONTRACT returns `{ status: "failed" }` rather than throwing, so reaching here
      // means something below it broke its contract (or the store did). Close the row as `failed`
      // and rethrow: an abandoned run row keeps `outcome` NULL forever, which reads as "still
      // running" to every consumer and is the one state `nimbus fleet status` cannot recover from.
      // This is also the only writer of the `failed` outcome the schema already allows.
      //
      // Guarded: `close` writes to SQLite and can itself throw (a closed handle, a disk error). If
      // it did, its error would replace `err` and the ACTUAL cause of the run's failure would never
      // be seen — the row would be unclosed either way, so losing the diagnosis buys nothing.
      try {
        close("failed");
      } catch {
        // Deliberately swallowed: `err` below is the failure worth surfacing.
      }
      throw err;
    }

    return close("completed");
  }
}
