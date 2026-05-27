// Production entry point for gateway-process helpers.
//
// The shared CLI test harness (`packages/cli/test/helpers/cli-mocks.ts`)
// registers `mock.module("../../src/lib/gateway-process.ts", ...)` against
// this file so dispatcher tests can control `readGatewayState` and
// `isProcessAlive` via `setFixture({ gatewayState, processAlive })`.
//
// The implementation is INTENTIONALLY DUPLICATED with `gw-state-helpers.ts`
// rather than re-exported from it. ESM re-exports create live bindings
// shared between the source module and the re-exporting module, and Bun's
// `mock.module` on Linux + macOS propagates the mock through those live
// bindings to the source file too — which would shadow the colocated
// `gateway-process.test.ts` unit test that imports from gw-state-helpers
// directly. Owning a separate function-body declaration here cuts that
// propagation: when the harness replaces this module's exports, the
// helper file's own export bindings stay intact.

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
  /** Absolute path to the gateway log file for this spawn (if known). */
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
