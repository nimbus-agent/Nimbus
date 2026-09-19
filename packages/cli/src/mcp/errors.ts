/**
 * The adapter's shared error surface.
 *
 * Lives apart from `adapter.ts` because `agent-tools.ts` needs these three runtime values while
 * `adapter.ts` imports `AGENT_TOOL_SPECS` from `agent-tools.ts` — importing them from `adapter.ts`
 * would close a runtime cycle. A separate module breaks it without reaching for a dynamic import.
 */

import { gatewayStartCommand } from "../lib/gateway-not-running.ts";

/** The "gateway is down" message, demo-aware (see `lib/gateway-not-running.ts`). */
export function gatewayDownMessage(demo: boolean): string {
  return `Nimbus Gateway is not running. Start it with: ${gatewayStartCommand(demo)}`;
}

/** Non-demo default, kept for callers that have no `demo` signal available. */
export const GATEWAY_DOWN_MESSAGE = gatewayDownMessage(false);

/** Thrown when the adapter cannot reach the Gateway (no state file, or connect failed). */
export class GatewayUnavailableError extends Error {
  constructor(opts: { demo?: boolean } = {}) {
    super(gatewayDownMessage(opts.demo === true));
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
