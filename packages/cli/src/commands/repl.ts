// packages/cli/src/commands/repl.ts
//
// Thin production-wiring shim over `repl-core.ts`. This file STATICALLY imports
// the cli-mocks-mocked modules (`ipc-client`, `gateway-process`, and — via
// `interactive-ipc-handlers` — `@clack/prompts`) to build the real
// `ReplCoreDeps`, which places it in Bun's mock-resolution blast radius. It is
// therefore deliberately kept logic-free and is coverage-exempt
// (scripts/coverage-floor/exclusions.ts + sonar-project.properties), mirroring
// the `gateway-process.ts` ↔ `gw-state-helpers.ts` split. All testable logic
// lives in `repl-core.ts`, which the colocated test exercises directly with
// injected fakes (no cli-mocks, stable export surface on every platform).
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

/**
 * Dispatcher entry point (`nimbus repl`). Wires the production dependencies and
 * delegates to the tested `repl-core.ts` logic. Do not add logic here — add it
 * to `repl-core.ts` so it stays covered.
 */
export function runRepl(args: string[]): Promise<void> {
  return coreRunRepl(args, productionDeps);
}
