import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processEnvGet } from "./env-access.ts";
import type { PlatformPaths } from "./paths.ts";

export function gatewayStateFilePath(paths: PlatformPaths): string {
  return join(paths.dataDir, "gateway.json");
}

export type WriteGatewayStateOptions = {
  pid: number;
  socketPath: string;
  logPath?: string;
};

export function writeGatewayStateFile(paths: PlatformPaths, opts: WriteGatewayStateOptions): void {
  const envLog = processEnvGet("NIMBUS_GATEWAY_LOG_PATH");
  const logPath = opts.logPath ?? (envLog !== undefined && envLog !== "" ? envLog : undefined);
  const state: { pid: number; socketPath: string; logPath?: string } = {
    pid: opts.pid,
    socketPath: opts.socketPath,
  };
  if (logPath !== undefined) {
    state.logPath = logPath;
  }
  writeFileSync(gatewayStateFilePath(paths), `${JSON.stringify(state, undefined, 2)}\n`, "utf8");
}

export function removeGatewayStateFile(paths: PlatformPaths): void {
  try {
    unlinkSync(gatewayStateFilePath(paths));
  } catch {
    /* ignore — already gone or never written */
  }
}
