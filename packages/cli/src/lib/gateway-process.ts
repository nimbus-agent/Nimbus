// Thin re-export of the gateway-process implementation.
//
// Application code (dispatchers under `src/commands/`, lifecycle helpers
// under `src/lib/`) imports from THIS file. The shared CLI test harness
// (`packages/cli/test/helpers/cli-mocks.ts`) registers
// `mock.module("../../src/lib/gateway-process.ts", ...)` against this
// path so dispatcher tests can control `readGatewayState`/`isProcessAlive`
// via `setFixture({ gatewayState, processAlive })`.
//
// The colocated unit test imports the real implementation from
// `./gateway-process-impl.ts` instead so it isn't shadowed by the harness
// mock in combined `bun test --coverage` runs.

export type { GatewayStateFile } from "./gateway-process-impl.ts";
export {
  ensureGatewayDirs,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "./gateway-process-impl.ts";
