import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";

import type { CliPlatformPaths } from "../paths.ts";

// We do NOT import `ensureGatewayDirs` from gateway-process here, even via
// the impl file. Bun's process-global `mock.module("../../src/lib/gateway-process.ts", ...)`
// in the shared CLI test harness somehow shadows the impl import too on
// Linux + macOS (the colocated unit test for gateway-process-impl
// observes the same failure). Inlining the `mkdir` calls keeps
// cli-logger.ts completely independent of the harness mock surface.

/** Local calendar date; same-day CLI runs append to one file. */
function localLogDateStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}

/** Defaults to `info` so each invocation is recorded; override with NIMBUS_LOG_LEVEL (same env as gateway). */
function cliLogLevel(): string {
  const raw = process.env["NIMBUS_LOG_LEVEL"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return "info";
  }
  return raw;
}

export async function createCliFileLogger(paths: CliPlatformPaths): Promise<{
  logger: pino.Logger;
  logPath: string;
}> {
  // Inlined to avoid the harness's gateway-process mock surface. Matches
  // the real `ensureGatewayDirs` implementation.
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  const logPath = join(paths.logDir, `cli-${localLogDateStamp()}.log`);
  const dest = pino.destination({ dest: logPath, sync: true });
  const logger = pino({ level: cliLogLevel() }, dest);
  return { logger, logPath };
}
