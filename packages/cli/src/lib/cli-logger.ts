import { join } from "node:path";

import pino from "pino";

import type { CliPlatformPaths } from "../paths.ts";
// Import from the impl file so this real-implementation helper is not
// shadowed by the harness's `mock.module("../../src/lib/gateway-process.ts", ...)`
// stub when cli-logger.test.ts runs in the combined `bun test --coverage`
// process. Dispatchers under src/commands/ still use the mocked re-export.
import { ensureGatewayDirs } from "./gateway-process-impl.ts";

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
  await ensureGatewayDirs(paths);
  const logPath = join(paths.logDir, `cli-${localLogDateStamp()}.log`);
  const dest = pino.destination({ dest: logPath, sync: true });
  const logger = pino({ level: cliLogLevel() }, dest);
  return { logger, logPath };
}
