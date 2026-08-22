import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { readGatewayState } from "./gateway-process.ts";
import { registerDefaultConsentHandler } from "./interactive-ipc-handlers.ts";
import { createIpcClient } from "./rpc-timeouts.ts";

/**
 * Thrown by `withGatewayIpc` when no gateway is running. A distinct subclass
 * (rather than a bare `Error` matched by message string) lets a caller that
 * needs to distinguish "precondition failed" from "the call itself failed"
 * branch on `instanceof` without a duplicated string literal to drift out of
 * sync between this file and the catch site. `instanceof Error` still holds
 * and the message is unchanged, so every other `withGatewayIpc` caller that
 * only checks `err instanceof Error` is unaffected.
 */
export class GatewayNotRunningError extends Error {
  constructor() {
    super("Gateway is not running. Start with: nimbus start");
    this.name = "GatewayNotRunningError";
  }
}

export interface WithGatewayIpcOptions {
  /**
   * Overrides `IPCClient`'s 30s per-request bound for this client only. Supply one
   * of the named budgets in `rpc-timeouts.ts` when the call being made is answered
   * by a Gateway handler that awaits the whole operation, or can block on a HITL
   * prompt; leave unset for ordinary fast RPCs, which want the tight default.
   */
  readonly requestTimeoutMs?: number;

  /**
   * Runs after `connect()` and before `fn`, on the freshly built client — REPLACING the
   * default `consent.request` registration described below.
   *
   * This is the seam for registering notification handlers. Supplying one means taking over
   * consent for this connection: a caller that needs `agent.chunk` too, or an auto-approving
   * / scripted decision, passes the handler it wants here. A caller that passes an `onConnect`
   * registering NO consent handler re-opens the hang this default exists to close.
   *
   * Registration has to happen here rather than inside `fn`, because a notification can
   * arrive on the same socket chunk as the response to the first call `fn` makes.
   */
  readonly onConnect?: (c: IPCClient) => void;
}

/**
 * Connect to the Gateway, run `fn`, disconnect — the one implementation.
 *
 * A connection made here can ALWAYS answer a HITL prompt: with no `onConnect` supplied it
 * registers `registerDefaultConsentHandler`. That default is the fix for a failure that had
 * recurred three times — `connector reindex --depth full` and `nimbus workflow run` shipped
 * hanging on a consent prompt nobody was listening for, and `nimbus vault set`, `vault delete`
 * and `connector add --mcp` were still doing it. The Gateway's broker has no timer, so the
 * symptom is a flat 30s timeout and a mutation that silently did not happen.
 *
 * Opt-in was the wrong polarity for that: it makes forgetting silent and correct wiring
 * effortful, on a helper whose whole purpose is that commands stop re-deriving the lifecycle.
 * Inverted, a caller has to pass an `onConnect` that omits consent in order to break, and no
 * caller in the tree does — the three that pass one all register a consent handler themselves.
 *
 * Every `nimbus` command that talks to the Gateway goes through here. It used to be
 * eleven near-identical local helpers (`withIpc` in audit / clip / people / share /
 * vault / watch / connector / workflow / prove, `withConsentIpc`, `withClient` in data),
 * each re-deriving read-state -> construct -> connect -> try/finally disconnect. Six were
 * byte-identical; the rest differed only in which of `onConnect` / `requestTimeoutMs`
 * they exposed. That is now this options object, and `with-gateway-ipc.test.ts` is the
 * single place the lifecycle is tested rather than nine untested copies of it.
 */
export async function withGatewayIpc<T>(
  fn: (c: IPCClient) => Promise<T>,
  paths: CliPlatformPaths = getCliPlatformPaths(),
  opts: WithGatewayIpcOptions = {},
): Promise<T> {
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new GatewayNotRunningError();
  }
  const client = createIpcClient(state.socketPath, opts.requestTimeoutMs);
  await client.connect();
  (opts.onConnect ?? registerDefaultConsentHandler)(client);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
