/**
 * The adapter's shared error surface.
 *
 * Lives apart from `adapter.ts` because `agent-tools.ts` needs these three runtime values while
 * `adapter.ts` imports `AGENT_TOOL_SPECS` from `agent-tools.ts` — importing them from `adapter.ts`
 * would close a runtime cycle. A separate module breaks it without reaching for a dynamic import.
 */

export const GATEWAY_DOWN_MESSAGE = "Nimbus Gateway is not running. Start it with: nimbus start";

/** Thrown when the adapter cannot reach the Gateway (no state file, or connect failed). */
export class GatewayUnavailableError extends Error {
  constructor() {
    super(GATEWAY_DOWN_MESSAGE);
    this.name = "GatewayUnavailableError";
  }
}

const DISCONNECT_MESSAGES: ReadonlySet<string> = new Set([
  "IPC client is not connected",
  "IPC connection closed",
  "IPC connection error",
]);

/**
 * True when an error is one of IPCClient's transport-dead messages and a reconnect is warranted.
 *
 * Typed as a predicate so a caller that must pass the error on (the reconnect wrapper hands it to
 * `failBriefsForClient`) does so without asserting `e as Error` on a `catch`-bound `unknown`.
 */
export function isDisconnectError(e: unknown): e is Error {
  return e instanceof Error && DISCONNECT_MESSAGES.has(e.message);
}
