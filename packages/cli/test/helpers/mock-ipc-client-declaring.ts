import { type CallRecord, createMockIpcClient, type MockIpcClient } from "./mock-ipc-client.ts";

/**
 * A mock for a command that sends `session.declareKind` as its first frame (Phase 10 SA3: the
 * workflow commands). The declaration gets its own empty reply and is left out of `calls`, so a
 * test finds the calls it cares about by position among the command's own methods; `allCalls`
 * keeps every frame, the declaration first.
 */
export interface DeclaringMockIpcClient extends MockIpcClient {
  readonly allCalls: CallRecord[];
}

export function createDeclaringMockIpcClient(
  responseQueue: ReadonlyArray<unknown>,
  notificationHandlers?: Map<string, (params: unknown) => void>,
): DeclaringMockIpcClient {
  const inner = createMockIpcClient([{}, ...responseQueue], notificationHandlers);
  return {
    client: inner.client,
    get calls(): CallRecord[] {
      return inner.calls.filter((c) => c.method !== "session.declareKind");
    },
    allCalls: inner.calls,
    emit: inner.emit,
  };
}
