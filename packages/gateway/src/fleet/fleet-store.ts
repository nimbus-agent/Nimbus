import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { HostPower, HostProbeSource } from "../platform/host-activity.ts";

export type FleetRunOutcome = "completed" | "yielded" | "deferred" | "failed";

export interface FleetJobState {
  readonly jobId: string;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly consecutiveFailures: number;
  readonly backoffUntil: number | null;
  readonly lastError: string | null;
}

export interface FleetBriefRow {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly subjectKey: string;
  readonly agentMethod: string;
  readonly briefMarkdown: string | null;
  readonly findingsJson: string;
  readonly synthesisJson: string | null;
  readonly createdAt: number;
}

type FleetBriefDbRow = {
  id: string;
  run_id: string;
  job_id: string;
  subject_key: string;
  agent_method: string;
  brief_markdown: string | null;
  findings_json: string;
  synthesis_json: string | null;
  created_at: number;
};

function toBriefRow(r: FleetBriefDbRow): FleetBriefRow {
  return {
    id: r.id,
    runId: r.run_id,
    jobId: r.job_id,
    subjectKey: r.subject_key,
    agentMethod: r.agent_method,
    briefMarkdown: r.brief_markdown,
    findingsJson: r.findings_json,
    synthesisJson: r.synthesis_json,
    createdAt: r.created_at,
  };
}

/** 1h, 2h, 4h … capped at 24h. Capped because an uncapped doubling silently retires a job. */
const BACKOFF_BASE_MS = 60 * 60 * 1000;
const BACKOFF_CAP_MS = 24 * BACKOFF_BASE_MS;

export function backoffMsForFailures(consecutiveFailures: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

export class FleetStore {
  constructor(private readonly db: Database) {}

  openRun(r: {
    startedAt: number;
    hostPower: HostPower;
    hostIdleMs: number | null;
    hostSource: HostProbeSource;
    remoteCallBudget: number;
  }): string {
    const id = crypto.randomUUID();
    dbRun(
      this.db,
      `INSERT INTO fleet_run
         (id, started_at, host_power, host_idle_ms, host_source, remote_call_budget)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, r.startedAt, r.hostPower, r.hostIdleMs, r.hostSource, r.remoteCallBudget],
    );
    return id;
  }

  closeRun(
    runId: string,
    r: {
      endedAt: number;
      outcome: FleetRunOutcome;
      /**
       * How many jobs this run had in scope. With it the row is self-describing:
       * `jobsInScope - jobsAttempted - jobsSkippedNotDue` is the unattempted count, so a reader
       * needs no access to the config that produced the run.
       */
      jobsInScope: number;
      jobsAttempted: number;
      jobsCompleted: number;
      /**
       * REQUIRED, not optional-with-a-default: a caller that forgets must be a compile error, not
       * a run row that quietly claims nothing was skipped. Same for `jobsInScope` above — a silent
       * zero there would make every run look like it had nothing to do.
       */
      jobsSkippedNotDue: number;
      remoteCallsMade: number;
    },
  ): void {
    dbRun(
      this.db,
      `UPDATE fleet_run
          SET ended_at = ?, outcome = ?, jobs_in_scope = ?, jobs_attempted = ?,
              jobs_completed = ?, jobs_skipped_not_due = ?, remote_calls_made = ?
        WHERE id = ?`,
      [
        r.endedAt,
        r.outcome,
        r.jobsInScope,
        r.jobsAttempted,
        r.jobsCompleted,
        r.jobsSkippedNotDue,
        r.remoteCallsMade,
        runId,
      ],
    );
  }

  recordBrief(b: {
    runId: string;
    jobId: string;
    subjectKey: string;
    agentMethod: string;
    briefMarkdown: string | null;
    findingsJson: string;
    synthesisJson: string | null;
    createdAt: number;
    expiresAt: number;
  }): string {
    const id = crypto.randomUUID();
    dbRun(
      this.db,
      `INSERT INTO fleet_brief
         (id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json,
          synthesis_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        b.runId,
        b.jobId,
        b.subjectKey,
        b.agentMethod,
        b.briefMarkdown,
        b.findingsJson,
        b.synthesisJson,
        b.createdAt,
        b.expiresAt,
      ],
    );
    return id;
  }

  loadJobState(jobId: string): FleetJobState | undefined {
    const row = this.db
      .query(
        `SELECT job_id, last_attempt_at, last_success_at, consecutive_failures,
                backoff_until, last_error
           FROM fleet_job_state WHERE job_id = ?`,
      )
      .get(jobId) as {
      job_id: string;
      last_attempt_at: number | null;
      last_success_at: number | null;
      consecutive_failures: number;
      backoff_until: number | null;
      last_error: string | null;
    } | null;
    if (row === null) return undefined;
    return {
      jobId: row.job_id,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      consecutiveFailures: row.consecutive_failures,
      backoffUntil: row.backoff_until,
      lastError: row.last_error,
    };
  }

  recordJobSuccess(jobId: string, now: number): void {
    dbRun(
      this.db,
      `INSERT INTO fleet_job_state
         (job_id, last_attempt_at, last_success_at, consecutive_failures, backoff_until, last_error)
       VALUES (?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(job_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         consecutive_failures = 0, backoff_until = NULL, last_error = NULL`,
      [jobId, now, now],
    );
  }

  recordJobFailure(jobId: string, now: number, error: string): void {
    const failures = (this.loadJobState(jobId)?.consecutiveFailures ?? 0) + 1;
    dbRun(
      this.db,
      `INSERT INTO fleet_job_state
         (job_id, last_attempt_at, last_success_at, consecutive_failures, backoff_until, last_error)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = excluded.consecutive_failures,
         backoff_until = excluded.backoff_until,
         last_error = excluded.last_error`,
      [jobId, now, failures, now + backoffMsForFailures(failures), error],
    );
  }

  /**
   * `now` is REQUIRED, not defaulted to `Date.now()` internally: pruning runs at gateway boot
   * (`assembleFleetRuntime`) and at the end of each fleet RUN (`FleetScheduler`'s `close`), so on a
   * gateway whose fleet is disabled — or simply between runs — a brief past its `expires_at` can
   * still be sitting in the table and MUST be excluded here anyway — retention means
   * the brief is gone, and a read surface that still returns it makes retention a lie. A caller-
   * supplied clock (rather than an internal `Date.now()`) keeps this testable without a live clock
   * and matches every other timestamped method on this class (`pruneBriefs`, `recordJobSuccess`, …).
   */
  listBriefs(q: { limit: number; jobId?: string; now: number }): FleetBriefRow[] {
    const rows = (
      q.jobId === undefined
        ? this.db
            .query(
              `SELECT id, run_id, job_id, subject_key, agent_method, brief_markdown,
                      findings_json, synthesis_json, created_at
                 FROM fleet_brief WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(q.now, q.limit)
        : this.db
            .query(
              `SELECT id, run_id, job_id, subject_key, agent_method, brief_markdown,
                      findings_json, synthesis_json, created_at
                 FROM fleet_brief WHERE job_id = ? AND expires_at > ?
                 ORDER BY created_at DESC LIMIT ?`,
            )
            .all(q.jobId, q.now, q.limit)
    ) as ReadonlyArray<FleetBriefDbRow>;
    return rows.map(toBriefRow);
  }

  /**
   * A point lookup on the primary key — never a scan. `brief_markdown` can be tens of KB.
   *
   * `now` REQUIRED for the same reason as `listBriefs`: a lookup by id must not resurrect a brief
   * retention already decided to drop just because `pruneBriefs` has not run since it expired.
   */
  getBrief(id: string, now: number): FleetBriefRow | undefined {
    const row = this.db
      .query(
        `SELECT id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json,
                synthesis_json, created_at
           FROM fleet_brief WHERE id = ? AND expires_at > ?`,
      )
      .get(id, now) as FleetBriefDbRow | null;
    if (row === null) return undefined;
    return toBriefRow(row);
  }

  private static readonly BRIEF_COLS =
    `SELECT id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json,
            synthesis_json, created_at FROM fleet_brief `;

  /** One row or none, for a `WHERE …` fragment appended to the shared column list. */
  private queryOne(
    whereAndOrder: string,
    params: readonly (string | number)[],
  ): FleetBriefRow | undefined {
    const row = this.db
      .query(FleetStore.BRIEF_COLS + whereAndOrder)
      .get(...params) as FleetBriefDbRow | null;
    if (row === null) return undefined;
    return toBriefRow(row);
  }

  /**
   * The pair spec § 2.1 compares: the job's newest brief inside the window, and the newest brief
   * BEFORE the window — falling back to the oldest brief inside it when nothing precedes.
   *
   * "Newest before the window" rather than "immediately preceding" is what makes the digest report
   * the WINDOW's movement: for a job running hourly against a 24h window the naive rule compares
   * 23:00 against 22:00 and reports one hour under a heading that says twenty-four. It also keeps
   * a weekly job's predecessor a week old, since the query is not bounded below.
   *
   * `expires_at > now` on every arm, for the same reason `listBriefs` carries it: retention that a
   * read surface ignores is not retention.
   *
   * `jobIdsWithBriefsInWindow`, below, MUST agree with `current`'s `created_at <= now` bound — both
   * are read against the same window and both feed the same digest, so if one admits a future-dated
   * row and the other excludes it, a job lands in the union with no `current` this query can find,
   * and reports as `noBriefInWindow` for a job that in fact produced a brief.
   */
  briefPairForJob(q: { jobId: string; windowStartMs: number; now: number }): {
    current: FleetBriefRow | undefined;
    predecessor: FleetBriefRow | undefined;
  } {
    // `created_at <= now` is not redundant with `expires_at > now`: a future-dated row (an NTP
    // correction moving the clock backwards after a brief was written) has a future expiry too, so
    // it passes the retention filter and would be selected as `current` — reporting a brief from
    // outside the window as this window's newest.
    const current = this.queryOne(
      `WHERE job_id = ? AND created_at >= ? AND created_at <= ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [q.jobId, q.windowStartMs, q.now, q.now],
    );
    if (current === undefined) return { current: undefined, predecessor: undefined };
    const before = this.queryOne(
      `WHERE job_id = ? AND created_at < ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [q.jobId, q.windowStartMs, q.now],
    );
    if (before !== undefined) return { current, predecessor: before };
    // Excluded by ID, not by `created_at < current.createdAt`. `fleet_brief` has no per-job
    // uniqueness on `created_at` and `recordBrief` takes a caller-supplied clock, so two briefs can
    // share a timestamp — and the timestamp form then skipped BOTH of them, jumping to an older
    // brief and reporting a comparison span against the wrong one. `id != ?` is also the literal
    // reading of spec § 2.1's "the oldest brief inside the window, provided it is not the current
    // brief itself": the exclusion is of that ROW, never of that instant.
    const oldestInWindow = this.queryOne(
      `WHERE job_id = ? AND created_at >= ? AND created_at <= ? AND id != ? AND expires_at > ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [q.jobId, q.windowStartMs, current.createdAt, current.id, q.now],
    );
    return { current, predecessor: oldestInWindow };
  }

  /**
   * Distinct job ids with a live brief inside the window — half of the digest's job union.
   *
   * `created_at <= now` MUST match `briefPairForJob`'s `current` bound: without it, a future-dated
   * row (an NTP correction moving the clock backwards after a brief was written) puts a job in this
   * union while `briefPairForJob` finds no `current` for it — the two window queries disagreeing
   * about what is "in the window", surfacing as a false `noBriefInWindow` entry for a job that did
   * in fact produce a brief.
   */
  jobIdsWithBriefsInWindow(q: { windowStartMs: number; now: number }): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT job_id FROM fleet_brief
          WHERE created_at >= ? AND created_at <= ? AND expires_at > ? ORDER BY job_id ASC`,
      )
      .all(q.windowStartMs, q.now, q.now) as ReadonlyArray<{ job_id: string }>;
    return rows.map((r) => r.job_id);
  }

  /** Deletes briefs whose `expires_at` is at or before `now`. Returns the count removed. */
  pruneBriefs(now: number): number {
    const before = this.db.query(`SELECT COUNT(*) AS n FROM fleet_brief`).get() as { n: number };
    dbRun(this.db, `DELETE FROM fleet_brief WHERE expires_at <= ?`, [now]);
    const after = this.db.query(`SELECT COUNT(*) AS n FROM fleet_brief`).get() as { n: number };
    return before.n - after.n;
  }

  /**
   * Deletes runs started at or before `cutoff`. Their briefs go with them via the FK cascade —
   * which is why this exists: pruning only `fleet_brief` would leave one `fleet_run` row per
   * tick accumulating forever, and at a 60-second tick that is ~525k rows a year.
   */
  pruneRuns(cutoff: number): number {
    const before = this.db.query(`SELECT COUNT(*) AS n FROM fleet_run`).get() as { n: number };
    dbRun(this.db, `DELETE FROM fleet_run WHERE started_at <= ?`, [cutoff]);
    const after = this.db.query(`SELECT COUNT(*) AS n FROM fleet_run`).get() as { n: number };
    return before.n - after.n;
  }
}
