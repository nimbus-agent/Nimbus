/**
 * The IPC client shapes the MCP adapter consumes, and the runtime guards that narrow to them.
 *
 * This module deliberately imports nothing. `supportsNotifications` is a runtime VALUE, and
 * `adapter.ts` imports `AGENT_TOOL_SPECS` from `agent-tools.ts`; putting the guard in `adapter.ts`
 * would make `agent-tools.ts` need a value import back from it — precisely the runtime import cycle
 * that `errors.ts` exists to break. Keeping the guards here leaves `agent-tools.ts` with only a
 * type-only (erased) import from `adapter.ts`.
 */

/** Minimal IPC surface the adapter needs — structurally satisfied by IPCClient. */
export interface IpcCallable {
  call<T>(method: string, params?: unknown): Promise<T>;
  disconnect(): Promise<void>;
}

/**
 * A client that can also deliver gateway notifications.
 *
 * Not folded into `IpcCallable` as a required member on purpose: every `ConnectionEnv.connect`
 * implementation and every existing test fake would then need a no-op `onNotification`, including
 * fakes (peekWhy's, for one) that legitimately never receive a notification.
 */
export interface NotifyingClient extends IpcCallable {
  onNotification(method: string, handler: (params: unknown) => void): void;
}

/**
 * A client that reports an UNEXPECTED transport close. `IPCClient` implements this; it fires at
 * most once per connection and deliberately never fires on an ordinary `disconnect()`.
 */
export interface ClosableClient extends IpcCallable {
  onClose(handler: (err: Error) => void): void;
  offClose(handler: (err: Error) => void): void;
}

/** True when this connection can deliver `<agent>.briefReady` / `.briefError` notifications. */
export function supportsNotifications(client: IpcCallable): client is NotifyingClient {
  return "onNotification" in client && typeof client.onNotification === "function";
}

/** True when this connection reports unexpected transport death via `onClose`. */
export function supportsClose(client: IpcCallable): client is ClosableClient {
  return (
    "onClose" in client &&
    typeof client.onClose === "function" &&
    "offClose" in client &&
    typeof client.offClose === "function"
  );
}
