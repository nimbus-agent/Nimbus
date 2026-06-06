import type { IPCClient } from "../../src/ipc-client/index.ts";

export type CallRecord = { method: string; params: unknown };

export interface MockIpcClient {
  readonly client: IPCClient;
  readonly calls: CallRecord[];
  emit(method: string, params: unknown): void;
}

export function createMockIpcClient(
  // Each queued value is returned in order; an Error entry is thrown instead.
  responseQueue: ReadonlyArray<unknown>,
  notificationHandlers?: Map<string, (params: unknown) => void>,
): MockIpcClient {
  const calls: CallRecord[] = [];
  let idx = 0;
  const handlers = notificationHandlers ?? new Map<string, (params: unknown) => void>();
  const client = {
    call: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      if (idx >= responseQueue.length) {
        throw new Error(
          `Unexpected IPC call: response queue exhausted (got ${method}; provide more entries to createMockIpcClient)`,
        );
      }
      const r = responseQueue[idx];
      idx += 1;
      if (r instanceof Error) throw r;
      return r as T;
    },
    onNotification: (event: string, handler: (params: unknown) => void): void => {
      handlers.set(event, handler);
    },
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
  };
  const emit = (method: string, params: unknown): void => {
    handlers.get(method)?.(params);
  };
  return { client: client as unknown as IPCClient, calls, emit };
}
