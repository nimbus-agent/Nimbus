// Phase 10 SA4: a scheduled (unattended) run that meets a write no standing rule covers stops there,
// is recorded `blocked_on_approval`, tells the owner once and dispatches nothing; a resume runs the
// blocked step on the owner's own executor. Real runner, real executors, real index, real rules.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ARCHIVE_STEPS,
  createRule,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import {
  buildUnattendedWorkflowWriteExecutor,
  buildWorkflowWriteExecutor,
} from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { pruneWorkflowRuns } from "./workflow-run-history.ts";
import {
  type BlockedRunInfo,
  runWorkflowExecution,
  WORKFLOW_CHANGED_MESSAGE,
} from "./workflow-runner.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";
import { abandonWorkflowRunRow } from "./workflow-store.ts";

const DAY = 86_400_000;

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

function seedThreads(ids: readonly string[]): void {
  for (const id of ids) {
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'gmail', 'email', ?, 't', ?, ?, ?)`,
    ).run(
      `gmail:${id}`,
      id,
      Date.now() - 90 * DAY,
      JSON.stringify({ threadId: id, labelIds: ["INBOX"] }),
      Date.now(),
    );
  }
}

function harness() {
  const dispatched: PlannedAction[] = [];
  const asked: string[] = [];
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "gmail.before.read") {
        return { messages: [{ id: "m", labelIds: ["INBOX"], payload: {} }] };
      }
      return { archived: true };
    },
  };
  const common = {
    localIndex,
    dispatcher,
    egressSink: { append: () => {} },
    getTribalKbConfig: () => undefined,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
  };
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      asked.push(p.prompt);
      return { approved: true, answerSource: "human" };
    },
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  return {
    dispatched,
    asked,
    unattended: buildUnattendedWorkflowWriteExecutor(common),
    attended: buildWorkflowWriteExecutor({
      ...common,
      clientId: "owner-cli",
      consentCoordinator: coordinator,
    }),
  };
}

const writes = (d: readonly PlannedAction[]) => d.filter((a) => a.type === "gmail.thread.archive");

function scheduledRun(h: ReturnType<typeof harness>, blocked: BlockedRunInfo[]) {
  return runWorkflowExecution({
    db,
    writeExecutor: h.unattended,
    trigger: "schedule",
    workflowName: "weekly-mail-clean",
    triggeredBy: "scheduler",
    dryRun: false,
    stream: false,
    sendChunk: () => {},
    onBlocked: (b) => blocked.push(b),
  });
}

type RunRow = {
  id: string;
  status: string;
  blocked_step: number | null;
  blocked_at: number | null;
  trigger: string | null;
  workflow_sha256: string | null;
  error_msg: string | null;
};
const runRows = (): RunRow[] =>
  db
    .query(
      "SELECT id, status, blocked_step, blocked_at, trigger, workflow_sha256, error_msg FROM workflow_run ORDER BY started_at, id",
    )
    .all() as RunRow[];

describe("an unattended run with no standing rule", () => {
  test("blocks at the write step, records it, notifies once and dispatches no write", async () => {
    seedThreads(["t1", "t2"]);
    const wf = seedWorkflow(db);
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await scheduledRun(h, blocked);
    expect(out.status).toBe("blocked_on_approval");
    expect(out.stepResults.map((s) => s.status)).toEqual(["done", "blocked"]);
    expect(writes(h.dispatched)).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    expect(blocked).toEqual([
      { runId: out.runId, workflowName: "weekly-mail-clean", stepIndex: 1, stepLabel: "archive" },
    ]);
    const [row] = runRows();
    expect(row).toMatchObject({
      id: out.runId,
      status: "blocked_on_approval",
      blocked_step: 1,
      trigger: "schedule",
      workflow_sha256: wf.sha,
    });
    expect(row?.blocked_at).toBeGreaterThan(0);
    const audit = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'workflow.run.completed'")
      .get() as { action_json: string };
    expect(audit.action_json).toContain('"status":"blocked_on_approval"');
    expect(audit.action_json).toContain('"trigger":"schedule"');
  });

  test("a notifier that throws cannot undo the block", async () => {
    seedThreads(["t1"]);
    seedWorkflow(db);
    const h = harness();
    const out = await runWorkflowExecution({
      db,
      writeExecutor: h.unattended,
      trigger: "schedule",
      workflowName: "weekly-mail-clean",
      triggeredBy: "scheduler",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      onBlocked: () => {
        throw new Error("toast failed");
      },
    });
    expect(out.status).toBe("blocked_on_approval");
    expect(runRows()[0]?.status).toBe("blocked_on_approval");
  });

  test("a rule covers the whole run: every thread is archived, nothing blocks, nobody is asked", async () => {
    seedThreads(["t1", "t2", "t3"]);
    seedWorkflow(db);
    createRule(db, {}, { now: Date.now() - 1000 });
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await scheduledRun(h, blocked);
    expect(out.status).toBe("done");
    expect(writes(h.dispatched)).toHaveLength(3);
    expect(blocked).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    expect(runRows()[0]).toMatchObject({ status: "done", trigger: "schedule" });
  });

  test("a rule that runs out mid-step blocks at the first uncovered action", async () => {
    seedThreads(["t1", "t2", "t3"]);
    seedWorkflow(db);
    createRule(db, { max: 2 }, { now: Date.now() - 1000 });
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await scheduledRun(h, blocked);
    expect(out.status).toBe("blocked_on_approval");
    expect(writes(h.dispatched)).toHaveLength(2);
    expect(out.stepResults.at(-1)?.output).toBe("waiting for approval after 2 of 3 done");
    expect(blocked).toHaveLength(1);
  });

  test("pruning never deletes a blocked run, however old", async () => {
    seedThreads(["t1"]);
    const wf = seedWorkflow(db);
    const h = harness();
    const out = await scheduledRun(h, []);
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at)
         VALUES (?, ?, 'x', 'done', ?)`,
        [`later-${String(i)}`, wf.id, Date.now() + 1000 + i],
      );
    }
    pruneWorkflowRuns(db, wf.id, 1);
    const ids = runRows().map((r) => r.id);
    expect(ids).toContain(out.runId);
    expect(ids.filter((i) => i.startsWith("later-"))).toHaveLength(1);
  });
});

describe("resuming a blocked run", () => {
  const TWO_WRITES = [
    ARCHIVE_STEPS[0],
    ARCHIVE_STEPS[1],
    {
      kind: "write",
      label: "archive-again",
      tool: "gmail_thread_archive",
      input: { threadId: { from: "old-read-mail", column: "metadata.threadId" } },
    },
  ];

  test("re-runs the queries, skips the earlier write, asks the owner for the blocked step, abandons the old run", async () => {
    seedThreads(["t1", "t2"]);
    const wf = seedWorkflow(db, TWO_WRITES);
    createRule(db, { step: "archive" }, { now: Date.now() - 1000 });
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const first = await scheduledRun(h, blocked);
    expect(first.status).toBe("blocked_on_approval");
    expect(blocked[0]?.stepLabel).toBe("archive-again");
    expect(writes(h.dispatched)).toHaveLength(2); // step "archive" ran under its rule

    const before = writes(h.dispatched).length;
    const second = await runWorkflowExecution({
      db,
      writeExecutor: h.attended,
      trigger: "owner_cli",
      workflowName: "weekly-mail-clean",
      triggeredBy: "owner-cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      resume: { runId: first.runId, blockedStep: 2, expectedSha256: wf.sha },
    });
    expect(second.status).toBe("done");
    expect(second.resumedFrom).toBe(first.runId);
    // The earlier write step was NOT run again; the blocked step asked the owner once per thread.
    expect(writes(h.dispatched).length - before).toBe(2);
    expect(h.asked).toHaveLength(2);
    const steps = db
      .query(
        "SELECT step_index, status FROM workflow_run_step WHERE run_id = ? ORDER BY step_index",
      )
      .all(second.runId) as Array<{ step_index: number; status: string }>;
    expect(steps.map((s) => s.step_index)).toEqual([0, 2]);
    const rows = Object.fromEntries(runRows().map((r) => [r.id, r]));
    expect(rows[first.runId]?.status).toBe("abandoned");
    expect(rows[second.runId]).toMatchObject({ status: "done", trigger: "owner_cli" });
  });

  test("refuses a workflow that changed since it blocked, and leaves the blocked run in place", async () => {
    seedThreads(["t1"]);
    const wf = seedWorkflow(db);
    const h = harness();
    const first = await scheduledRun(h, []);
    await expect(
      runWorkflowExecution({
        db,
        writeExecutor: h.attended,
        trigger: "owner_cli",
        workflowName: "weekly-mail-clean",
        triggeredBy: "owner-cli",
        dryRun: false,
        stream: false,
        sendChunk: () => {},
        resume: { runId: first.runId, blockedStep: 1, expectedSha256: "0".repeat(64) },
      }),
    ).rejects.toThrow(WORKFLOW_CHANGED_MESSAGE);
    expect(runRows()).toHaveLength(1);
    expect(runRows()[0]?.status).toBe("blocked_on_approval");
    expect(wf.sha).toBe(workflowStepsSha256(parseWorkflowSteps(JSON.stringify(ARCHIVE_STEPS))));
  });

  test("only a blocked run can be abandoned, and only once", async () => {
    seedThreads(["t1"]);
    seedWorkflow(db);
    const first = await scheduledRun(harness(), []);
    abandonWorkflowRunRow(db, first.runId, Date.now());
    expect(runRows()[0]?.status).toBe("abandoned");
    expect(() => abandonWorkflowRunRow(db, first.runId, NOW)).toThrow("ERR_RUN_NOT_BLOCKED");
    expect(() => abandonWorkflowRunRow(db, "no-such-run", NOW)).toThrow("ERR_RUN_NOT_BLOCKED");
  });
});
