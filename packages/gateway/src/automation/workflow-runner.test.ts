import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import { LocalIndex } from "../index/local-index.ts";
import {
  parseWorkflowStepsJson,
  type RunWorkflowExecutionParams,
  runWorkflowExecution,
} from "./workflow-runner.ts";
import {
  finishWorkflowRunRow,
  insertWorkflowRunRow,
  upsertWorkflowByName,
} from "./workflow-store.ts";

const noopAgent = {} as Agent;

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedOneStepWorkflow(
  db: Database,
  name: string,
  opts: { id?: string; run?: string; label?: string } = {},
): { id: string } {
  const id = opts.id ?? `wf-${name}`;
  const label = opts.label ?? "step-1";
  const run = opts.run ?? "echo";
  db.run(
    `INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 0)`,
    [id, name, JSON.stringify([{ label, run }])],
  );
  return { id };
}

function makeRunParams(
  db: Database,
  workflowName: string,
  overrides: Partial<RunWorkflowExecutionParams> = {},
): RunWorkflowExecutionParams {
  return {
    db,
    agent: noopAgent,
    workflowName,
    triggeredBy: "user",
    dryRun: false,
    stream: false,
    sendChunk: () => {
      /* noop */
    },
    ...overrides,
  };
}

function lastRunRow<T>(db: Database, workflowName: string, columns: string): T {
  return db
    .query(
      `SELECT ${columns} FROM workflow_run
       WHERE workflow_id = (SELECT id FROM workflow WHERE name = ?)
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workflowName) as T;
}

function lastRunCompletedAudit<T>(db: Database, columns: string): T {
  return db
    .query(
      `SELECT ${columns} FROM audit_log
       WHERE action_type = 'workflow.run.completed' ORDER BY id DESC LIMIT 1`,
    )
    .get() as T;
}

function seedHistoricalRuns(
  db: Database,
  workflowId: string,
  count: number,
  startedAtBase: number,
  idPrefix: string,
): void {
  for (let i = 0; i < count; i++) {
    insertWorkflowRunRow(db, {
      id: `${idPrefix}-${i}`,
      workflowId,
      triggeredBy: "user",
      status: "done",
      startedAt: startedAtBase + i,
      dryRun: false,
    });
    finishWorkflowRunRow(db, `${idPrefix}-${i}`, "done", startedAtBase + 10 + i, null);
  }
}

describe("parseWorkflowStepsJson", () => {
  test("parses run steps", () => {
    const steps = parseWorkflowStepsJson(
      JSON.stringify([{ run: "hello" }, { label: "b", run: "world", continueOnError: true }]),
    );
    expect(steps).toEqual([{ run: "hello" }, { label: "b", run: "world", continueOnError: true }]);
  });

  test("rejects empty array", () => {
    expect(() => parseWorkflowStepsJson("[]")).toThrow(/no executable steps/);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseWorkflowStepsJson("{")).toThrow(/not valid JSON/);
  });

  test("rejects non-array root", () => {
    expect(() => parseWorkflowStepsJson("{}")).toThrow(/JSON array/);
  });

  test("skips rows without non-empty run", () => {
    const steps = parseWorkflowStepsJson(
      JSON.stringify([{ run: "   ok  " }, { run: "" }, { label: "x" }, null, "nope"]),
    );
    expect(steps).toEqual([{ run: "ok" }]);
  });

  test("accepts continue_on_error alias", () => {
    const steps = parseWorkflowStepsJson(JSON.stringify([{ run: "a", continue_on_error: true }]));
    expect(steps[0]?.continueOnError).toBe(true);
  });
});

describe("runWorkflowExecution (dry run and validation)", () => {
  test("throws when workflow schema below v9", async () => {
    const db = new Database(":memory:");
    await expect(
      runWorkflowExecution(makeRunParams(db, "w", { triggeredBy: "t", dryRun: true })),
    ).rejects.toThrow(/v9/);
  });

  test("throws for unknown workflow", async () => {
    const db = freshDb();
    await expect(
      runWorkflowExecution(makeRunParams(db, "missing", { triggeredBy: "t", dryRun: true })),
    ).rejects.toThrow(/Unknown workflow/);
  });

  test("dry run returns preview step results and persists a dry_run=1 row", async () => {
    const db = freshDb();
    upsertWorkflowByName(
      db,
      "demo",
      null,
      JSON.stringify([{ label: "L1", run: "do thing" }, { run: "second" }]),
      Date.now(),
    );
    const r = await runWorkflowExecution(
      makeRunParams(db, "demo", { triggeredBy: "cli", dryRun: true }),
    );
    expect(r.dryRun).toBe(true);
    expect(r.stepResults).toEqual([
      { label: "L1", status: "preview", output: "do thing", hitlActions: [] },
      { label: "step-2", status: "preview", output: "second", hitlActions: [] },
    ]);
    const runCount = db.query(`SELECT COUNT(*) as c FROM workflow_run`).get() as { c: number };
    expect(runCount.c).toBe(1);
    const runRow = db.query(`SELECT dry_run, status FROM workflow_run LIMIT 1`).get() as {
      dry_run: number;
      status: string;
    };
    expect(runRow.dry_run).toBe(1);
    expect(runRow.status).toBe("preview");
  });

  test("dry run includes heuristic hitlActions for HITL-like step text", async () => {
    const db = freshDb();
    upsertWorkflowByName(
      db,
      "hitl-demo",
      null,
      JSON.stringify([{ run: "Run terraform apply in production" }]),
      Date.now(),
    );
    const r = await runWorkflowExecution(
      makeRunParams(db, "hitl-demo", { triggeredBy: "t", dryRun: true }),
    );
    expect(r.stepResults[0]?.hitlActions).toContain("iac.terraform.apply");
  });

  test("runWorkflowExecution writes a dry_run=1 row when dryRun is true", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "preview-me", { run: "echo hi" });
    await runWorkflowExecution(makeRunParams(db, "preview-me", { dryRun: true }));
    const row = lastRunRow<{ dry_run: number; status: string }>(
      db,
      "preview-me",
      "dry_run, status",
    );
    expect(row.dry_run).toBe(1);
    expect(row.status).toBe("preview");
  });

  test("runWorkflowExecution persists paramsOverride JSON on the real-run row", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "po-real", { run: "echo hi" });
    const override = { "step-1": { greeting: "hi" } };
    await runWorkflowExecution(
      makeRunParams(db, "po-real", {
        conversationalRunner: async () => ({ reply: "ok" }),
        paramsOverride: override,
      }),
    );
    const row = lastRunRow<{ params_override_json: string }>(db, "po-real", "params_override_json");
    expect(JSON.parse(row.params_override_json)).toEqual(override);
  });

  test("runWorkflowExecution persists paramsOverride JSON on the dry-run row", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "po-dry", { run: "echo hi" });
    const override = { "step-1": { greeting: "dry" } };
    await runWorkflowExecution(
      makeRunParams(db, "po-dry", { dryRun: true, paramsOverride: override }),
    );
    const row = lastRunRow<{ params_override_json: string }>(db, "po-dry", "params_override_json");
    expect(JSON.parse(row.params_override_json)).toEqual(override);
  });

  test("runWorkflowExecution persists NULL params_override_json when not provided", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "po-absent", { run: "echo hi" });
    await runWorkflowExecution(
      makeRunParams(db, "po-absent", { conversationalRunner: async () => ({ reply: "ok" }) }),
    );
    const row = lastRunRow<{ params_override_json: string | null }>(
      db,
      "po-absent",
      "params_override_json",
    );
    expect(row.params_override_json).toBeNull();
  });

  test("runWorkflowExecution writes a workflow.run.completed audit entry on success", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "audit-ok", { run: "echo hi" });
    await runWorkflowExecution(
      makeRunParams(db, "audit-ok", { conversationalRunner: async () => ({ reply: "ok" }) }),
    );
    const entry = lastRunCompletedAudit<{ action_type: string; action_json: string }>(
      db,
      "action_type, action_json",
    );
    expect(entry.action_type).toBe("workflow.run.completed");
    const details = JSON.parse(entry.action_json) as {
      runId: string;
      workflowName: string;
      status: string;
      durationMs: number;
      dryRun: boolean;
    };
    expect(details.workflowName).toBe("audit-ok");
    expect(details.status).toBe("done");
    expect(details.dryRun).toBe(false);
    expect(typeof details.durationMs).toBe("number");
    expect(typeof details.runId).toBe("string");
  });

  test("runWorkflowExecution writes a workflow.run.completed audit entry on dry-run", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "audit-dry");
    await runWorkflowExecution(makeRunParams(db, "audit-dry", { dryRun: true }));
    const entry = lastRunCompletedAudit<{ action_json: string }>(db, "action_json");
    const details = JSON.parse(entry.action_json) as { status: string; dryRun: boolean };
    expect(details.status).toBe("preview");
    expect(details.dryRun).toBe(true);
  });

  test("runWorkflowExecution writes a workflow.run.completed audit entry with paramsOverride payload", async () => {
    const db = freshDb();
    seedOneStepWorkflow(db, "audit-po");
    await runWorkflowExecution(
      makeRunParams(db, "audit-po", {
        dryRun: true,
        paramsOverride: { "step-1": { x: 1 } },
      }),
    );
    const entry = lastRunCompletedAudit<{ action_json: string }>(db, "action_json");
    const details = JSON.parse(entry.action_json) as { paramsOverride?: Record<string, unknown> };
    expect(details.paramsOverride).toEqual({ "step-1": { x: 1 } });
  });
});

describe("runWorkflowExecution — run retention", () => {
  test("workflow run completion prunes to the last 100 runs per workflow", async () => {
    const db = freshDb();
    const { id: workflowId } = seedOneStepWorkflow(db, "retention-test", {
      id: "wf-ret-1",
    });
    seedHistoricalRuns(db, workflowId, 100, 1_000, "hist");
    await runWorkflowExecution(makeRunParams(db, "retention-test", { dryRun: true }));
    const count = db
      .query(`SELECT COUNT(*) AS c FROM workflow_run WHERE workflow_id = ?`)
      .get(workflowId) as { c: number };
    expect(count.c).toBe(100);
    expect(db.query(`SELECT id FROM workflow_run WHERE id = 'hist-0'`).get()).toBeNull();
    expect(db.query(`SELECT id FROM workflow_run WHERE id = 'hist-50'`).get()).not.toBeNull();
  });

  test("workflow run completion is a no-op on retention when under cap", async () => {
    const db = freshDb();
    const { id: workflowId } = seedOneStepWorkflow(db, "retention-no-op", {
      id: "wf-ret-2",
    });
    seedHistoricalRuns(db, workflowId, 5, 2_000, "h2");
    await runWorkflowExecution(makeRunParams(db, "retention-no-op", { dryRun: true }));
    const count = db
      .query(`SELECT COUNT(*) AS c FROM workflow_run WHERE workflow_id = ?`)
      .get(workflowId) as { c: number };
    expect(count.c).toBe(6);
  });
});
