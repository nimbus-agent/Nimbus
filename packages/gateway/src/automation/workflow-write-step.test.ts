// Phase 10 SA2 (spec § 5.1): what a workflow write step builds and how it ends.
import { describe, expect, test } from "bun:test";

import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { parseWorkflowSteps, type WriteWorkflowStep } from "./workflow-steps.ts";
import {
  buildWriteActions,
  referencedQuery,
  runWriteStep,
  type WorkflowWriteExecutor,
  type WriteStepRun,
} from "./workflow-write-step.ts";

function writeStep(
  input: Record<string, unknown>,
  tool = "gmail_thread_archive",
): WriteWorkflowStep {
  const steps = parseWorkflowSteps(
    JSON.stringify([
      {
        kind: "query",
        label: "q",
        query: { service: "gmail", type: "email", select: "metadata.threadId", limit: 10 },
      },
      { kind: "write", tool, input },
    ]),
  );
  return steps[1] as WriteWorkflowStep;
}

const FROM = { from: "q", column: "metadata.threadId" };

function run(over: Partial<WriteStepRun> = {}): WriteStepRun {
  return {
    workflowId: "wf-1",
    workflowSha256: "a".repeat(64),
    stepIndex: 1,
    runId: "run-1",
    trigger: "owner_cli",
    queries: new Map([["q", { index: 0, values: ["t1", "t2", "t3"] }]]),
    ...over,
  };
}

function executor(results: Array<ActionResult | Error>): {
  ex: WorkflowWriteExecutor;
  seen: PlannedAction[];
} {
  const seen: PlannedAction[] = [];
  let i = 0;
  return {
    seen,
    ex: {
      execute: async (a) => {
        seen.push(a);
        const r = results[i++] ?? { status: "ok", result: {} };
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

describe("buildWriteActions", () => {
  test("one action per selected id, typed by the row, naming its own tool, with provenance", () => {
    const actions = buildWriteActions(writeStep({ threadId: FROM }), run());
    expect(
      actions.map((a) => (a.payload?.["input"] as { threadId?: string } | undefined)?.threadId),
    ).toEqual(["t1", "t2", "t3"]);
    for (const a of actions) {
      expect(a.type).toBe("gmail.thread.archive");
      expect(a.payload?.["mcpToolId"]).toBe("gmail_thread_archive");
      expect(a.origin).toBeUndefined();
      expect(a.provenance).toEqual({
        kind: "owner_workflow",
        workflowId: "wf-1",
        workflowSha256: "a".repeat(64),
        stepIndex: 1,
        runId: "run-1",
        trigger: "owner_cli",
        fieldSources: { threadId: { query: 0, column: "metadata.threadId" } },
      });
    }
  });

  test("a constants-only write runs once, with fieldSources constant", () => {
    const actions = buildWriteActions(writeStep({ threadId: { const: "abc" } }), run());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload?.["input"]).toEqual({ threadId: "abc" });
    expect(actions[0]?.provenance?.fieldSources).toEqual({ threadId: "constant" });
  });

  test("mixed constants and a query column: the constant is repeated on every action", () => {
    const actions = buildWriteActions(
      writeStep({ threadId: FROM, note: { const: ["a", 1] } }),
      run({ queries: new Map([["q", { index: 0, values: ["t1", "t2"] }]]) }),
    );
    expect(actions.map((a) => a.payload?.["input"])).toEqual([
      { threadId: "t1", note: ["a", 1] },
      { threadId: "t2", note: ["a", 1] },
    ]);
  });

  test("no trigger: the same actions carry NO provenance", () => {
    const actions = buildWriteActions(writeStep({ threadId: FROM }), run({ trigger: undefined }));
    expect(actions).toHaveLength(3);
    for (const a of actions) expect(Object.hasOwn(a, "provenance")).toBe(false);
  });

  test("an ui trigger is recorded as owner_ui", () => {
    expect(
      buildWriteActions(writeStep({ threadId: FROM }), run({ trigger: "owner_ui" }))[0]?.provenance
        ?.trigger,
    ).toBe("owner_ui");
  });

  test("a query that selected nothing builds nothing", () => {
    expect(
      buildWriteActions(
        writeStep({ threadId: FROM }),
        run({ queries: new Map([["q", { index: 0, values: [] }]]) }),
      ),
    ).toEqual([]);
  });

  test("a step whose query has not run, or whose tool vanished, throws", () => {
    expect(() =>
      buildWriteActions(writeStep({ threadId: FROM }), run({ queries: new Map() })),
    ).toThrow(/has not run/);
    const ghost = { ...writeStep({ threadId: FROM }), tool: "no_such_tool" };
    expect(() => buildWriteActions(ghost, run())).toThrow(/not a connector write tool/);
  });

  test("referencedQuery", () => {
    expect(referencedQuery(writeStep({ threadId: FROM }))).toBe("q");
    expect(referencedQuery(writeStep({ threadId: { const: "x" } }))).toBeUndefined();
  });
});

describe("runWriteStep", () => {
  test("every action goes through the executor, in order; the step is done", async () => {
    const { ex, seen } = executor([]);
    const out = await runWriteStep(writeStep({ threadId: FROM }), run(), ex);
    expect(out).toEqual({
      status: "done",
      dispatched: 3,
      message: "gmail_thread_archive: 3 of 3 done",
    });
    expect(seen).toHaveLength(3);
  });

  test("no matches: skipped, the executor is never called", async () => {
    const { ex, seen } = executor([]);
    const out = await runWriteStep(
      writeStep({ threadId: FROM }),
      run({ queries: new Map([["q", { index: 0, values: [] }]]) }),
      ex,
    );
    expect(out).toEqual({ status: "skipped", dispatched: 0, message: "skipped: no matches" });
    expect(seen).toEqual([]);
  });

  test("the owner declining one stops the step: the rest are not asked", async () => {
    const { ex, seen } = executor([
      { status: "ok", result: {} },
      { status: "rejected", reason: "Action rejected by user" },
    ]);
    const out = await runWriteStep(writeStep({ threadId: FROM }), run(), ex);
    expect(out.status).toBe("error");
    expect(out.dispatched).toBe(1);
    expect(out.message).toContain("Action rejected by user");
    expect(out.message).toContain("stopped after 1 of 3");
    expect(seen).toHaveLength(2);
  });

  test("an executor that throws stops the step with its message", async () => {
    const { ex } = executor([new Error("connector down")]);
    const out = await runWriteStep(writeStep({ threadId: FROM }), run(), ex);
    expect(out).toMatchObject({ status: "error", dispatched: 0 });
    expect(out.message).toContain("connector down");
  });

  test("a throw that is not an Error is still reported", async () => {
    const ex: WorkflowWriteExecutor = {
      execute: async () => {
        throw "plain string";
      },
    };
    const out = await runWriteStep(writeStep({ threadId: FROM }), run(), ex);
    expect(out.message).toContain("plain string");
  });

  test("a cancelled run stops before the next action", async () => {
    const ac = new AbortController();
    const seen: PlannedAction[] = [];
    const ex: WorkflowWriteExecutor = {
      execute: async (a) => {
        seen.push(a);
        ac.abort();
        return { status: "ok", result: {} };
      },
    };
    const out = await runWriteStep(writeStep({ threadId: FROM }), run({ signal: ac.signal }), ex);
    expect(out).toMatchObject({ status: "error", dispatched: 1 });
    expect(out.message).toContain("cancelled after 1 of 3");
    expect(seen).toHaveLength(1);
  });
});
