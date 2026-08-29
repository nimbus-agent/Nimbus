import { appendFileSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import pino from "pino";

import { processEnvGet } from "./env-access.ts";
import { createDarwinPaths, createLinuxPaths, createWindowsPaths } from "./paths.ts";

export function gatewayLogBasename(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `gateway-${String(y)}-${m}-${day}.log`;
}

export function gatewayDailyLogPath(logDir: string): string {
  return join(logDir, gatewayLogBasename());
}

/**
 * Today's daily-log path for the host OS, or `null` on an unsupported platform. The single
 * per-OS resolution used by both the emergency logger and the lifecycle diagnostics — the
 * platform branching lives here, in the one file already sanctioned for it.
 */
export function platformDailyLogPath(): string | null {
  switch (platform()) {
    case "win32":
      return gatewayDailyLogPath(createWindowsPaths().logDir);
    case "darwin":
      return gatewayDailyLogPath(createDarwinPaths().logDir);
    case "linux":
      return gatewayDailyLogPath(createLinuxPaths().logDir);
    default:
      return null;
  }
}

const PINO_REDACT_PATHS: readonly string[] = [
  "*.token",
  "*.secret",
  "oauth.*",
  "*.password",
  "*.key",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "accessToken",
  "refreshToken",
  "bot_token",
  "app_password",
  "authorization",
  "Authorization",
  "*.apiKey",
  "*.api_key",
  "*.accessToken",
  "*.refreshToken",
  "*.bot_token",
  "*.app_password",
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.config.headers.authorization",
  "*.config.headers.Authorization",
  "err.headers.authorization",
  "err.headers.Authorization",
  "err.config.headers.authorization",
  "err.config.headers.Authorization",
  "err.apiKey",
  // audit-ignore-next-line D11-vault-key (log-redaction key path, not vault-key construction)
  "err.api_key",
  // audit-ignore-next-line D11-vault-key (log-redaction key path, not vault-key construction)
  "err.token",
  "err.accessToken",
];

export const REDACT_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /gho_[A-Za-z0-9]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

export function scrubRedactedValuePatterns(s: string): string {
  let out = s;
  for (const re of REDACT_VALUE_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function pinoLogFormatter(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  const e = out["err"];
  if (e !== null && typeof e === "object") {
    // An `Error`'s `message` and `stack` are NON-ENUMERABLE, so `{ ...err }` yields `{}` — the
    // scrubbing below then has nothing to scrub and pino writes `"err":{}`. Every one of the
    // gateway's bare `logger.warn({ err }, ...)` sites was logging an empty object because of
    // this line. Observed in production: "embedding worker failed to initialize; semantic search
    // disabled" logged with `"err":{}` across 397 heartbeats — the capability was off and the
    // reason was unknowable from the log.
    //
    // A pino `serializers.err` does NOT fix it: `formatters.log` runs BEFORE serializers, so the
    // spread here destroys the Error before a serializer would ever see it (verified directly —
    // adding one leaves the output as `{}`). The named properties have to be read out here.
    //
    // The class goes in `name`, not `type`: pino's own err serializer runs AFTER this formatter
    // and overwrites `type` with the constructor name of whatever plain object it receives, which
    // is always "Object" once we have converted the Error. `name` survives untouched.
    const eObj =
      e instanceof Error
        ? { name: e.name, message: e.message, stack: e.stack }
        : { ...(e as Record<string, unknown>) };
    const msg = eObj["message"];
    if (typeof msg === "string") {
      eObj["message"] = scrubRedactedValuePatterns(msg);
    }
    const stack = eObj["stack"];
    if (typeof stack === "string") {
      eObj["stack"] = scrubRedactedValuePatterns(stack);
    }
    out["err"] = eObj;
  }
  return out;
}

function pinoLogMethodHook(
  this: unknown,
  args: unknown[],
  method: (...a: unknown[]) => void,
): void {
  const scrubbed = args.map((a) => (typeof a === "string" ? scrubRedactedValuePatterns(a) : a));
  method.apply(this, scrubbed);
}

const ALLOWED_LEVELS = new Set<string>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function resolveLogLevel(): string {
  const raw = processEnvGet("NIMBUS_LOG_LEVEL");
  if (raw !== undefined && raw !== "" && ALLOWED_LEVELS.has(raw)) {
    return raw;
  }
  return "warn";
}

export function createGatewayPinoLogger(logDir: string): Logger {
  const level = resolveLogLevel();
  const logPath = gatewayDailyLogPath(logDir);
  const baseOpts = {
    level,
    redact: [...PINO_REDACT_PATHS],
    formatters: { log: pinoLogFormatter },
    hooks: { logMethod: pinoLogMethodHook },
  };

  // Ensure the target directory exists before the async destination opens it. The daily log is
  // best-effort, so directory creation must never throw out of logger construction — mkdirSync can
  // fail (EACCES/ENOSPC/EROFS); swallow it and let the destination's async `error` handler below
  // absorb the subsequent open failure (mirrors emergencyGatewayLog's defensive try/catch).
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* best-effort daily log — ignore directory-creation failures */
  }

  const fileDest = pino.destination({ dest: logPath, sync: false });
  // `sync: false` opens and flushes on a later tick via a background SonicBoom stream. Without an
  // `error` listener an async open/flush failure (e.g. the dir was removed after the logger was
  // built, as happens for short-lived loggers in tests) becomes an unhandled `error` event that
  // can crash the process or be mis-attributed to an unrelated in-flight test. The daily log is
  // best-effort: swallow these async errors rather than let them escape.
  fileDest.on("error", () => {
    /* best-effort daily log — ignore async open/flush failures */
  });

  if (process.stdout.isTTY === true) {
    return pino(
      baseOpts,
      pino.multistream([
        { level, stream: process.stdout },
        { level, stream: fileDest },
      ]),
    );
  }
  return pino(baseOpts, fileDest);
}

export function createGatewayPinoLoggerForStream(
  stream: NodeJS.WritableStream,
  level = "warn",
): Logger {
  return pino(
    {
      level,
      redact: [...PINO_REDACT_PATHS],
      formatters: { log: pinoLogFormatter },
      hooks: { logMethod: pinoLogMethodHook },
    },
    stream,
  );
}

export function emergencyGatewayLog(err: unknown): void {
  try {
    const path = platformDailyLogPath();
    if (path === null) {
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(path, `[${new Date().toISOString()}] [gateway] fatal: ${msg}\n`, "utf8");
  } catch {
    /* ignore secondary failures */
  }
}
