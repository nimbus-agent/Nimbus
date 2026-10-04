import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import { LocalIndex } from "../index/local-index.ts";
import { type RunWorkflowExecutionParams, runWorkflowExecution } from "./workflow-runner.ts";
import { upsertWorkflowByName } from "./workflow-store.ts";

/**
 * Coverage for the parts of `runWorkflowExecution` the other two suites never reach: the DEFAULT
 * step runner (`runConversationalAgent`, used when no `conversationalRunner` is injected), a step
 * runner that throws a non-`Error`, and a failure raised OUTSIDE a step's own try — which must
 * still finalise the run as `error` (row + audit) before propagating.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function dbWithWorkflow(name: string, steps: ReadonlyArray<Record<string, unknown>>): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  LocalIndex.ensureSchema(db);
  upsertWorkflowByName(db, name, null, JSON.stringify(steps), Date.now());
  return db;
}

function params(
  db: Database,
  workflowName: string,
  overrides: Partial<RunWorkflowExecutionParams> = {},
): RunWorkflowExecutionParams {
  return {
    db,
    agent: {} as Agent,
    workflowName,
    triggeredBy: "cli",
    dryRun: false,
    stream: false,
    sendChunk: () => {},
    ...overrides,
  };
}

type RunRow = { status: string; error_msg: string | null };

function runRow(db: Database, runId: string): RunRow | null {
  return db
    .query("SELECT status, error_msg FROM workflow_run WHERE id = ?")
    .get(runId) as RunRow | null;
}

function onlyRunRow(db: Database): RunRow & { id: string } {
  const rows = db.query("SELECT id, status, error_msg FROM workflow_run").all() as Array<
    RunRow & { id: string }
  >;
  expect(rows).toHaveLength(1);
  return rows[0] as RunRow & { id: string };
}

function completedAuditDetails(db: Database): Record<string, unknown> {
  const row = db
    .query(
      "SELECT action_json FROM audit_log WHERE action_type = 'workflow.run.completed' ORDER BY id DESC LIMIT 1",
    )
    .get() as { action_json: string } | null;
  if (row === null) throw new Error("no workflow.run.completed audit row");
  return JSON.parse(row.action_json) as Record<string, unknown>;
}

describe("runWorkflowExecution — default step runner", () => {
  test("with no conversationalRunner, each step runs through the agent with prior outputs threaded in", async () => {
    const db = dbWithWorkflow("default-runner", [
      { label: "first", run: "List my open pull requests" },
      { label: "second", run: "Summarize them for standup" },
    ]);
    const prompts: string[] = [];
    const agent = {
      generate: async (prompt: unknown) => {
        prompts.push(String(prompt));
        return { text: `reply-${String(prompts.length)}` };
      },
    } as unknown as Agent;

    const r = await runWorkflowExecution(params(db, "default-runner", { agent }));

    expect(r.status).toBe("done");
    expect(r.stepResults).toEqual([
      { label: "first", status: "done", output: "reply-1" },
      { label: "second", status: "done", output: "reply-2" },
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe("Workflow step 1 (first):\nList my open pull requests");
    expect(prompts[1]).toContain(
      "Prior step outputs (summarize, do not repeat verbatim):\nreply-1",
    );
    expect(prompts[1]).toContain("Workflow step 2 (second):\nSummarize them for standup");
    expect(runRow(db, r.runId)).toEqual({ status: "done", error_msg: null });
  });
});

describe("runWorkflowExecution — non-Error and out-of-step failures", () => {
  test("a step runner that throws a non-Error records its String() form and halts", async () => {
    const db = dbWithWorkflow("non-error-step", [{ run: "a" }, { run: "b" }]);
    let calls = 0;
    const r = await runWorkflowExecution(
      params(db, "non-error-step", {
        conversationalRunner: async () => {
          calls += 1;
          throw "quota exhausted";
        },
      }),
    );

    expect(calls).toBe(1);
    expect(r.status).toBe("error");
    expect(r.stepResults).toEqual([{ label: "step-1", status: "error", error: "quota exhausted" }]);
    expect(runRow(db, r.runId)).toEqual({ status: "error", error_msg: "quota exhausted" });
  });

  test("a failure outside the step's try (the stream banner) finalises the run as error, then rethrows", async () => {
    const db = dbWithWorkflow("banner-throws", [{ run: "a" }]);
    let runnerCalls = 0;
    const boom = new Error("client disconnected");

    await expect(
      runWorkflowExecution(
        params(db, "banner-throws", {
          stream: true,
          sendChunk: () => {
            throw boom;
          },
          conversationalRunner: async () => {
            runnerCalls += 1;
            return { reply: "never" };
          },
        }),
      ),
    ).rejects.toBe(boom);

    expect(runnerCalls).toBe(0);
    const row = onlyRunRow(db);
    expect(row.status).toBe("error");
    expect(row.error_msg).toBe("client disconnected");
    const details = completedAuditDetails(db);
    expect(details["status"]).toBe("error");
    expect(details["errorMsg"]).toBe("client disconnected");
    expect(details["runId"]).toBe(row.id);
  });

  test("a non-Error thrown outside the step's try is recorded via String() and rethrown as-is", async () => {
    const db = dbWithWorkflow("banner-throws-string", [{ run: "a" }]);

    await expect(
      runWorkflowExecution(
        params(db, "banner-throws-string", {
          stream: true,
          sendChunk: () => {
            throw 499;
          },
          conversationalRunner: async () => ({ reply: "never" }),
        }),
      ),
    ).rejects.toBe(499);

    const row = onlyRunRow(db);
    expect(row.status).toBe("error");
    expect(row.error_msg).toBe("499");
    expect(completedAuditDetails(db)["errorMsg"]).toBe("499");
  });
});
