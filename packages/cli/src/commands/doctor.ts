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

export function runDoctor(args: string[]): Promise<void> {
  return coreRunDoctor(args, productionDeps);
}
