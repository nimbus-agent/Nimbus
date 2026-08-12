# Workflow stream tagging + cancel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller correlate and cancel a running workflow, by echoing a client-supplied `streamId` on `agent.chunk` and adding a `workflow.cancel` RPC that aborts the run at the next step boundary.

**Architecture:** `workflow.run` resolves only when the run finishes, so a server-minted id could never reach the client in time. The client therefore supplies the id. The Gateway echoes it on every chunk, registers an `AbortController` under it in the *existing* `ServerCtx.streamRegistry` (the one `engine.askStream` already uses), and `workflow.cancel` aborts that controller. The runner checks the signal between steps.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Bun test, Biome, `bun:sqlite`.

**Spec:** `nimbus-vscode` repo → `docs/superpowers/specs/2026-08-12-workflow-surface-design.md`, Part 2. (Cross-repo: the spec lives with the extension because it covers all three repos. This plan implements only its Part 2.)

## Global Constraints

- **Every wire change is additive.** Omitting `streamId` must reproduce today's behaviour byte-for-byte, and older clients must keep working against a newer Gateway. Task 1 has an explicit regression test for this; do not weaken it.
- **`packages/gateway/src/ipc/workflow-invoke.ts` must stay type-only.** It is exact-path-excluded from the coverage floor in `scripts/coverage-floor/exclusions.ts`; a type-only file emits no `SF:` lcov record, so adding runtime logic there silently bypasses the floor. Add types only.
- **Cancellation lands at the next step boundary, never mid-step.** The in-flight step runs to completion. Do not thread the signal into `executeWorkflowStep` or the LLM calls inside it — that is explicitly out of scope.
- **A cancelled run finalises with status `"cancelled"`** via the existing `finalizeRun`, so run history reflects it.
- **Reuse `ctx.streamRegistry`.** Do not create a second registry; `ServerCtx.streamRegistry` (`packages/gateway/src/ipc/server/context.ts:12`) already exists and `makeCtx` in the tests already builds a real one.
- **Register workflow runs under a per-client key, never the bare `streamId`.** The registry is created once per server (`server.ts:68`) and shared by every connected session, while the id now comes from the client. A bare id would let one client abort another client's run. Always key with `workflowRegistryKey(clientId, streamId)` (Task 3).
- **`runWorkflowExecution` reports its own terminal status.** An IPC caller cannot read the `workflow_run` table, so `status` must travel in the result. Valid values: `"preview"` (dry run), `"done"`, `"error"`, `"cancelled"`.
- Lint runs as `biome check --error-on-warnings .` — warnings fail the build.
- Run scoped tests with `bun test <paths> --timeout 30000`.

---

### Task 1: Echo an optional `streamId` on `agent.chunk`

Makes chunks correlatable. No cancellation yet.

**Files:**

- Modify: `packages/gateway/src/ipc/server/inline-handlers.ts` (`sendAgentChunkIfStreaming` ~line 43, `dispatchAgentInvoke` ~line 54, `buildWorkflowRunContext` ~line 123)
- Modify: `packages/gateway/src/ipc/workflow-invoke.ts` (type only)
- Test: `packages/gateway/src/ipc/server/inline-handlers.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `WorkflowRunContext.streamId?: string`; `sendAgentChunkIfStreaming(session, stream, text, streamId?)`. Task 3 relies on `buildWorkflowRunContext` returning `streamId` in its result object.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/ipc/server/inline-handlers.test.ts`, inside the existing `dispatchAgentInvoke` describe block:

```ts
  test("agent.chunk carries streamId when the caller supplies one", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", {
      input: "hi",
      stream: true,
      streamId: "sid-1",
    });
    (captured?.["sendChunk"] as (t: string) => void)("chunk-1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { streamId: "sid-1", text: "chunk-1" },
    });
  });

  test("agent.chunk params are unchanged when no streamId is supplied", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", { input: "hi", stream: true });
    (captured?.["sendChunk"] as (t: string) => void)("chunk-1");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { text: "chunk-1" },
    });
  });

  test("whitespace-only streamId is treated as absent", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", {
      input: "hi",
      stream: true,
      streamId: "   ",
    });
    (captured?.["sendChunk"] as (t: string) => void)("c");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { text: "c" },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/ipc/server/inline-handlers.test.ts --timeout 30000
```

Expected: the first test FAILS (params are `{ text: "chunk-1" }`, missing `streamId`). The second and third PASS already — they pin existing behaviour and must keep passing throughout.

- [ ] **Step 3: Implement the echo**

In `packages/gateway/src/ipc/server/inline-handlers.ts`, replace `sendAgentChunkIfStreaming`:

```ts
function sendAgentChunkIfStreaming(
  session: ClientSession,
  stream: boolean,
  text: string,
  streamId?: string,
): void {
  if (!stream) {
    return;
  }
  session.writeNotification({
    jsonrpc: "2.0",
    method: "agent.chunk",
    // Additive by design: without a streamId the params are byte-identical to
    // what every shipped client already parses.
    params: streamId === undefined ? { text } : { streamId, text },
  });
}
```

In `dispatchAgentInvoke`, alongside the existing `agent` parsing, add:

```ts
  const streamId = parseOptionalString(rec, "streamId");
```

and change its `sendChunk` to:

```ts
        sendChunk: (text: string) => {
          sendAgentChunkIfStreaming(session, stream, text, streamId);
        },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/ipc/server/inline-handlers.test.ts --timeout 30000
```

Expected: PASS, including both unchanged-behaviour tests.

- [ ] **Step 5: Thread `streamId` through the workflow context**

In `packages/gateway/src/ipc/workflow-invoke.ts`, add to `WorkflowRunContext` (types only — this file must emit no runtime code):

```ts
  /** Client-supplied correlation id, echoed on every agent.chunk for this run. */
  streamId?: string;
```

In `buildWorkflowRunContext` in `inline-handlers.ts`, parse it, use it in `sendChunk`, and return it. The signature's return type becomes `{ ctx: WorkflowRunContext; sessionId: string | undefined; streamId: string | undefined }`:

```ts
  const streamId = parseOptionalString(rec, "streamId");

  const ctx: WorkflowRunContext = {
    clientId,
    workflowName,
    triggeredBy,
    dryRun,
    stream,
    sendChunk: (text: string) => {
      sendAgentChunkIfStreaming(session, stream, text, streamId);
    },
  };
  if (sessionId !== undefined) ctx.sessionId = sessionId;
  if (agent !== undefined) ctx.agent = agent;
  if (paramsOverride !== undefined) ctx.paramsOverride = paramsOverride;
  if (streamId !== undefined) ctx.streamId = streamId;
  return { ctx, sessionId, streamId };
```

The conditional assignments are required by `exactOptionalPropertyTypes`; do not assign `undefined` directly.

- [ ] **Step 6: Add a workflow-side test**

Add to `inline-handlers.test.ts`, in the `dispatchWorkflowRunRpc` describe block (if none exists, create `describe("dispatchWorkflowRunRpc", () => { ... })`):

```ts
  test("workflow chunks carry the supplied streamId", async () => {
    let captured: WorkflowRunContext | undefined;
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async (c: WorkflowRunContext) => {
        captured = c;
        return { runId: "r1", dryRun: false, stepResults: [] };
      },
    });
    const { session, notifications } = makeSession();
    await dispatchWorkflowRunRpc(ctx, "client-1", session, {
      name: "nightly",
      stream: true,
      streamId: "wf-sid-1",
    });
    captured?.sendChunk("step output");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { streamId: "wf-sid-1", text: "step output" },
    });
  });
```

Import `WorkflowRunContext` as a type from `../workflow-invoke.ts`. Reuse whatever local-index helper the file's existing workflow tests use for `makeCtx({ localIndex })`; `dispatchWorkflowRunRpc` throws `-32603 "Local index is not available"` without one.

- [ ] **Step 7: Run the full scoped suites**

```bash
bun test packages/gateway/src/ipc packages/gateway/src/automation --timeout 30000
bun run lint
```

Expected: PASS, 0 failures, no lint warnings.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/server/inline-handlers.ts packages/gateway/src/ipc/server/inline-handlers.test.ts packages/gateway/src/ipc/workflow-invoke.ts
git commit -m "feat(ipc): echo an optional client-supplied streamId on agent.chunk

Untagged agent.chunk made concurrent agent.invoke and workflow runs
indistinguishable on one connection. The echo is additive: without a
streamId the params are byte-identical to today.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Abort a run at the next step boundary

Independent of Task 1 — the runner gains a signal and a `cancelled` terminal status. Nothing triggers it yet.

**Files:**

- Modify: `packages/gateway/src/automation/workflow-runner.ts` (`RunWorkflowExecutionParams` ~line 105, `executeRealRunSteps` ~line 238)
- Test: `packages/gateway/src/automation/workflow-runner-execution.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `RunWorkflowExecutionParams.signal?: AbortSignal`, and `RunWorkflowExecutionResult.status: string` (`"preview" | "done" | "error" | "cancelled"`). A cancelled run returns normally (does not throw) with the steps completed so far, writes `status = "cancelled"` to `workflow_run`, **and reports that status in its result** — an IPC caller cannot query the table.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/automation/workflow-runner-execution.test.ts`, inside the existing `describe("runWorkflowExecution (agent path)")`:

```ts
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

    const runRow = db
      .query(`SELECT status FROM workflow_run WHERE id = ?`)
      .get(r.runId) as { status: string };
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
    const runRow = db
      .query(`SELECT status FROM workflow_run WHERE id = ?`)
      .get(r.runId) as { status: string };
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

    const runRow = db
      .query(`SELECT status FROM workflow_run WHERE id = ?`)
      .get(r.runId) as { status: string };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/automation/workflow-runner-execution.test.ts --timeout 30000
```

Expected: the first two FAIL — `signal` is not a known property (typecheck) and the status is `done`, not `cancelled`. The third passes once `signal` is accepted.

- [ ] **Step 3: Add the signal and the reported status to the types**

In `packages/gateway/src/automation/workflow-runner.ts`, add to `RunWorkflowExecutionParams`:

```ts
  /**
   * Cancels the run at the NEXT STEP BOUNDARY. The in-flight step always runs
   * to completion — the signal is deliberately not threaded into step
   * execution or the LLM calls inside it.
   */
  readonly signal?: AbortSignal;
```

and to `RunWorkflowExecutionResult`, as the second field (after `runId`):

```ts
  /**
   * The run's terminal status: "preview" | "done" | "error" | "cancelled".
   * Mirrors what finalizeRun wrote to workflow_run — an IPC caller cannot read
   * that table, so a cancelled run would otherwise be indistinguishable from a
   * short one that completed.
   */
  status: string;
```

- [ ] **Step 4: Check the signal between steps and set the status on every return path**

In `executeRealRunSteps`, add the boundary check as the first statement inside the `for` loop, before the existing `const step = steps[i];`:

```ts
  for (let i = 0; i < steps.length; i++) {
    if (p.signal?.aborted === true) {
      finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled");
      return { runId, status: "cancelled", dryRun: false, stepResults };
    }
    const step = steps[i];
```

Placing it at the top of the loop is what gives both behaviours: a signal aborted before entry records zero steps, and one aborted during step N records N results.

Then add `status` to the three remaining return sites, matching what each already passes to `finalizeRun` — the typecheck will point at each one:

- in `executeDryRun`, the returned object gets `status: "preview"` (it finalises as `"preview"`, **not** `"done"`);
- in `executeRealRunSteps`, the halt-on-error return gets `status: "error"`;
- in `executeRealRunSteps`, the final return after the loop gets `status: "done"`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/automation/workflow-runner-execution.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 6: Run the scoped suites and the workflow coverage gate**

```bash
bun test packages/gateway/src/ipc packages/gateway/src/automation --timeout 30000
bun run test:coverage:workflow
bun run lint
```

Expected: PASS, and coverage stays at or above the 80% line threshold that script enforces.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/automation/workflow-runner.ts packages/gateway/src/automation/workflow-runner-execution.test.ts
git commit -m "feat(automation): cancel a workflow run at the next step boundary

Adds an optional AbortSignal to runWorkflowExecution. The in-flight step
always completes; a cancelled run finalises with status 'cancelled' so run
history reflects it rather than showing a permanently 'running' row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Register the run and add the `workflow.cancel` RPC

Ties Tasks 1 and 2 together into a reachable capability.

**Files:**

- Create: `packages/gateway/src/ipc/workflow-cancel.ts`
- Create: `packages/gateway/src/ipc/workflow-cancel.test.ts`
- Modify: `packages/gateway/src/ipc/workflow-invoke.ts` (type only)
- Modify: `packages/gateway/src/ipc/server/inline-handlers.ts` (`dispatchWorkflowRunRpc` ~line 153)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchAutomationRpc` ~line 1345)
- Modify: `packages/gateway/src/gateway-main.ts:139-150`
- Test: `packages/gateway/src/ipc/server/inline-handlers.test.ts`

**Interfaces:**

- Consumes: `buildWorkflowRunContext(...) → { ctx, sessionId, streamId }` from Task 1; `RunWorkflowExecutionParams.signal` from Task 2.
- Produces: `workflowRegistryKey(clientId: string, streamId: string) => string`, and `createWorkflowCancelHandler(registry: StreamRegistry) => (clientId: string, params: unknown) => { cancelled: boolean }`, routed as the `workflow.cancel` RPC.

**Why the key is composite:** the registry is one per server, shared by every session, and the `streamId` is now chosen by the client. Keying on the bare id would let client A abort client B's run by guessing or reusing an id, and would make A's `finally` unregister B's entry. Scoping by `clientId` removes both. A client colliding with *itself* is a client bug and is rejected loudly.

- [ ] **Step 1: Write the failing handler test**

Create `packages/gateway/src/ipc/workflow-cancel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { createStreamRegistry } from "./engine-ask-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { createWorkflowCancelHandler, workflowRegistryKey } from "./workflow-cancel.ts";

describe("createWorkflowCancelHandler", () => {
  test("aborts the calling client's run and reports cancelled", () => {
    const registry = createStreamRegistry();
    const ac = new AbortController();
    registry.register(workflowRegistryKey("client-a", "wf-1"), ac);

    const result = createWorkflowCancelHandler(registry)("client-a", { streamId: "wf-1" });

    expect(result).toEqual({ cancelled: true });
    expect(ac.signal.aborted).toBe(true);
  });

  test("one client cannot cancel another client's run with the same streamId", () => {
    const registry = createStreamRegistry();
    const ac = new AbortController();
    registry.register(workflowRegistryKey("client-b", "shared-id"), ac);

    const result = createWorkflowCancelHandler(registry)("client-a", { streamId: "shared-id" });

    expect(result).toEqual({ cancelled: false });
    expect(ac.signal.aborted).toBe(false);
  });

  test("reports cancelled: false for an unknown streamId", () => {
    const registry = createStreamRegistry();
    expect(createWorkflowCancelHandler(registry)("client-a", { streamId: "nope" })).toEqual({
      cancelled: false,
    });
  });

  test("rejects a missing or non-string streamId", () => {
    const handler = createWorkflowCancelHandler(createStreamRegistry());
    expect(() => handler("client-a", null)).toThrow(RpcMethodError);
    expect(() => handler("client-a", {})).toThrow(RpcMethodError);
    expect(() => handler("client-a", { streamId: 42 })).toThrow(RpcMethodError);
    expect(() => handler("client-a", { streamId: "" })).toThrow(RpcMethodError);
  });

  test("the key separator cannot be forged from a crafted streamId", () => {
    // A NUL separator cannot appear in a JSON-RPC string id in practice, so
    // "client-a" + "x" can never collide with another client's namespace.
    expect(workflowRegistryKey("a", "b")).not.toBe(workflowRegistryKey("a:b", ""));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test packages/gateway/src/ipc/workflow-cancel.test.ts --timeout 30000
```

Expected: FAIL — cannot resolve `./workflow-cancel.ts`.

- [ ] **Step 3: Write the handler**

Create `packages/gateway/src/ipc/workflow-cancel.ts`:

```ts
import type { StreamRegistry } from "./engine-ask-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

export type WorkflowCancelParams = { readonly streamId: string };
export type WorkflowCancelResult = { readonly cancelled: boolean };

/**
 * Workflow runs share the server-wide stream registry with engine.askStream,
 * but their id is chosen by the CLIENT rather than minted here. Scoping the
 * registry key by clientId is what stops one client aborting another's run —
 * and what stops one client's cleanup unregistering another's entry.
 *
 * NUL is the separator because it cannot appear in a practical JSON-RPC string
 * id, so no clientId/streamId pair can forge another pair's key.
 */
export function workflowRegistryKey(clientId: string, streamId: string): string {
  return `${clientId}\u0000${streamId}`;
}

/**
 * Deliberately a distinct method rather than an overload of
 * engine.cancelStream: the published client documents that no workflow cancel
 * exists, so a distinctly named RPC makes the new capability discoverable and
 * keeps ask-stream semantics unpolluted. The composite key also means
 * engine.cancelStream cannot reach a workflow run even by passing its raw id.
 *
 * Reports whether a live run was found — unlike engine.cancelStream, which
 * always answers { ok: true }.
 */
export function createWorkflowCancelHandler(
  registry: StreamRegistry,
): (clientId: string, params: unknown) => WorkflowCancelResult {
  return (clientId, params): WorkflowCancelResult => {
    if (typeof params !== "object" || params === null) {
      throw new RpcMethodError(-32602, "workflow.cancel requires { streamId: string }");
    }
    const sid = (params as { streamId?: unknown }).streamId;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new RpcMethodError(-32602, "workflow.cancel requires non-empty streamId");
    }
    return { cancelled: registry.cancel(workflowRegistryKey(clientId, sid)) };
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test packages/gateway/src/ipc/workflow-cancel.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 5: Write the failing registration test**

Add to the `dispatchWorkflowRunRpc` describe block in `packages/gateway/src/ipc/server/inline-handlers.test.ts`:

```ts
  test("registers the run under a per-client key and unregisters when it finishes", async () => {
    let seenDuringRun = false;
    let captured: WorkflowRunContext | undefined;
    const key = workflowRegistryKey("client-1", "wf-sid-2");
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async (c: WorkflowRunContext) => {
        captured = c;
        seenDuringRun = ctx.streamRegistry.has(key);
        return { runId: "r1", status: "done", dryRun: false, stepResults: [] };
      },
    });
    const { session } = makeSession();

    await dispatchWorkflowRunRpc(ctx, "client-1", session, {
      name: "nightly",
      streamId: "wf-sid-2",
    });

    expect(seenDuringRun).toBe(true);
    expect(captured?.signal).toBeDefined();
    expect(ctx.streamRegistry.has(key)).toBe(false);
    // The bare id is never a registry key.
    expect(ctx.streamRegistry.has("wf-sid-2")).toBe(false);
  });

  test("two clients may use the same streamId without colliding", async () => {
    const release: Array<() => void> = [];
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async () =>
        await new Promise((resolve) => {
          release.push(() =>
            resolve({ runId: "r", status: "done", dryRun: false, stepResults: [] }),
          );
        }),
    });
    const { session } = makeSession();

    const a = dispatchWorkflowRunRpc(ctx, "client-a", session, { name: "n", streamId: "same" });
    const b = dispatchWorkflowRunRpc(ctx, "client-b", session, { name: "n", streamId: "same" });

    expect(ctx.streamRegistry.has(workflowRegistryKey("client-a", "same"))).toBe(true);
    expect(ctx.streamRegistry.has(workflowRegistryKey("client-b", "same"))).toBe(true);

    for (const r of release) r();
    await Promise.all([a, b]);
    expect(ctx.streamRegistry.size()).toBe(0);
  });

  test("the same client reusing a live streamId is rejected", async () => {
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async () => await new Promise(() => {}),
    });
    const { session } = makeSession();

    void dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "dupe" });

    await expect(
      dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "dupe" }),
    ).rejects.toThrow(RpcMethodError);
  });

  test("unregisters even when the run throws", async () => {
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async () => {
        throw new Error("boom");
      },
    });
    const { session } = makeSession();

    await expect(
      dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "wf-sid-3" }),
    ).rejects.toThrow("boom");
    expect(ctx.streamRegistry.has(workflowRegistryKey("client-1", "wf-sid-3"))).toBe(false);
  });

  test("a run without a streamId registers nothing", async () => {
    const ctx = makeCtx({
      localIndex: makeLocalIndex(),
      workflowRunHandler: async () => ({ runId: "r1", dryRun: false, stepResults: [] }),
    });
    const { session } = makeSession();
    await dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "nightly" });
    expect(ctx.streamRegistry.size()).toBe(0);
  });
```

- [ ] **Step 6: Run it to verify it fails**

```bash
bun test packages/gateway/src/ipc/server/inline-handlers.test.ts --timeout 30000
```

Expected: FAIL — `seenDuringRun` is `false` and `captured.signal` is undefined; nothing registers anything.

- [ ] **Step 7: Add the signal to the context type**

In `packages/gateway/src/ipc/workflow-invoke.ts`, add to `WorkflowRunContext` (types only):

```ts
  /** Aborted by workflow.cancel; honoured at the next step boundary. */
  signal?: AbortSignal;
```

`WorkflowRunHandler` in the same file declares its own return shape, separate from `RunWorkflowExecutionResult`. It is what types the RPC response, so `status` has to be added there too or the field Task 2 produces never reaches the wire's type:

```ts
export type WorkflowRunHandler = (ctx: WorkflowRunContext) => Promise<{
  runId: string;
  status: string;
  dryRun: boolean;
  stepResults: Array<{ label?: string; status: string; output?: string; error?: string }>;
}>;
```

This makes `status` required of every handler stub in the tests. Update the stub added in **Task 1, Step 6** (`{ runId: "r1", dryRun: false, stepResults: [] }`) to include `status: "done"`; the typecheck will flag any others.

- [ ] **Step 8: Register and unregister in the dispatcher**

In `inline-handlers.ts`, give `buildWorkflowRunContext` a fourth parameter and assign the signal unconditionally (it is always passed, so `exactOptionalPropertyTypes` is satisfied):

```ts
function buildWorkflowRunContext(
  clientId: string,
  session: ClientSession,
  params: unknown,
  signal: AbortSignal,
): { ctx: WorkflowRunContext; sessionId: string | undefined; streamId: string | undefined } {
```

and inside, add `signal,` to the `ctx` object literal alongside `sendChunk`.

Then rewrite the body of `dispatchWorkflowRunRpc` from the `buildWorkflowRunContext` call onward:

```ts
  const ac = new AbortController();
  const {
    ctx: workflowCtx,
    sessionId,
    streamId,
  } = buildWorkflowRunContext(clientId, session, params, ac.signal);

  // The id is supplied by the CLIENT: workflow.run resolves only when the run
  // ends, so a server-minted id could never reach the caller in time to cancel.
  // That makes the key composite — a bare id is shared across every session on
  // this registry, so one client could otherwise abort another's run.
  const registryKey = streamId === undefined ? undefined : workflowRegistryKey(clientId, streamId);
  if (registryKey !== undefined) {
    if (ctx.streamRegistry.has(registryKey)) {
      throw new RpcMethodError(
        -32602,
        "workflow.run: streamId is already in use by a running workflow for this client",
      );
    }
    ctx.streamRegistry.register(registryKey, ac);
  }

  try {
    const requestStore: AgentRequestContext = {};
    if (sessionId !== undefined) {
      requestStore.sessionId = sessionId;
    }
    return await agentRequestContext.run(requestStore, async () => handler(workflowCtx));
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  } finally {
    if (registryKey !== undefined) {
      ctx.streamRegistry.unregister(registryKey);
    }
  }
```

Note `buildWorkflowRunContext` can throw on invalid params — it runs before registration, so nothing leaks. The duplicate check throws *before* `register`, so a rejected second run cannot unregister the first one's entry.

Import `workflowRegistryKey` from `../workflow-cancel.ts` at the top of `inline-handlers.ts`.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/ipc/server/inline-handlers.test.ts --timeout 30000
```

Expected: PASS.

- [ ] **Step 10: Route the RPC**

In `packages/gateway/src/ipc/server/dispatchers.ts`, add the import:

```ts
import { createWorkflowCancelHandler } from "../workflow-cancel.ts";
```

and in `tryDispatchAutomationRpc`, add the case **before** the `method.startsWith("workflow.")` fallthrough — otherwise `workflow.cancel` is swallowed by `dispatchExtensionAutomationRpc`:

```ts
  if (method === "workflow.cancel") {
    return createWorkflowCancelHandler(ctx.streamRegistry)(clientId, params);
  }
```

`clientId` is already a parameter of `tryDispatchAutomationRpc`, so nothing new needs threading.

- [ ] **Step 11: Pass the signal to the runner**

In `packages/gateway/src/gateway-main.ts`, add to the `runWorkflowExecution({...})` call inside `setWorkflowRunHandler` (after the `paramsOverride` spread):

```ts
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
```

- [ ] **Step 12: Add a routing test**

Add to `packages/gateway/src/ipc/server/server.test.ts`, following the existing `engine.cancelStream` routing test at ~line 321:

```ts
  test("workflow.cancel reaches createWorkflowCancelHandler", async () => {
    const { server, ctx } = makeTestServer();
    const ac = new AbortController();
    // Registered under the same composite key dispatchWorkflowRunRpc uses, so
    // the routing test fails if the clientId ever stops being threaded through.
    ctx.streamRegistry.register(workflowRegistryKey("test-client", "wf-route-1"), ac);

    const res = await server.handleRpc("workflow.cancel", { streamId: "wf-route-1" });

    expect(res).toEqual({ cancelled: true });
    expect(ac.signal.aborted).toBe(true);
  });
```

Match the surrounding tests' helper names and invocation style exactly — read `server.test.ts:300-340` first and mirror it rather than inventing `makeTestServer`/`handleRpc` if those are named differently there. Replace `"test-client"` with whatever clientId that harness actually dispatches under; if the helper does not expose one, assert `{ cancelled: false }` against a deliberately foreign clientId instead, so the test still proves the id is being scoped.

- [ ] **Step 13: Run everything**

```bash
bun test packages/gateway/src/ipc packages/gateway/src/automation --timeout 30000
bun run lint
bun run typecheck:no-docs
bun run audit:coverage-floor
```

Expected: PASS, 0 failures, no lint warnings, coverage floor holds.

- [ ] **Step 14: Commit**

```bash
git add packages/gateway/src/ipc/workflow-cancel.ts packages/gateway/src/ipc/workflow-cancel.test.ts packages/gateway/src/ipc/workflow-invoke.ts packages/gateway/src/ipc/server/inline-handlers.ts packages/gateway/src/ipc/server/inline-handlers.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/server.test.ts packages/gateway/src/gateway-main.ts
git commit -m "feat(ipc): add workflow.cancel

Registers a running workflow under the client-supplied streamId in the
existing stream registry, so workflow.cancel can abort it. Cancellation
takes effect at the next step boundary; the in-flight step completes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Document the new RPC

**Files:**

- Modify: the gateway's IPC method reference (locate it first: `rg -l "engine.cancelStream" docs/` — document `workflow.cancel` wherever `engine.cancelStream` is described; if there is no such doc, skip this task and say so rather than inventing a new doc file)

**Interfaces:**

- Consumes: the shipped behaviour from Tasks 1–3.
- Produces: nothing code-level.

- [ ] **Step 1: Find the reference**

```bash
rg -l "engine\.cancelStream" docs/
```

- [ ] **Step 2: Document both changes**

Add, in that file's existing style:

- `workflow.cancel` taking `{ streamId }` and returning `{ cancelled: boolean }`, where `false` means no live run of *yours* had that id.
- The optional `streamId` on `workflow.run` and `agent.invoke`, and that `agent.chunk` carries it only when one was supplied.
- That a `streamId` is scoped to the calling client: two clients may use the same id, one client cannot cancel another's run, and **`engine.cancelStream` cannot cancel a workflow** even though both share a registry internally.
- That reusing an id already live for the same client is rejected with `-32602`.
- `status` on the `workflow.run` result (`"preview" | "done" | "error" | "cancelled"`), and that it is the only way an IPC caller can tell a cancelled run from a short completed one.
- Stated plainly, not buried: **cancellation takes effect at the next step boundary, so a workflow whose current step is a long model call will not stop early.**

- [ ] **Step 3: Verify and commit**

```bash
bun run lint:markdown
git add docs/
git commit -m "docs(ipc): document workflow.cancel and streamId-tagged chunks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Part 2 of the design doc):**

| Spec requirement | Task |
| --- | --- |
| `WorkflowRunContext` gains `streamId?` / `signal?`, stays type-only | 1 (Step 5), 3 (Step 7) |
| `workflow.run` params accept optional `streamId` | 1 (Step 5) |
| `sendAgentChunkIfStreaming` echoes it; absent ⇒ unchanged | 1 (Steps 1–4) |
| Same echo on `agent.invoke` | 1 (Step 3) |
| Run registry via existing `ctx.streamRegistry`, unregister in `finally` | 3 (Steps 5–9) |
| `workflow.cancel` as a distinct RPC returning found-ness | 3 (Steps 1–4, 10) |
| Cancellation at next step boundary, `cancelled` status via `finalizeRun` | 2 |
| Backward compatibility | 1 (Step 1, second and third tests) |
| Documented limitation | 3 (handler docstring), 4 |
| Per-client registry key (review fix 1) | 3 (Steps 1, 3, 5, 8, 10, 12) |
| `status` on the run result (review fix 2) | 2 (Steps 1, 3, 4), 3 (Step 7) |

No gaps.

**Placeholder scan:** none — every code step carries real code. Task 4 Step 1 is a discovery command rather than a fixed path because the doc's location is genuinely unverified; the step says explicitly what to do if it does not exist, rather than leaving a TODO. Task 3 Step 12 likewise instructs the implementer to mirror the neighbouring test's real helper names.

**Type consistency:** `streamId: string | undefined` is the return shape from `buildWorkflowRunContext` in both Task 1 Step 5 and Task 3 Step 8; `signal` is `AbortSignal` (non-optional parameter, optional context property) in both Task 3 Step 8 and Task 2's `RunWorkflowExecutionParams`; `createWorkflowCancelHandler` returns `{ cancelled: boolean }` in the handler, its test, and the routing test.

## Review triage

Against `2026-08-12-workflow-stream-tagging-cancel-review.md`.

**1. Duplicate `streamId` registration — FIXED, and the review understates it.**
Confirmed: `streamRegistry` is created once per server (`server.ts:68`) and shared by every session in the `sessions` map. The consequence is not only that a run becomes uncancellable — **client A calling `workflow.cancel` with a guessed or reused id aborts client B's workflow.** Rejecting duplicates, as the review proposes, would not fix that: A could still cancel B's run by passing B's id. Keying the registry by `clientId` does, and the duplicate rejection is kept on top for the same-client case, where reuse is a genuine client bug.

**2. Final status in the RPC response — FIXED.**
Confirmed: an IPC caller cannot read `workflow_run`, so a run cancelled after one step was indistinguishable from a one-step run that completed — which would have made the whole feature unobservable to its only consumer. `status` now travels in the result. One correction to the review's framing: the fourth value is `"preview"`, not `"done"` — `executeDryRun` finalises as `"preview"` (`workflow-runner.ts:226`).

**3. `engine.cancelStream` cross-cancelling a workflow — RESOLVED BY FIX 1, plus documented.**
Once workflow runs are keyed `clientId\u0000streamId`, `engine.cancelStream` (which passes a bare id) can no longer reach one. Documented in Task 4 as a guarantee rather than left as accidental behaviour.

**4. Check the signal before the DB insert — DECLINED.**
This would drop the `workflow_run` row for a run cancelled before its first step, so a requested-then-cancelled run would vanish from history entirely rather than appearing as `cancelled`. Task 2's second test asserts exactly that row exists. `finalizeRun` also emits the run-completed audit event and prunes old runs; skipping the insert would need a parallel path duplicating both. The work avoided is one row insert and one `JSON.parse` in a rare race — not worth losing the audit trail. Boundary check stays at the top of the step loop.

**5. `readonly` on the new `WorkflowRunContext` fields — DECLINED for that type, already done elsewhere.**
The review says `readonly` matches the file's conventions; it does not. **No field in `WorkflowRunContext` is `readonly` today** — including `paramsOverride`, which uses `Readonly<Record<...>>` for its *value* while the property itself stays mutable. The file's established pattern is post-construction conditional assignment (`if (x !== undefined) ctx.x = x`), which `readonly` would break, forcing a conditional-spread rewrite of code this change does not otherwise touch. The convention the review is reaching for does hold in `engine-cancel-stream.ts`, and the new `workflow-cancel.ts` already follows it — `WorkflowCancelParams` and `WorkflowCancelResult` are both fully `readonly`. `RunWorkflowExecutionParams.signal` is also `readonly`, matching that type's existing `readonly paramsOverride`.

## Out of scope

Typing this in `@nimbus-dev/client` (spec Part 3) and the extension's run surface (spec Part 4) are separate PRs in separate repos. Do not touch them here.
