# Workflow stream tagging + cancel — Implementation Plan Review & Feedback

> **HISTORICAL — do not read as current behaviour.**
>
> This is a point-in-time record of review questions raised against the *plan*,
> before the code existed. Every question below has since been answered and the
> shipped contract differs from what several of them assume. The authoritative
> description is `docs/architecture.md`; the decision log is the **Review
> triage** section of `2026-08-12-workflow-stream-tagging-cancel.md`.
>
> Resolutions, in the order the questions appear:
>
> 1. **Duplicate `streamId` — fixed, and the question understates the risk.**
>    Rejecting duplicates, as asked here, would *not* have been sufficient:
>    client A could still cancel client B's run by passing B's id. The registry
>    key is therefore composite — `clientId + NUL + streamId` — which removes
>    both the cross-client cancel and the cross-client `finally` unregister.
>    Same-client reuse of a live id is rejected `-32602` on top of that, since
>    there it really is a client bug.
> 2. **Final status — fixed.** `status` now travels in the run result, because
>    an IPC caller cannot read the `workflow_run` table. One correction to the
>    question's framing: the values are `"preview" | "done" | "error" |
>    "cancelled"` — a dry run finalises as `"preview"`, not `"done"`.
> 3. **`engine.cancelStream` cross-cancelling a workflow — no longer possible,
>    and it is enforced rather than incidental.** The composite key means a bare
>    id cannot reach a workflow run. Review also found the sharper version of
>    this: `engine.cancelStream` passed the raw client id to `registry.cancel()`
>    with no NUL guard, so a client could forge `victimClientId + NUL +
>    victimStreamId` and abort another client's run through that unscoped
>    method. `assertStreamIdHasNoNulByte` now guards every parse site.
> 4. **Check the signal before the DB insert — declined.** It would drop the
>    `workflow_run` row for a run cancelled before its first step, so a
>    requested-then-cancelled run would vanish from history instead of showing
>    as `cancelled`, and would skip `finalizeRun`'s audit event and run pruning.
>    The boundary check sits at the top of the step loop instead.
> 5. **`readonly` on the new `WorkflowRunContext` fields — declined there,
>    applied where it actually matches.** No field in `WorkflowRunContext` is
>    `readonly`; that file's established pattern is post-construction
>    conditional assignment (`if (x !== undefined) ctx.x = x`), which `readonly`
>    would break. The convention the suggestion is reaching for does hold in
>    `engine-cancel-stream.ts`, and the new `workflow-cancel.ts` follows it —
>    `WorkflowCancelParams` / `WorkflowCancelResult` are fully `readonly`, as is
>    `RunWorkflowExecutionParams.signal`.

## Open Questions (as raised — see the resolutions above)

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
