import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import type { RunConversationalAgentParams } from "../engine/run-conversational-agent.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runWorkflowExecution } from "./workflow-runner.ts";
import { upsertWorkflowByName } from "./workflow-store.ts";

describe("runWorkflowExecution (agent path)", () => {
  const noopAgent = {} as Agent;

  test("runs steps sequentially and marks workflow run done", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(
      db,
      "multi",
      null,
      JSON.stringify([{ run: "first" }, { label: "B", run: "second" }]),
      now,
    );

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "multi",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      conversationalRunner: async () => ({ reply: "step-ok" }),
    });

    expect(r.dryRun).toBe(false);
    expect(r.stepResults).toEqual([
      { label: "step-1", status: "done", output: "step-ok" },
      { label: "B", status: "done", output: "step-ok" },
    ]);

    const runRow = db
      .query(`SELECT status, error_msg FROM workflow_run WHERE id = ?`)
      .get(r.runId) as { status: string; error_msg: string | null };
    expect(runRow.status).toBe("done");
    expect(runRow.error_msg).toBeNull();
  });

  test("step error halts when continueOnError is false", async () => {
    let n = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "fail-mid", null, JSON.stringify([{ run: "a" }, { run: "b" }]), now);

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "fail-mid",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      conversationalRunner: async () => {
        n += 1;
        if (n === 1) {
          return { reply: "ok" };
        }
        throw new Error("boom");
      },
    });

    expect(r.stepResults).toHaveLength(2);
    expect(r.stepResults[0]?.status).toBe("done");
    expect(r.stepResults[1]?.status).toBe("error");
    expect(r.stepResults[1]?.error).toContain("boom");

    const runRow = db
      .query(`SELECT status, error_msg FROM workflow_run WHERE id = ?`)
      .get(r.runId) as { status: string; error_msg: string | null };
    expect(runRow.status).toBe("error");
    expect(runRow.error_msg).toContain("boom");
  });

  test("continueOnError runs following steps after a failure", async () => {
    let n = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(
      db,
      "resilient",
      null,
      JSON.stringify([{ run: "bad", continueOnError: true }, { run: "good" }]),
      now,
    );

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "resilient",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      conversationalRunner: async () => {
        n += 1;
        if (n === 1) {
          throw new Error("skip");
        }
        return { reply: "recovered" };
      },
    });

    expect(r.stepResults).toEqual([
      { label: "step-1", status: "error", error: "skip" },
      { label: "step-2", status: "done", output: "recovered" },
    ]);

    const runRow = db.query(`SELECT status FROM workflow_run WHERE id = ?`).get(r.runId) as {
      status: string;
    };
    expect(runRow.status).toBe("done");
  });

  test("stream true sends step banners via sendChunk", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "one", null, JSON.stringify([{ label: "Only", run: "x" }]), now);

    const chunks: string[] = [];
    await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "one",
      triggeredBy: "cli",
      dryRun: false,
      stream: true,
      sendChunk: (t) => {
        chunks.push(t);
      },
      conversationalRunner: async (p: RunConversationalAgentParams) => {
        p.sendChunk("body");
        return { reply: "done" };
      },
    });

    expect(chunks.some((c) => c.includes("Step 1"))).toBe(true);
    expect(chunks.some((c) => c.includes("Only"))).toBe(true);
    expect(chunks.includes("body")).toBe(true);
  });

  test("an aborted run stops at the next step boundary and finalises cancelled", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(
      db,
      "cancel-mid",
      null,
      JSON.stringify([{ run: "a" }, { run: "b" }, { run: "c" }]),
      now,
    );

    const ac = new AbortController();
    let calls = 0;

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "cancel-mid",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      signal: ac.signal,
      conversationalRunner: async () => {
        calls += 1;
        // Cancel during step 1; step 1 still completes, step 2 never starts.
        if (calls === 1) ac.abort();
        return { reply: "step-ok" };
      },
    });

    expect(calls).toBe(1);
    expect(r.stepResults).toEqual([{ label: "step-1", status: "done", output: "step-ok" }]);
    expect(r.status).toBe("cancelled");

    const runRow = db.query(`SELECT status FROM workflow_run WHERE id = ?`).get(r.runId) as {
      status: string;
    };
    expect(runRow.status).toBe("cancelled");
  });

  test("a run aborted before the first step records zero steps", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "cancel-early", null, JSON.stringify([{ run: "a" }]), now);

    const ac = new AbortController();
    ac.abort();

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "cancel-early",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      signal: ac.signal,
      conversationalRunner: async () => ({ reply: "never" }),
    });

    expect(r.stepResults).toEqual([]);
    expect(r.status).toBe("cancelled");
    const runRow = db.query(`SELECT status FROM workflow_run WHERE id = ?`).get(r.runId) as {
      status: string;
    };
    expect(runRow.status).toBe("cancelled");
  });

  test("an unaborted signal does not change a normal run", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "no-cancel", null, JSON.stringify([{ run: "a" }]), now);

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "no-cancel",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      signal: new AbortController().signal,
      conversationalRunner: async () => ({ reply: "step-ok" }),
    });

    const runRow = db.query(`SELECT status FROM workflow_run WHERE id = ?`).get(r.runId) as {
      status: string;
    };
    expect(runRow.status).toBe("done");
    expect(r.status).toBe("done");
  });

  test("a dry run reports status preview", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "preview-me", null, JSON.stringify([{ run: "a" }]), now);

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "preview-me",
      triggeredBy: "cli",
      dryRun: true,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      conversationalRunner: async () => ({ reply: "never" }),
    });

    expect(r.status).toBe("preview");
  });

  test("a halted run reports status error", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertWorkflowByName(db, "boom", null, JSON.stringify([{ run: "a" }, { run: "b" }]), now);

    const r = await runWorkflowExecution({
      db,
      agent: noopAgent,
      workflowName: "boom",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {
        /* noop */
      },
      conversationalRunner: async () => {
        throw new Error("step blew up");
      },
    });

    expect(r.status).toBe("error");
  });
});
