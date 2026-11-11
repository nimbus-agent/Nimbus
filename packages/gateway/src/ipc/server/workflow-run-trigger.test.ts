// Phase 10 SA2 (spec § 5.1, review R1-7): the run's trigger is derived by the IPC dispatcher from the
// connection's declared client kind, never from params. A `trigger` or `provenance` key in the
// params is refused, and a `paramsOverride` keyed by a write or query step's label is refused.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { upsertWorkflowByName } from "../../automation/workflow-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { WorkflowRunContext } from "../workflow-invoke.ts";
import type { ClientKind } from "./client-kind.ts";
import type { ServerCtx } from "./context.ts";
import { dispatchWorkflowRunRpc, workflowTriggerOf } from "./inline-handlers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const STEPS = JSON.stringify([
  { kind: "run", label: "summarise", run: "say hi" },
  {
    kind: "query",
    label: "old-mail",
    query: {
      service: "gmail",
      type: "email",
      select: "metadata.threadId",
      limit: 10,
    },
  },
  {
    kind: "write",
    label: "archive-them",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "old-mail", column: "metadata.threadId" } },
  },
  {
    kind: "write",
    tool: "gmail_thread_archive",
    input: { threadId: { const: "abc" } },
  },
]);

function harness(kind: ClientKind): {
  ctx: ServerCtx;
  seen: WorkflowRunContext[];
} {
  const db = new Database(":memory:");
  dbs.push(db);
  LocalIndex.ensureSchema(db);
  upsertWorkflowByName(db, "wf", null, STEPS, Date.now());
  const seen: WorkflowRunContext[] = [];
  const ctx = {
    options: { localIndex: { getDatabase: () => db } },
    getWorkflowRunHandler: () => async (c: WorkflowRunContext) => {
      seen.push(c);
      return { runId: "r", status: "done", dryRun: false, stepResults: [] };
    },
    getClientKind: () => kind,
    streamRegistry: createStreamRegistry(),
  } as unknown as ServerCtx;
  return { ctx, seen };
}

const SESSION = {} as never;

async function codeOf(p: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcMethodError);
    return { code: (e as RpcMethodError).rpcCode, message: (e as RpcMethodError).message };
  }
  throw new Error("expected a refusal");
}

describe("the trigger comes from the declared client kind", () => {
  test("workflowTriggerOf: cli and ui only", () => {
    expect(workflowTriggerOf("cli")).toBe("owner_cli");
    expect(workflowTriggerOf("ui")).toBe("owner_ui");
    for (const k of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      expect(workflowTriggerOf(k), k).toBeUndefined();
    }
  });

  test("a cli client's run carries owner_cli; a ui client's owner_ui", async () => {
    for (const [kind, trigger] of [
      ["cli", "owner_cli"],
      ["ui", "owner_ui"],
    ] as const) {
      const { ctx, seen } = harness(kind);
      await dispatchWorkflowRunRpc(ctx, "c1", SESSION, { name: "wf" });
      expect(seen[0]?.trigger, kind).toBe(trigger);
    }
  });

  test("an unknown, mcp or chatops client's run carries no trigger, whatever its params say", async () => {
    for (const kind of ["unknown", "mcp", "chatops", "http"] as const) {
      const { ctx, seen } = harness(kind);
      await dispatchWorkflowRunRpc(ctx, "c1", SESSION, { name: "wf", triggeredBy: "owner_cli" });
      expect(seen[0]?.trigger, kind).toBeUndefined();
      // `triggeredBy` is only the history label.
      expect(seen[0]?.triggeredBy, kind).toBe("owner_cli");
    }
  });
});

describe("params that name the run's origin are refused", () => {
  test("a trigger key is refused with -32602 and the handler never runs", async () => {
    const { ctx, seen } = harness("unknown");
    const r = await codeOf(
      dispatchWorkflowRunRpc(ctx, "c1", SESSION, { name: "wf", trigger: "owner_cli" }),
    );
    expect(r.code).toBe(-32602);
    expect(r.message).toContain("trigger");
    expect(seen).toEqual([]);
  });

  test("a provenance key is refused, even for a cli client", async () => {
    const { ctx, seen } = harness("cli");
    const r = await codeOf(
      dispatchWorkflowRunRpc(ctx, "c1", SESSION, { name: "wf", provenance: { kind: "x" } }),
    );
    expect(r.code).toBe(-32602);
    expect(r.message).toContain("provenance");
    expect(seen).toEqual([]);
  });

  test("a null trigger is still a trigger key", async () => {
    const { ctx } = harness("cli");
    expect(
      (await codeOf(dispatchWorkflowRunRpc(ctx, "c1", SESSION, { name: "wf", trigger: null })))
        .code,
    ).toBe(-32602);
  });
});

describe("paramsOverride only reaches run steps", () => {
  test("a write step's label, a query step's label and a default step-N label are refused", async () => {
    for (const label of ["archive-them", "old-mail", "step-4"]) {
      const { ctx, seen } = harness("cli");
      const r = await codeOf(
        dispatchWorkflowRunRpc(ctx, "c1", SESSION, {
          name: "wf",
          paramsOverride: { [label]: { x: 1 } },
        }),
      );
      expect(r.code, label).toBe(-32602);
      expect(r.message, label).toContain(label);
      expect(seen, label).toEqual([]);
    }
  });

  test("a run step's label is allowed; so is a label no step has", async () => {
    const { ctx, seen } = harness("cli");
    await dispatchWorkflowRunRpc(ctx, "c1", SESSION, {
      name: "wf",
      paramsOverride: { summarise: { a: 1 }, nothing: { b: 2 } },
    });
    expect(seen).toHaveLength(1);
  });

  test("an unknown workflow, or one that does not parse, is left to the runner", async () => {
    const { ctx, seen } = harness("cli");
    await dispatchWorkflowRunRpc(ctx, "c1", SESSION, {
      name: "missing",
      paramsOverride: { x: { a: 1 } },
    });
    const db = (ctx.options.localIndex as unknown as { getDatabase(): Database }).getDatabase();
    upsertWorkflowByName(db, "broken", null, "{", Date.now());
    await dispatchWorkflowRunRpc(ctx, "c1", SESSION, {
      name: "broken",
      paramsOverride: { x: { a: 1 } },
    });
    expect(seen.map((s) => s.workflowName)).toEqual(["missing", "broken"]);
  });
});
