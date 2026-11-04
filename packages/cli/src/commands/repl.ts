import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../paths.ts";

import { runRepl as coreRunRepl, type ReplCoreDeps } from "./repl-core.ts";

export const productionReplDeps: ReplCoreDeps = {
  readGatewayState,
  getCliPlatformPaths,
  // The REPL holds one client for the whole session and issues a blocking
  // `agent.invoke` per turn, each of which can raise a HITL prompt answered from
  // inside the pending call.
  makeClient: (socketPath) => createIpcClient(socketPath, INTERACTIVE_RPC_TIMEOUT_MS),
  registerHandlers: (client) => {
    registerInteractiveCliIpcHandlers(client);
  },
  declareKind: declareCliClientKind,
};

export function runRepl(args: string[]): Promise<void> {
  return coreRunRepl(args, productionReplDeps);
}
