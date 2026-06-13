import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";

function isGatewayStateRaw(
  raw: unknown,
): raw is { pid: number; socketPath: string; logPath?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const o = raw as { pid?: unknown; socketPath?: unknown; logPath?: unknown };
  if (typeof o.pid !== "number" || !Number.isFinite(o.pid) || typeof o.socketPath !== "string") {
    return false;
  }
  if (o.logPath !== undefined && typeof o.logPath !== "string") {
    return false;
  }
  return true;
}

export type GatewayStateFile = {
  pid: number;
  socketPath: string;
  logPath?: string;
};

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function gatewayStatePath(paths: CliPlatformPaths): string {
  return join(paths.dataDir, "gateway.json");
}

export async function readGatewayState(
  paths: CliPlatformPaths,
): Promise<GatewayStateFile | undefined> {
  const p = gatewayStatePath(paths);
  if (!existsSync(p)) {
    return undefined;
  }
  try {
    const raw: unknown = await Bun.file(p).json();
    if (!isGatewayStateRaw(raw)) {
      return undefined;
    }
    const out: GatewayStateFile = { pid: raw.pid, socketPath: raw.socketPath };
    if (typeof raw.logPath === "string" && raw.logPath !== "") {
      out.logPath = raw.logPath;
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function ensureGatewayDirs(paths: CliPlatformPaths): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
}
