import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";

import type { CliPlatformPaths } from "../paths.ts";

function localLogDateStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}

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
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  const logPath = join(paths.logDir, `cli-${localLogDateStamp()}.log`);
  const dest = pino.destination({ dest: logPath, sync: true });
  const logger = pino({ level: cliLogLevel() }, dest);
  return { logger, logPath };
}
