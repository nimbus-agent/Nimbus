import { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { readGatewayState } from "./gateway-process.ts";

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

export async function withGatewayIpc<T>(
  fn: (c: IPCClient) => Promise<T>,
  paths: CliPlatformPaths = getCliPlatformPaths(),
): Promise<T> {
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new GatewayNotRunningError();
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
