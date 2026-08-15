import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { readGatewayState } from "./gateway-process.ts";
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
   * Runs after `connect()` and before `fn`, on the freshly built client.
   *
   * This is the seam for registering notification handlers, and anything calling a
   * HITL-gated method MUST use it to register a `consent.request` handler: the Gateway
   * blocks on `consent.respond`, and a client that never answers just times out. That
   * is not hypothetical — `connector reindex --depth full` and `nimbus workflow run`
   * both shipped without one and hung until the request timeout.
   *
   * Registration has to happen here rather than inside `fn`, because a notification can
   * arrive on the same socket chunk as the response to the first call `fn` makes.
   */
  readonly onConnect?: (c: IPCClient) => void;
}

/**
 * Connect to the Gateway, run `fn`, disconnect — the one implementation.
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
  opts.onConnect?.(client);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
