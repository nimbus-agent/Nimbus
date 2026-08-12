import type { StreamRegistry } from "./engine-ask-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { assertStreamIdHasNoNulByte } from "./workflow-cancel.ts";

export type CancelStreamParams = { readonly streamId: string };
export type CancelStreamResult = { readonly ok: boolean };

export function createCancelStreamHandler(
  registry: StreamRegistry,
): (params: unknown) => CancelStreamResult {
  return (params): CancelStreamResult => {
    if (typeof params !== "object" || params === null) {
      throw new RpcMethodError(-32602, "engine.cancelStream requires { streamId: string }");
    }
    const sid = (params as { streamId?: unknown }).streamId;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new RpcMethodError(-32602, "engine.cancelStream requires non-empty streamId");
    }
    // engine.cancelStream cancels by BARE id against the same registry that
    // holds composite `clientId + SEP + streamId` workflow.run keys. Without
    // this guard a client could forge `victimClientId + SEP + victimStreamId`
    // (the clientId half is not secret — see workflow-cancel.ts) and abort
    // another client's workflow run through this unscoped method.
    assertStreamIdHasNoNulByte(sid, "engine.cancelStream");
    registry.cancel(sid);
    return { ok: true };
  };
}
