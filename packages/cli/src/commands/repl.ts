import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";

import { runRepl as coreRunRepl, type ReplCoreDeps } from "./repl-core.ts";

const productionDeps: ReplCoreDeps = {
  readGatewayState,
  getCliPlatformPaths,
  makeClient: (socketPath) => new IPCClient(socketPath),
  registerHandlers: (client) => {
    registerInteractiveCliIpcHandlers(client);
  },
};

export function runRepl(args: string[]): Promise<void> {
  return coreRunRepl(args, productionDeps);
}
