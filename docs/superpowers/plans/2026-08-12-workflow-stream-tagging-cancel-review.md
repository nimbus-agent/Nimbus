# Workflow stream tagging + cancel — Implementation Plan Review & Feedback

## Open Questions

1. **Duplicate `streamId` Registration (Collision/Leakage Risk):**
   - **Context:** `ServerCtx.streamRegistry` is a shared registry across all connections/sessions. The client supplies the `streamId`.
   - **Issue:** If Client A starts a workflow run with `streamId = "foo"`, and Client B starts a run with `streamId = "foo"`, B's `AbortController` will overwrite A's in the registry. When A finishes, its `finally` block calls `unregister("foo")`, removing B's active run from the registry. Consequently, B's run can no longer be cancelled.
   - **Question:** Should we prevent duplicate `streamId` registrations in `StreamRegistry`? For example, we could throw an RPC error (e.g. `Stream ID already in use`) in `dispatchWorkflowRunRpc` or `dispatchAgentInvoke` if `ctx.streamRegistry.has(streamId)` is true.

2. **Propagating Final Status in RPC Response:**
   - **Context:** `RunWorkflowExecutionResult` currently contains `runId`, `dryRun`, and `stepResults`.
   - **Question:** When a run is cancelled, it returns normally with a partial/shorter list of steps. Does the caller receive any top-level indication of the final status (like `"cancelled"` or `"done"`) in the JSON-RPC response, or must they query the database `workflow_run` table? Should we add a `status: string` field to `RunWorkflowExecutionResult`?

3. **Interaction with `engine.cancelStream`:**
   - **Context:** Both workflows and `engine.askStream` share `ctx.streamRegistry`.
   - **Question:** Because they share the same registry and `engine.cancelStream` calls `registry.cancel(id)`, a client could cancel a workflow by calling `engine.cancelStream` with the workflow's `streamId` instead of `workflow.cancel`. Is this cross-compatibility acceptable/expected, or should we document it?

## Suggestions & Improvements

1. **Check Signal Prior to Database Insertion:**
   - **Suggestion:** In `runWorkflowExecution`, check if `p.signal?.aborted === true` *before* inserting the run into the database as `"running"` or executing any logic. If already aborted, we can directly write it to the DB as `"cancelled"` and skip any step parsing or execution.

2. **Strict Readonly Types:**
   - **Suggestion:** In `packages/gateway/src/ipc/workflow-invoke.ts`, define `streamId?: string` and `signal?: AbortSignal` as `readonly` to align with TypeScript best practices and standard type annotations in the IPC module (e.g., `readonly streamId?: string;`).
