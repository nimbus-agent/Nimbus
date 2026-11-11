// packages/gateway/src/automation/workflow-scheduler.ts
// The scheduler of saved workflows (Phase 10 SA4, plan task 4), modelled on `fleet/fleet-scheduler.ts`:
// a 60 s `unref`'d tick, `start` / `stop` / `retire`, one run per workflow at a time, due workflows
// run oldest-due first and one after another.
//
// This is the only module that produces the trigger `"schedule"` (static D44(d)). It is handed a
// FACTORY for the write executor (`makeExecutor`), built in `gateway-main.ts` from
// `buildUnattendedWorkflowWriteExecutor`; it names no executor builder, holds no client id and no
// consent coordinator, so nothing it runs can ask a person anything. A write a standing rule does not
// cover blocks the run (`blocked_on_approval`) and tells the owner once.
//
// Missed fires: a workflow whose `schedule_next_at` is in the past by at most an hour runs once (a
// catch-up); an older miss is skipped and recorded. The next fire is always computed from now.
// A fire that cannot run is RECORDED as a `skipped` run with its reason, never silently dropped; a
// run of identical skips is coalesced into one row so a long wait does not push real history out.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dbRun } from "../db/write.ts";
import { nextFire } from "./cron.ts";
import { type WorkflowRunLock, workflowRunLock } from "./workflow-run-lock.ts";
import {
  type BlockedRunInfo,
  type RunWorkflowExecutionParams,
  type RunWorkflowExecutionResult,
  runWorkflowExecution,
} from "./workflow-runner.ts";
import { needsModel, parseWorkflowSteps } from "./workflow-steps.ts";
import { advanceSchedule, listDueWorkflows, type ScheduledWorkflowRow } from "./workflow-store.ts";
import type { WorkflowWriteExecutor } from "./workflow-write-step.ts";

export const DEFAULT_SCHEDULER_TICK_MS = 60_000;

/** A miss older than this is skipped, not caught up. */
export const CATCH_UP_WINDOW_MS = 60 * 60_000;

/** Who a scheduled run is attributed to in `workflow_run.triggered_by`. */
export const SCHEDULER_TRIGGERED_BY = "scheduler";

export interface WorkflowSchedulerDeps {
  readonly db: Database;
  /** The clock; tests inject one so a fire never waits for real time. */
  readonly now: () => number;
  /** A fresh unattended write executor for one run (built in `gateway-main.ts`). */
  readonly makeExecutor: () => WorkflowWriteExecutor;
  /** An OS notification (`showIgnoringFailure`); must not throw, but a throw is swallowed anyway. */
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly lock?: WorkflowRunLock;
  /** Test seam: stands in for the runner. */
  readonly runWorkflow?: (p: RunWorkflowExecutionParams) => Promise<RunWorkflowExecutionResult>;
  readonly tickMs?: number;
  readonly onError?: (workflow: string, err: unknown) => void;
}

export type FireOutcome =
  | { readonly workflow: string; readonly kind: "ran"; readonly status: string }
  | { readonly workflow: string; readonly kind: "skipped"; readonly reason: string };

/** Strips control characters from an owner-authored label before it goes in a notification. */
function plain(text: string): string {
  return text.replaceAll(/\p{Cc}/gu, " ");
}

/** The notification text for a blocked run. */
export function blockedNotification(info: BlockedRunInfo): { title: string; body: string } {
  return {
    title: "Nimbus: a workflow is waiting for you",
    body: `Workflow ${plain(info.workflowName)} is waiting for you: step ${plain(info.stepLabel)} needs your approval (nimbus workflow resume ${info.runId})`,
  };
}

const COALESCED = /^(.*?)(?: \(x(\d+)\))?$/s;

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<FireOutcome[]> | undefined;
  private retired = false;
  private readonly lock: WorkflowRunLock;

  constructor(private readonly deps: WorkflowSchedulerDeps) {
    this.lock = deps.lock ?? workflowRunLock;
  }

  /** Begins ticking; the first tick runs at once, which is also the startup catch-up. */
  start(): void {
    if (this.timer !== undefined || this.retired) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? DEFAULT_SCHEDULER_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stops ticking and waits for an in-flight run to settle; no new fire starts afterwards. */
  async retire(): Promise<void> {
    this.retired = true;
    this.stop();
    await this.inFlight?.catch(() => {});
  }

  /**
   * Fires every due workflow once, oldest due first, sequentially. A tick that finds the previous
   * one still running returns at once: two ticks never overlap.
   */
  tick(): Promise<FireOutcome[]> {
    if (this.retired || this.inFlight !== undefined) return Promise.resolve([]);
    const run = this.fireDue().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async fireDue(): Promise<FireOutcome[]> {
    const outcomes: FireOutcome[] = [];
    for (const wf of listDueWorkflows(this.deps.db, this.deps.now())) {
      if (this.retired) break;
      outcomes.push(await this.fireOne(wf));
    }
    return outcomes;
  }

  /** Why this fire must not run, or `undefined` when it may. In the order the checks are made. */
  private skipReason(wf: ScheduledWorkflowRow, now: number): string | undefined {
    if (this.lock.isHeld(wf.id)) return "skipped: already running";
    const blocked = blockedRunOf(this.deps.db, wf.id);
    if (blocked !== undefined) return `skipped: waiting for approval (${blocked})`;
    const modelRefusal = modelStepRefusal(wf.steps_json);
    if (modelRefusal !== undefined) return modelRefusal;
    const lateBy = now - (wf.schedule_next_at ?? now);
    if (lateBy > CATCH_UP_WINDOW_MS) return "skipped: missed while the gateway was not running";
    return undefined;
  }

  private async fireOne(wf: ScheduledWorkflowRow): Promise<FireOutcome> {
    const now = this.deps.now();
    const reason = this.skipReason(wf, now);
    // The next fire is computed from now and stored BEFORE anything runs, so a crash mid-run cannot
    // fire the same slot again.
    advanceSchedule(this.deps.db, wf.id, safeNextFire(wf, now), now);
    if (reason !== undefined) {
      recordSkippedFire(this.deps.db, wf.id, reason, now);
      return { workflow: wf.name, kind: "skipped", reason };
    }
    const held = await this.lock.withLock(wf.id, () => this.runOnce(wf));
    if (held === undefined) {
      const busy = "skipped: already running";
      recordSkippedFire(this.deps.db, wf.id, busy, now);
      return { workflow: wf.name, kind: "skipped", reason: busy };
    }
    return held.value;
  }

  private async runOnce(wf: ScheduledWorkflowRow): Promise<FireOutcome> {
    const run = this.deps.runWorkflow ?? runWorkflowExecution;
    try {
      const out = await run({
        db: this.deps.db,
        writeExecutor: this.deps.makeExecutor(),
        // The one place the trigger "schedule" is produced (static D44(d)).
        trigger: "schedule",
        workflowName: wf.name,
        triggeredBy: SCHEDULER_TRIGGERED_BY,
        dryRun: false,
        stream: false,
        sendChunk: () => {},
        onBlocked: (info) => this.notifyBlocked(info),
      });
      return { workflow: wf.name, kind: "ran", status: out.status };
    } catch (err) {
      // The runner has already recorded the failed run row; the scheduler only reports it.
      this.deps.onError?.(wf.name, err);
      return { workflow: wf.name, kind: "ran", status: "error" };
    }
  }

  private notifyBlocked(info: BlockedRunInfo): void {
    const { title, body } = blockedNotification(info);
    try {
      void Promise.resolve(this.deps.notify(title, body)).catch(() => {});
    } catch {
      // A failed notification never changes the block.
    }
  }
}

/** The next fire after `now`, or `null` when the stored expression no longer yields one. */
function safeNextFire(wf: ScheduledWorkflowRow, now: number): number | null {
  try {
    return nextFire(wf.schedule, wf.schedule_tz, now) ?? null;
  } catch {
    return null;
  }
}

function blockedRunOf(db: Database, workflowId: string): string | undefined {
  const row = db
    .query(
      `SELECT id FROM workflow_run WHERE workflow_id = ? AND status = 'blocked_on_approval'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workflowId) as { id: string } | null | undefined;
  return row?.id;
}

/** A schedule must hold no model step, checked again at fire time (OR-10-8). */
function modelStepRefusal(stepsJson: string): string | undefined {
  try {
    if (needsModel(parseWorkflowSteps(stepsJson))) {
      return "skipped: refused: a scheduled workflow cannot hold a model (run) step";
    }
    return undefined;
  } catch {
    return "skipped: refused: the workflow no longer parses";
  }
}

/**
 * Records a fire that did not run as a finished `skipped` run. When the workflow's latest run is
 * already a skip with the same reason, that row is updated ("(xN)") rather than adding another.
 */
function recordSkippedFire(db: Database, workflowId: string, reason: string, at: number): void {
  const last = db
    .query(
      `SELECT id, status, error_msg FROM workflow_run WHERE workflow_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(workflowId) as { id: string; status: string; error_msg: string | null } | null | undefined;
  if (last?.status === "skipped" && last.error_msg !== null) {
    const m = COALESCED.exec(last.error_msg);
    if (m?.[1] === reason) {
      const count = Number(m[2] ?? "1") + 1;
      dbRun(db, `UPDATE workflow_run SET finished_at = ?, error_msg = ? WHERE id = ?`, [
        at,
        `${reason} (x${String(count)})`,
        last.id,
      ]);
      return;
    }
  }
  dbRun(
    db,
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, finished_at, error_msg, trigger)
     VALUES (?, ?, ?, 'skipped', ?, ?, ?, 'schedule')`,
    [randomUUID(), workflowId, SCHEDULER_TRIGGERED_BY, at, at, reason],
  );
}
