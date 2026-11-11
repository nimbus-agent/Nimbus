// Phase 10 SA4: the workflow scheduler. The clock is injected and the runner is a recording stand-in
// (the real runner is exercised by workflow-runner-blocked.test.ts and the acceptance test), so no
// test waits on real time.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  freshDb,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { nextFire } from "./cron.ts";
import { createWorkflowRunLock } from "./workflow-run-lock.ts";
import type { RunWorkflowExecutionParams, RunWorkflowExecutionResult } from "./workflow-runner.ts";
import {
  blockedNotification,
  CATCH_UP_WINDOW_MS,
  WorkflowScheduler,
  type WorkflowSchedulerDeps,
} from "./workflow-scheduler.ts";
import { setWorkflowSchedule } from "./workflow-store.ts";

const T0 = Date.UTC(2026, 10, 11, 8, 0); // Wed 08:00 UTC
const MIN = 60_000;

let db: Database;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

function schedule(name: string, nextAt: number, expr = "*/10 * * * *", steps?: readonly unknown[]) {
  const wf = seedWorkflow(db, steps, name);
  setWorkflowSchedule(db, wf.id, { expr, tz: "UTC", nextAt });
  return wf;
}

function row(name: string) {
  return db
    .query("SELECT schedule_next_at AS n, schedule_last_fire_at AS l FROM workflow WHERE name = ?")
    .get(name) as { n: number | null; l: number | null };
}

function skips(name: string) {
  return db
    .query(
      `SELECT r.status, r.error_msg, r.trigger, r.triggered_by FROM workflow_run r
       JOIN workflow w ON w.id = r.workflow_id WHERE w.name = ? AND r.status = 'skipped'`,
    )
    .all(name) as Array<{
    status: string;
    error_msg: string;
    trigger: string;
    triggered_by: string;
  }>;
}

type Harness = {
  scheduler: WorkflowScheduler;
  runs: RunWorkflowExecutionParams[];
  notes: Array<{ title: string; body: string }>;
  clock: { now: number };
  lock: ReturnType<typeof createWorkflowRunLock>;
};

function harness(over: Partial<WorkflowSchedulerDeps> = {}, now = T0): Harness {
  const runs: RunWorkflowExecutionParams[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const clock = { now };
  const lock = createWorkflowRunLock();
  const scheduler = new WorkflowScheduler({
    db,
    now: () => clock.now,
    makeExecutor: () => ({ execute: () => Promise.reject(new Error("never used by the stub")) }),
    notify: (title, body) => {
      notes.push({ title, body });
    },
    lock,
    runWorkflow: async (p) => {
      runs.push(p);
      return {
        runId: `run-${String(runs.length)}`,
        status: "done",
        dryRun: false,
        stepResults: [],
      };
    },
    ...over,
  });
  return { scheduler, runs, notes, clock, lock };
}

describe("firing", () => {
  test("a due workflow runs with the schedule trigger and the scheduler as its origin", async () => {
    schedule("w", T0 - MIN);
    const h = harness();
    const out = await h.scheduler.tick();
    expect(out).toEqual([{ workflow: "w", kind: "ran", status: "done" }]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      trigger: "schedule",
      triggeredBy: "scheduler",
      workflowName: "w",
      dryRun: false,
    });
    expect(row("w")).toEqual({ n: nextFire("*/10 * * * *", "UTC", T0) ?? null, l: T0 });
  });

  test("a workflow that is not yet due does not run", async () => {
    schedule("w", T0 + MIN);
    const h = harness();
    expect(await h.scheduler.tick()).toEqual([]);
    expect(h.runs).toHaveLength(0);
    expect(row("w").n).toBe(T0 + MIN);
  });

  test("an unscheduled workflow never runs", async () => {
    seedWorkflow(db, undefined, "plain");
    const h = harness();
    expect(await h.scheduler.tick()).toEqual([]);
  });

  test("due workflows run oldest first and one at a time", async () => {
    schedule("late", T0 - 2 * MIN);
    schedule("early", T0 - 9 * MIN);
    schedule("mid", T0 - 5 * MIN);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const h = harness({
      runWorkflow: async (p) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(p.workflowName);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return { runId: "r", status: "done", dryRun: false, stepResults: [] };
      },
    });
    await h.scheduler.tick();
    expect(order).toEqual(["early", "mid", "late"]);
    expect(maxActive).toBe(1);
  });

  test("a runner that throws is reported and the next workflow still runs", async () => {
    schedule("a", T0 - 2 * MIN);
    schedule("b", T0 - MIN);
    const errors: string[] = [];
    const seen: string[] = [];
    const h = harness({
      runWorkflow: async (p) => {
        seen.push(p.workflowName);
        if (p.workflowName === "a") throw new Error("boom");
        return { runId: "r", status: "done", dryRun: false, stepResults: [] };
      },
      onError: (name) => errors.push(name),
    });
    const out = await h.scheduler.tick();
    expect(out.map((o) => o.kind)).toEqual(["ran", "ran"]);
    expect(seen).toEqual(["a", "b"]);
    expect(errors).toEqual(["a"]);
  });

  test("a stored expression that no longer parses fires once and then has no next fire", async () => {
    schedule("w", T0 - MIN, "not a cron");
    const h = harness();
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(1);
    expect(row("w").n).toBeNull();
    expect(await h.scheduler.tick()).toEqual([]);
  });

  test("two ticks never overlap", async () => {
    schedule("w", T0 - MIN);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      runWorkflow: async () => {
        await gate;
        return { runId: "r", status: "done", dryRun: false, stepResults: [] };
      },
    });
    const first = h.scheduler.tick();
    expect(await h.scheduler.tick()).toEqual([]);
    release();
    expect(await first).toHaveLength(1);
  });
});

describe("missed fires", () => {
  test("a miss within an hour runs once, and the next fire is computed from now", async () => {
    schedule("w", T0 - 30 * MIN);
    const h = harness();
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(1);
    expect(row("w").n).toBe(nextFire("*/10 * * * *", "UTC", T0) ?? null);
    expect(await h.scheduler.tick()).toEqual([]);
  });

  test("a miss older than an hour is skipped and recorded, not caught up", async () => {
    schedule("w", T0 - CATCH_UP_WINDOW_MS - MIN);
    const h = harness();
    const out = await h.scheduler.tick();
    expect(out[0]).toMatchObject({ kind: "skipped" });
    expect(h.runs).toHaveLength(0);
    expect(skips("w")).toEqual([
      {
        status: "skipped",
        error_msg: "skipped: missed while the gateway was not running",
        trigger: "schedule",
        triggered_by: "scheduler",
      },
    ]);
    expect(row("w").n).toBe(nextFire("*/10 * * * *", "UTC", T0) ?? null);
  });

  test("exactly an hour late still catches up", async () => {
    schedule("w", T0 - CATCH_UP_WINDOW_MS);
    const h = harness();
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(1);
  });
});

describe("one run per workflow", () => {
  test("a fire while the workflow's lock is held is recorded 'already running' and moves on", async () => {
    schedule("w", T0 - MIN);
    const h = harness();
    h.lock.tryAcquire(seedId("w"));
    const out = await h.scheduler.tick();
    expect(out[0]).toEqual({ workflow: "w", kind: "skipped", reason: "skipped: already running" });
    expect(h.runs).toHaveLength(0);
    expect(skips("w")[0]?.error_msg).toBe("skipped: already running");
    expect(row("w").n).toBe(nextFire("*/10 * * * *", "UTC", T0) ?? null);
  });

  test("the lock is free again after a run, even one that threw", async () => {
    const wf = schedule("w", T0 - MIN);
    const h = harness({
      runWorkflow: async () => {
        throw new Error("x");
      },
    });
    await h.scheduler.tick();
    expect(h.lock.isHeld(wf.id)).toBe(false);
  });

  test("a workflow with a blocked run is not fired: skipped, no new run, no notification, coalesced", async () => {
    const wf = schedule("w", T0 - MIN);
    db.run(
      `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, blocked_step, blocked_at)
       VALUES ('blocked-1', ?, 'scheduler', 'blocked_on_approval', ?, 1, ?)`,
      [wf.id, T0 - 20 * MIN, T0 - 20 * MIN],
    );
    const h = harness();
    await h.scheduler.tick();
    h.clock.now = T0 + 10 * MIN;
    await h.scheduler.tick();
    h.clock.now = T0 + 20 * MIN;
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    const s = skips("w");
    expect(s).toHaveLength(1);
    expect(s[0]?.error_msg).toBe("skipped: waiting for approval (blocked-1) (x3)");
    const total = db.query("SELECT COUNT(*) AS n FROM workflow_run").get() as { n: number };
    expect(total.n).toBe(2);
  });

  test("a workflow with a model step is refused at fire time, whatever the schedule says", async () => {
    schedule("w", T0 - MIN, "*/10 * * * *", [{ run: "summarise the news" }]);
    const h = harness();
    const out = await h.scheduler.tick();
    expect(out[0]).toMatchObject({ kind: "skipped" });
    expect(h.runs).toHaveLength(0);
    expect(skips("w")[0]?.error_msg).toContain("cannot hold a model (run) step");
  });

  test("a workflow whose steps no longer parse is refused at fire time", async () => {
    const wf = schedule("w", T0 - MIN);
    db.run("UPDATE workflow SET steps_json = 'not json' WHERE id = ?", [wf.id]);
    const h = harness();
    await h.scheduler.tick();
    expect(h.runs).toHaveLength(0);
    expect(skips("w")[0]?.error_msg).toContain("no longer parses");
  });
});

function seedId(name: string): string {
  return (db.query("SELECT id FROM workflow WHERE name = ?").get(name) as { id: string }).id;
}

describe("block and notify", () => {
  test("a blocked run sends exactly one OS notification naming the workflow, the step and the command", async () => {
    schedule("weekly-mail-clean", T0 - MIN);
    const h = harness({
      runWorkflow: async (p) => {
        p.onBlocked?.({
          runId: "run-9",
          workflowName: p.workflowName,
          stepIndex: 1,
          stepLabel: "archive",
        });
        return {
          runId: "run-9",
          status: "blocked_on_approval",
          dryRun: false,
          stepResults: [],
        } satisfies RunWorkflowExecutionResult;
      },
    });
    await h.scheduler.tick();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]?.body).toBe(
      "Workflow weekly-mail-clean is waiting for you: step archive needs your approval (nimbus workflow resume run-9)",
    );
  });

  test("a notifier that throws or rejects does not break the run", async () => {
    for (const notify of [
      () => {
        throw new Error("sync");
      },
      () => Promise.reject(new Error("async")),
    ]) {
      schedule("w", T0 - MIN);
      const h = harness({
        notify,
        runWorkflow: async (p) => {
          p.onBlocked?.({ runId: "r", workflowName: "w", stepIndex: 0, stepLabel: "s" });
          return { runId: "r", status: "blocked_on_approval", dryRun: false, stepResults: [] };
        },
      });
      expect(await h.scheduler.tick()).toEqual([
        { workflow: "w", kind: "ran", status: "blocked_on_approval" },
      ]);
      await new Promise((r) => setTimeout(r, 1));
      db.run("DELETE FROM workflow");
    }
  });

  test("control characters in a label cannot reach the notification", () => {
    const { body } = blockedNotification({
      runId: "r",
      workflowName: "a\u0007b",
      stepIndex: 0,
      stepLabel: "c\nd",
    });
    expect(body).toBe(
      "Workflow a b is waiting for you: step c d needs your approval (nimbus workflow resume r)",
    );
  });
});

describe("lifecycle", () => {
  test("start ticks at once and on the interval; stop ends it; start is idempotent", async () => {
    schedule("w", T0 - MIN);
    const h = harness({ tickMs: 5 });
    h.scheduler.start();
    h.scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    h.scheduler.stop();
    expect(h.runs).toHaveLength(1);
    const after = h.runs.length;
    h.clock.now = T0 + 60 * MIN;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runs).toHaveLength(after);
  });

  test("retire waits for the in-flight run and nothing starts afterwards", async () => {
    schedule("w", T0 - MIN);
    let finished = false;
    let started = 0;
    const h = harness({
      runWorkflow: async () => {
        started++;
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
        return { runId: "r", status: "done", dryRun: false, stepResults: [] };
      },
    });
    const running = h.scheduler.tick();
    await h.scheduler.retire();
    expect(finished).toBe(true);
    await running;
    schedule("again", T0 - MIN);
    expect(await h.scheduler.tick()).toEqual([]);
    h.scheduler.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(1);
  });
});
