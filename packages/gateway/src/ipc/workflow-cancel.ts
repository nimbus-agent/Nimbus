import type { StreamRegistry } from "./engine-ask-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

export type WorkflowCancelParams = { readonly streamId: string };
export type WorkflowCancelResult = { readonly cancelled: boolean };

const KEY_SEPARATOR = "\u0000";

/**
 * Workflow runs share the server-wide stream registry with engine.askStream,
 * but their id is chosen by the CLIENT rather than minted here. Scoping the
 * registry key by clientId is what stops one client aborting another's run —
 * and what stops one client's cleanup unregistering another's entry.
 *
 * The separator alone does not make a forged key impossible: a streamId that
 * itself contained the separator byte could splice together a crafted
 * `clientId + SEP + streamId` pair that collides with a victim's key — and a
 * client's own id is not secret (`triggeredBy` defaults to it and is
 * returned by workflowListRuns). What actually closes that gap is pairing
 * the separator with `assertStreamIdHasNoNulByte`, applied at every point a
 * client-supplied streamId is parsed (workflow.run and workflow.cancel), so
 * no streamId can ever contain the separator byte in the first place.
 */
export function workflowRegistryKey(clientId: string, streamId: string): string {
  return `${clientId}${KEY_SEPARATOR}${streamId}`;
}

/**
 * Rejects a streamId containing the registry key's separator byte. Must be
 * called at every site that parses a client-supplied streamId destined for
 * this registry (workflow.run and workflow.cancel) — see the note on
 * `workflowRegistryKey` for why the separator alone is not sufficient.
 */
export function assertStreamIdHasNoNulByte(streamId: string, context: string): void {
  if (streamId.includes(KEY_SEPARATOR)) {
    throw new RpcMethodError(-32602, `${context}: streamId must not contain a NUL character`);
  }
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
    const raw = (params as { streamId?: unknown }).streamId;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new RpcMethodError(-32602, "workflow.cancel requires non-empty streamId");
    }
    // Must match workflow.run's parsing exactly (inline-handlers.ts's
    // parseOptionalString also trims) — otherwise a run registered under a
    // trimmed streamId could never be looked up here by its untrimmed form.
    const sid = raw.trim();
    assertStreamIdHasNoNulByte(sid, "workflow.cancel");
    return { cancelled: registry.cancel(workflowRegistryKey(clientId, sid)) };
  };
}
