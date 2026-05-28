// packages/cli/src/commands/doctor.ts
//
// Thin production-wiring shim over `doctor-core.ts`. This file STATICALLY
// imports the cli-mocks-mocked modules (`ipc-client`, `gateway-process`, and —
// transitively via `paths.ts` — the platform-specific path resolver) to build
// the real `DoctorCoreDeps`, which places it in Bun's mock-resolution +
// coverage-instrumentation blast radius. It is therefore deliberately kept
// logic-free and is coverage-exempt (scripts/coverage-floor/exclusions.ts +
// sonar-project.properties), mirroring the `repl.ts` / `gateway-process.ts`
// splits. All testable logic lives in `doctor-core.ts`, which the colocated
// test exercises directly with injected fakes (no cli-mocks, stable coverage
// scope on every platform).
import { IPCClient } from "../ipc-client/index.ts";
import { gatewayStatePath, isProcessAlive, readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

import { runDoctor as coreRunDoctor, type DoctorCoreDeps } from "./doctor-core.ts";

const productionDeps: DoctorCoreDeps = {
  getCliPlatformPaths,
  readGatewayState,
  isProcessAlive,
  gatewayStatePath,
  makeClient: (socketPath) => new IPCClient(socketPath),
};

/**
 * Dispatcher entry point (`nimbus doctor`). Wires the production dependencies
 * and delegates to the tested `doctor-core.ts` logic. Do not add logic here —
 * add it to `doctor-core.ts` so it stays covered.
 */
export function runDoctor(args: string[]): Promise<void> {
  return coreRunDoctor(args, productionDeps);
}
