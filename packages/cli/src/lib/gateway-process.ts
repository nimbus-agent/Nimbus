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
// `./gw-state-helpers.ts` instead so it isn't shadowed by the harness
// mock in combined `bun test --coverage` runs. The impl file's name has
// no overlap with this one's name so Bun's mock.module path-matching
// cannot conflate the two.

export type { GatewayStateFile } from "./gw-state-helpers.ts";
export {
  ensureGatewayDirs,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "./gw-state-helpers.ts";
