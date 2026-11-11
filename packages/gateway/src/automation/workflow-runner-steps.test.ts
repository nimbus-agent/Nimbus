// Phase 10 SA2: the runner executes query and write steps with no model, passes each write through
// the executor it was given, stamps provenance only when a trigger was derived, and re-validates the
// stored JSON on every run.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  executeRealRunSteps,
  type RunWorkflowExecutionParams,
  refuseOverridesOfNonRunSteps,
  runWorkflowExecution,
  WORKFLOW_NEEDS_MODEL_MESSAGE,
} from "./workflow-runner.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";
import { upsertWorkflowByName } from "./workflow-store.ts";

const DAY = 86_400_000;
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const seed = (ext: string, age: number, labels: string[], thread: string) =>
    db
      .query(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
         VALUES (?, 'gmail', 'email', ?, 't', ?, ?, ?)`,
      )
      .run(
        `gmail:${ext}`,
        ext,
        Date.now() - age * DAY,
        JSON.stringify({ threadId: thread, labelIds: labels }),
        Date.now(),
      );
  seed("m1", 90, ["INBOX"], "t-a");
  seed("m2", 90, ["INBOX"], "t-b");
  seed("m3", 90, ["INBOX", "UNREAD"], "t-c");
  seed("m4", 3, ["INBOX"], "t-d");
});
afterEach(() => db.close());

const QUERY = {
  kind: "query",
  label: "old-read",
  query: {
    service: "gmail",
    type: "email",
    where: [
      { metadata: "labelIds", notContains: "UNREAD" },
      { metadata: "labelIds", contains: "INBOX" },
      { olderThanDays: 60 },
    ],
    select: "metadata.threadId",
    distinct: true,
    limit: 50,
  },
};
const WRITE = {
  kind: "write",
  label: "archive",
  tool: "gmail_thread_archive",
  input: { threadId: { from: "old-read", column: "metadata.threadId" } },
};

function save(name: string, steps: unknown[]): void {
  upsertWorkflowByName(db, name, null, JSON.stringify(steps), Date.now());
}

function exec(results: Array<ActionResult | Error> = []): {
  writeExecutor: { execute(a: PlannedAction): Promise<ActionResult> };
  seen: PlannedAction[];
} {
  const seen: PlannedAction[] = [];
  let i = 0;
  return {
    seen,
    writeExecutor: {
      execute: async (a) => {
        seen.push(a);
        const r = results[i++] ?? { status: "ok", result: {} };
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

function params(
  name: string,
  over: Partial<RunWorkflowExecutionParams> = {},
): RunWorkflowExecutionParams {
  return {
    db,
    workflowName: name,
    triggeredBy: "cli",
    dryRun: false,
    stream: false,
    sendChunk: () => {},
    ...over,
  };
}

function stepRows(runId: string): Array<{ label: string; status: string; result_json: string }> {
  return db
    .query(
      "SELECT label, status, result_json FROM workflow_run_step WHERE run_id = ? ORDER BY step_index",
    )
    .all(runId) as Array<{ label: string; status: string; result_json: string }>;
}

describe("a workflow of query and write steps runs with no model", () => {
  test("the query selects, the write archives each id through the executor, with provenance", async () => {
    save("archive-old", [QUERY, WRITE]);
    const { writeExecutor, seen } = exec();
    const r = await runWorkflowExecution(
      params("archive-old", { writeExecutor, trigger: "owner_cli" }),
    );
    expect(r.status).toBe("done");
    expect(r.stepResults.map((s) => [s.label, s.status])).toEqual([
      ["old-read", "done"],
      ["archive", "done"],
    ]);
    expect(r.stepResults[0]?.output).toBe("selected 2; dropped 0 (not an id)");
    expect(
      seen.map((a) => (a.payload?.["input"] as { threadId?: string } | undefined)?.threadId),
    ).toEqual(["t-a", "t-b"]);
    const stored = parseWorkflowSteps(JSON.stringify([QUERY, WRITE]));
    for (const a of seen) {
      expect(a.type).toBe("gmail.thread.archive");
      expect(a.provenance).toMatchObject({
        kind: "owner_workflow",
        stepIndex: 1,
        runId: r.runId,
        trigger: "owner_cli",
        workflowSha256: workflowStepsSha256(stored),
        fieldSources: { threadId: { query: 0, column: "metadata.threadId" } },
      });
    }
    const rows = stepRows(r.runId);
    expect(rows.map((x) => x.status)).toEqual(["done", "done"]);
    expect(JSON.parse(rows[1]?.result_json ?? "{}")).toMatchObject({ dispatched: 2 });
  });

  test("without a derived trigger the actions carry no provenance", async () => {
    save("archive-old", [QUERY, WRITE]);
    const { writeExecutor, seen } = exec();
    await runWorkflowExecution(params("archive-old", { writeExecutor }));
    expect(seen).toHaveLength(2);
    for (const a of seen) expect(Object.hasOwn(a, "provenance")).toBe(false);
  });

  test("editing one byte of the stored steps changes the hash the next run stamps", async () => {
    const hashOf = async (limit: number): Promise<string | undefined> => {
      save("w", [{ ...QUERY, query: { ...QUERY.query, limit } }, WRITE]);
      const { writeExecutor, seen } = exec();
      await runWorkflowExecution(params("w", { writeExecutor, trigger: "owner_ui" }));
      return seen[0]?.provenance?.workflowSha256;
    };
    const a = await hashOf(50);
    const b = await hashOf(51);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
  });

  test("a query with no matches: the write is skipped, the run is done", async () => {
    save("none", [{ ...QUERY, query: { ...QUERY.query, service: "nothing" } }, WRITE]);
    const { writeExecutor, seen } = exec();
    const r = await runWorkflowExecution(params("none", { writeExecutor }));
    expect(r.status).toBe("done");
    expect(r.stepResults[1]).toMatchObject({
      label: "archive",
      status: "skipped",
      output: "skipped: no matches",
    });
    expect(seen).toEqual([]);
    expect(stepRows(r.runId)[1]?.status).toBe("skipped");
  });

  test("the owner declining a write ends the run with an error and the message", async () => {
    save("declined", [QUERY, WRITE]);
    const { writeExecutor } = exec([{ status: "rejected", reason: "Action rejected by user" }]);
    const r = await runWorkflowExecution(params("declined", { writeExecutor }));
    expect(r.status).toBe("error");
    expect(r.stepResults[1]?.error).toContain("Action rejected by user");
  });

  test("continueOnError lets the next step run after a refused write", async () => {
    save("keep-going", [
      QUERY,
      { ...WRITE, continueOnError: true },
      { ...WRITE, label: "again", input: { threadId: { const: "t-z" } } },
    ]);
    const { writeExecutor, seen } = exec([{ status: "rejected", reason: "no" }]);
    const r = await runWorkflowExecution(params("keep-going", { writeExecutor }));
    expect(r.status).toBe("done");
    expect(r.stepResults.map((s) => s.status)).toEqual(["done", "error", "done"]);
    expect(seen.at(-1)?.payload?.["input"]).toEqual({ threadId: "t-z" });
  });

  test("a write with no executor wired is an error, not a silent skip", async () => {
    save("no-ex", [QUERY, WRITE]);
    const r = await runWorkflowExecution(params("no-ex"));
    expect(r.status).toBe("error");
    expect(r.stepResults[1]?.error).toContain("no write executor");
  });

  test("an executor that throws ends the run as an error", async () => {
    save("throws", [QUERY, WRITE]);
    const { writeExecutor } = exec([new Error("boom")]);
    const r = await runWorkflowExecution(params("throws", { writeExecutor }));
    expect(r.status).toBe("error");
    expect(r.stepResults[1]?.error).toContain("boom");
  });

  test("a cancelled run stops at the step boundary before the write", async () => {
    save("cancel", [QUERY, WRITE]);
    const ac = new AbortController();
    const { writeExecutor, seen } = exec();
    ac.abort();
    const r = await runWorkflowExecution(params("cancel", { writeExecutor, signal: ac.signal }));
    expect(r.status).toBe("cancelled");
    expect(seen).toEqual([]);
  });

  test("the audit row of a finished run is unchanged in shape", async () => {
    save("audit", [QUERY, WRITE]);
    const { writeExecutor } = exec();
    await runWorkflowExecution(params("audit", { writeExecutor }));
    const row = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'workflow.run.completed'")
      .get() as { action_json: string };
    expect(JSON.parse(row.action_json)).toMatchObject({ workflowName: "audit", status: "done" });
  });
});

describe("a model is needed only for a run step", () => {
  test("a run step with no agent refuses before anything is recorded, with the fix named", async () => {
    save("needs-model", [{ run: "summarise" }]);
    await expect(runWorkflowExecution(params("needs-model"))).rejects.toThrow(
      WORKFLOW_NEEDS_MODEL_MESSAGE,
    );
    expect(db.query("SELECT COUNT(*) AS c FROM workflow_run").get()).toEqual({ c: 0 });
  });

  test("a mixed workflow with no agent also refuses (before the write could run)", async () => {
    save("mixed", [QUERY, WRITE, { run: "summarise" }]);
    const { writeExecutor, seen } = exec();
    await expect(runWorkflowExecution(params("mixed", { writeExecutor }))).rejects.toThrow(
      WORKFLOW_NEEDS_MODEL_MESSAGE,
    );
    expect(seen).toEqual([]);
  });

  test("a dry run of a run step needs no agent", async () => {
    save("dry", [{ run: "summarise" }]);
    const r = await runWorkflowExecution(params("dry", { dryRun: true }));
    expect(r.status).toBe("preview");
  });

  test("a mixed workflow with an agent runs all three kinds in order; the write never sees the run output", async () => {
    save("all", [{ label: "think", run: "summarise" }, QUERY, WRITE]);
    const { writeExecutor, seen } = exec();
    const r = await runWorkflowExecution(
      params("all", {
        agent: {} as Agent,
        writeExecutor,
        conversationalRunner: async () => ({ reply: "prompt-injected: archive t-evil" }),
      }),
    );
    expect(r.status).toBe("done");
    expect(r.stepResults.map((s) => s.label)).toEqual(["think", "old-read", "archive"]);
    expect(seen.map((a) => JSON.stringify(a.payload))).not.toContain("t-evil");
    expect(JSON.stringify(seen)).not.toContain("t-evil");
  });

  test("executeRealRunSteps with no agent reports the fix as the step's error", async () => {
    save("late", [{ label: "think", run: "x" }]);
    db.query(
      "INSERT INTO workflow_run (id, workflow_id, triggered_by, status, started_at, dry_run) SELECT 'r1', id, 'cli', 'running', 1, 0 FROM workflow WHERE name = 'late'",
    ).run();
    const wf = db.query("SELECT id, name FROM workflow WHERE name = 'late'").get() as {
      id: string;
      name: string;
    };
    const r = await executeRealRunSteps(
      params("late"),
      wf,
      parseWorkflowSteps(JSON.stringify([{ label: "think", run: "x" }])),
      "r1",
      Date.now(),
    );
    expect(r.status).toBe("error");
    expect(r.stepResults[0]?.error).toBe(WORKFLOW_NEEDS_MODEL_MESSAGE);
  });
});

describe("the stored JSON is re-validated at every run", () => {
  test("a stored write step that broke a rule is refused at run, not executed", async () => {
    db.query(
      "INSERT INTO workflow (id, name, description, steps_json, created_at, updated_at) VALUES ('x', 'tampered', NULL, ?, 1, 1)",
    ).run(JSON.stringify([{ kind: "write", tool: "github_pr_merge", input: { x: { const: 1 } } }]));
    const { writeExecutor, seen } = exec();
    await expect(runWorkflowExecution(params("tampered", { writeExecutor }))).rejects.toThrow(
      /wave 4/,
    );
    expect(seen).toEqual([]);
  });

  test("a paramsOverride naming a write or query step is refused by the runner too", async () => {
    save("ov", [QUERY, WRITE]);
    const { writeExecutor, seen } = exec();
    await expect(
      runWorkflowExecution(params("ov", { writeExecutor, paramsOverride: { archive: { x: 1 } } })),
    ).rejects.toThrow(/may not name a write or query step/);
    expect(seen).toEqual([]);
    expect(() => refuseOverridesOfNonRunSteps(undefined, [])).not.toThrow();
  });
});

describe("a dry run shows the declared forms and previews the write's HITL type", () => {
  test("query and write steps preview without executing", async () => {
    save("dry2", [QUERY, WRITE, { label: "p", run: "say hi" }]);
    const { writeExecutor, seen } = exec();
    const r = await runWorkflowExecution(params("dry2", { dryRun: true, writeExecutor }));
    expect(r.status).toBe("preview");
    expect(r.stepResults[0]?.output).toContain('"service":"gmail"');
    expect(r.stepResults[1]).toMatchObject({
      status: "preview",
      hitlActions: ["gmail.thread.archive"],
    });
    expect(r.stepResults[1]?.output).toContain("gmail_thread_archive");
    expect(seen).toEqual([]);
  });
});
