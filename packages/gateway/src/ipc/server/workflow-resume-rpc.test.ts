// Phase 10 SA4: `workflow.resume` and `workflow.scheduleList`. Local cli/ui only, one run per workflow
// (the same lock a scheduled fire holds), the hash of the definition that blocked re-checked, and a
// lock that is always released.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { workflowRunLock } from "../../automation/workflow-run-lock.ts";
import { setWorkflowSchedule } from "../../automation/workflow-store.ts";
import {
  ARCHIVE_STEPS,
  seedWorkflow,
} from "../../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { dispatchAutomationRpc } from "../automation-rpc.ts";
import type { WorkflowRunContext } from "../workflow-invoke.ts";
import type { ClientKind } from "./client-kind.ts";
import type { ServerCtx } from "./context.ts";
import { dispatchWorkflowResumeRpc } from "./inline-handlers.ts";
import { RpcMethodError } from "./rpc-error.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

function blockedRun(id: string, workflowId: string, sha: string | null, step = 1): void {
  db.run(
    `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, blocked_step, blocked_at, trigger, workflow_sha256)
     VALUES (?, ?, 'scheduler', 'blocked_on_approval', 1000, ?, 1000, 'schedule', ?)`,
    [id, workflowId, step, sha],
  );
}

type Handler = (c: WorkflowRunContext) => Promise<unknown>;

function harness(kind: ClientKind, handler?: Handler) {
  const seen: WorkflowRunContext[] = [];
  const ctx = {
    options: { localIndex: { getDatabase: () => db } },
    getWorkflowRunHandler: () =>
      handler ??
      (async (c: WorkflowRunContext) => {
        seen.push(c);
        return { runId: "new-run", status: "done", dryRun: false, stepResults: [] };
      }),
    getClientKind: () => kind,
  } as unknown as ServerCtx;
  return { ctx, seen };
}

const SESSION = {} as never;

async function refusal(
  p: Promise<unknown>,
): Promise<{ code: number; message: string; data: unknown }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcMethodError);
    const err = e as RpcMethodError;
    return { code: err.rpcCode, message: err.message, data: err.rpcData };
  }
  throw new Error("expected a refusal");
}

describe("workflow.resume: who may resume", () => {
  test("every kind but cli and ui is refused ERR_RESUME_LOCAL_ONLY and nothing runs", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      const h = harness(kind);
      const r = await refusal(dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId: "b1" }));
      expect(r.message, kind).toContain("ERR_RESUME_LOCAL_ONLY");
      expect(h.seen, kind).toEqual([]);
    }
    expect(db.query("SELECT status FROM workflow_run WHERE id = 'b1'").get()).toEqual({
      status: "blocked_on_approval",
    });
  });

  test("cli and ui resume with their own trigger and a validated resume record", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha, 1);
    for (const [kind, trigger] of [
      ["cli", "owner_cli"],
      ["ui", "owner_ui"],
    ] as const) {
      const h = harness(kind);
      const out = await dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId: "b1" });
      expect(out).toMatchObject({ status: "done" });
      expect(h.seen[0]).toMatchObject({
        workflowName: wf.name,
        trigger,
        resume: { runId: "b1", blockedStep: 1, expectedSha256: wf.sha },
      });
    }
  });

  test("params may not name the origin, the workflow or the resume record", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    for (const key of ["trigger", "provenance", "clientKind", "resume", "name"]) {
      const h = harness("cli");
      const r = await refusal(
        dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId: "b1", [key]: "x" }),
      );
      expect(r.code, key).toBe(-32602);
      expect(h.seen).toEqual([]);
    }
    for (const bad of [{}, { runId: "" }, { runId: 5 }, { runId: "x".repeat(200) }]) {
      const r = await refusal(dispatchWorkflowResumeRpc(harness("cli").ctx, "c", SESSION, bad));
      expect(r.code).toBe(-32602);
    }
  });
});

describe("workflow.resume: what may be resumed", () => {
  test("an unknown run, a run that is not blocked, an unhashed run and an edited workflow are refused", async () => {
    const wf = seedWorkflow(db);
    db.run(
      `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at)
       VALUES ('done-1', ?, 'x', 'done', 1)`,
      [wf.id],
    );
    blockedRun("old-1", wf.id, null);
    blockedRun("edited-1", wf.id, "0".repeat(64));
    const cases: Array<[string, string]> = [
      ["nope", "ERR_RUN_NOT_FOUND"],
      ["done-1", "ERR_RUN_NOT_BLOCKED"],
      ["old-1", "ERR_RUN_NOT_RESUMABLE"],
      ["edited-1", "ERR_WORKFLOW_CHANGED"],
    ];
    for (const [runId, code] of cases) {
      const h = harness("cli");
      const r = await refusal(dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId }));
      expect(r.message, runId).toContain(code);
      expect(r.data, runId).toEqual({ code });
      expect(h.seen, runId).toEqual([]);
    }
  });

  test("a workflow edited after it blocked is refused (the real hash, not a stub)", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    seedWorkflow(db, [ARCHIVE_STEPS[0], { ...ARCHIVE_STEPS[1], label: "archive-renamed" }]);
    const r = await refusal(
      dispatchWorkflowResumeRpc(harness("cli").ctx, "c", SESSION, { runId: "b1" }),
    );
    expect(r.message).toContain("ERR_WORKFLOW_CHANGED");
  });
});

describe("workflow.resume: one run per workflow", () => {
  test("a resume while the workflow's lock is held (a scheduled fire) is refused ERR_WORKFLOW_BUSY", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    expect(workflowRunLock.tryAcquire(wf.id)).toBe(true);
    try {
      const h = harness("cli");
      const r = await refusal(dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId: "b1" }));
      expect(r.message).toContain("ERR_WORKFLOW_BUSY");
      expect(h.seen).toEqual([]);
    } finally {
      workflowRunLock.release(wf.id);
    }
  });

  test("two resumes at once: the second is refused busy, then the lock is free", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = harness("cli", async () => {
      await gate;
      return { runId: "r", status: "done" };
    });
    const first = dispatchWorkflowResumeRpc(slow.ctx, "c", SESSION, { runId: "b1" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await refusal(
      dispatchWorkflowResumeRpc(harness("cli").ctx, "c", SESSION, { runId: "b1" }),
    );
    expect(second.message).toContain("ERR_WORKFLOW_BUSY");
    release();
    await first;
    expect(workflowRunLock.isHeld(wf.id)).toBe(false);
  });

  test("the lock is released when the run throws or the client aborts mid-resume", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    const failing = harness("cli", async () => {
      throw new Error("client disconnected");
    });
    await expect(
      dispatchWorkflowResumeRpc(failing.ctx, "c", SESSION, { runId: "b1" }),
    ).rejects.toThrow("client disconnected");
    expect(workflowRunLock.isHeld(wf.id)).toBe(false);
  });
});

describe("workflow.resume --discard", () => {
  test("abandons the blocked run, runs nothing, and a second discard is refused", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    const h = harness("cli");
    const out = await dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, {
      runId: "b1",
      discard: true,
    });
    expect(out).toEqual({ runId: "b1", status: "abandoned" });
    expect(h.seen).toEqual([]);
    expect(db.query("SELECT status FROM workflow_run WHERE id = 'b1'").get()).toEqual({
      status: "abandoned",
    });
    const again = await refusal(
      dispatchWorkflowResumeRpc(h.ctx, "c", SESSION, { runId: "b1", discard: true }),
    );
    expect(again.message).toContain("ERR_RUN_NOT_BLOCKED");
  });

  test("a discard needs the local owner too", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, wf.sha);
    const r = await refusal(
      dispatchWorkflowResumeRpc(harness("mcp").ctx, "c", SESSION, { runId: "b1", discard: true }),
    );
    expect(r.message).toContain("ERR_RESUME_LOCAL_ONLY");
  });

  test("a discard works for a run whose definition has since changed", async () => {
    const wf = seedWorkflow(db);
    blockedRun("b1", wf.id, "0".repeat(64));
    const out = await dispatchWorkflowResumeRpc(harness("cli").ctx, "c", SESSION, {
      runId: "b1",
      discard: true,
    });
    expect(out).toMatchObject({ status: "abandoned" });
  });
});

describe("workflow.scheduleList", () => {
  test("lists every scheduled workflow with its next fire, last status and blocked run", async () => {
    const wf = seedWorkflow(db);
    seedWorkflow(db, undefined, "unscheduled");
    setWorkflowSchedule(db, wf.id, { expr: "0 6 * * *", tz: "Europe/Berlin", nextAt: 5000 });
    db.run("UPDATE workflow SET schedule_last_fire_at = 4000 WHERE id = ?", [wf.id]);
    blockedRun("b1", wf.id, wf.sha, 1);
    const out = await dispatchAutomationRpc({ method: "workflow.scheduleList", params: {}, db });
    expect(out).toEqual({
      kind: "hit",
      value: {
        schedules: [
          {
            name: wf.name,
            schedule: "0 6 * * *",
            timezone: "Europe/Berlin",
            nextFireAt: 5000,
            lastFireAt: 4000,
            lastRunStatus: "blocked_on_approval",
            blockedRunId: "b1",
            blockedStepLabel: "archive",
          },
        ],
      },
    });
  });

  test("a workflow with no runs reports null, and skipped fires are not its last status", async () => {
    const wf = seedWorkflow(db);
    setWorkflowSchedule(db, wf.id, { expr: "@daily", tz: "UTC", nextAt: 1 });
    db.run(
      `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at) VALUES ('s', ?, 'x', 'skipped', 9)`,
      [wf.id],
    );
    const out = (await dispatchAutomationRpc({
      method: "workflow.scheduleList",
      params: {},
      db,
    })) as {
      value: { schedules: Array<Record<string, unknown>> };
    };
    expect(out.value.schedules[0]).toMatchObject({
      lastRunStatus: null,
      blockedRunId: null,
      blockedStepLabel: null,
    });
  });
});
