/*
 * Re-export barrel over the gateway-state implementation in gw-state-helpers.ts.
 *
 * Production code imports gateway-process.ts; the CLI test harness
 * (test/helpers/cli-mocks.ts) mock.module()s THIS path process-globally so
 * command tests run against a fake gateway state. That mock is process-global
 * (a known bun mock.module footgun), so a unit test that imported this path
 * would catch the leaked mock in the combined `bun test packages/cli/src` run.
 * gw-state-helpers.ts holds the real implementation and is never mocked, so
 * gateway-process.test.ts imports it directly to exercise the genuine code.
 * Keep the implementation in gw-state-helpers.ts — this file stays a barrel.
 */
export {
  ensureGatewayDirs,
  type GatewayStateFile,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "./gw-state-helpers.ts";
