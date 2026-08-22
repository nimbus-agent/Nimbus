import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { readGatewayState } from "./gateway-process.ts";
import { type ConsentChoice, registerConsentFor } from "./interactive-ipc-handlers.ts";
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
   * WHICH consent handler this connection answers `consent.request` with — never WHETHER
   * it has one. Omit for the default, an interactive prompt.
   *
   * This used to be a free `onConnect: (c: IPCClient) => void` callback, and that was the
   * shape of the bug: a caller could pass a function that registered nothing, or forget the
   * option entirely, and the omission was invisible until a HITL-gated call sat there for
   * 30s. A closed vocabulary cannot express "no consent handler", so the failure is gone
   * rather than guarded — there is no longer a wrong value to pass.
   *
   * Every consent behaviour in the tree is one of these three. If a fourth is ever needed,
   * it is added here as a variant, which is a deliberate reviewable act; the thing that must
   * not be possible is silently ending up with none. Registration happens between `connect()`
   * and `fn` because a notification can arrive on the same socket chunk as the response to
   * the first call `fn` makes.
   */
  readonly consent?: ConsentChoice;
}

/**
 * Connect to the Gateway, run `fn`, disconnect — the one implementation.
 *
 * A connection made here can ALWAYS answer a HITL prompt — unconditionally, with no option
 * that turns it off. That closes a failure which had recurred three times: `connector reindex
 * --depth full` and `nimbus workflow run` shipped hanging on a consent prompt nobody was
 * listening for, and `nimbus vault set`, `vault delete` and `connector add --mcp` were still
 * doing it. The Gateway's broker has no timer, so the symptom is a flat 30s client timeout and
 * a mutation that silently did not happen.
 *
 * Every `nimbus` command that talks to the Gateway goes through here. It used to be
 * eleven near-identical local helpers (`withIpc` in audit / clip / people / share /
 * vault / watch / connector / workflow / prove, `withConsentIpc`, `withClient` in data),
 * each re-deriving read-state -> construct -> connect -> try/finally disconnect. Six were
 * byte-identical; the rest differed only in which options they exposed. That is now this
 * options object, and `with-gateway-ipc.test.ts` is the single place the lifecycle is tested
 * rather than nine untested copies of it.
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
  registerConsentFor(client, opts.consent ?? { kind: "prompt" });
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
