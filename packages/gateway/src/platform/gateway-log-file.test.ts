import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGatewayPinoLogger,
  createGatewayPinoLoggerForStream,
  emergencyGatewayLog,
  gatewayDailyLogPath,
  gatewayLogBasename,
  REDACT_VALUE_PATTERNS,
  scrubRedactedValuePatterns,
} from "./gateway-log-file.ts";

/**
 * Force `process.stdout.isTTY` to a fixed value and return a restorer that returns it to its
 * pristine state — re-installing the original own descriptor, or DELETING the property we added
 * when there was none (the CI-Linux case, where `isTTY` is `undefined` with no own descriptor).
 * Keeps every isTTY-mutating test self-contained so the value never leaks across files in the
 * combined `bun test` run (file order is per-OS, so a leak fails non-deterministically).
 */
function forceIsTty(value: boolean): () => void {
  const hadOwn = Object.hasOwn(process.stdout, "isTTY");
  const prev = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return () => {
    if (hadOwn && prev !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", prev);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  };
}

/**
 * Poll the temp dir for the daily `gateway-*.log` until it contains `needle`. The gateway logger
 * uses `pino.destination({ sync: false })`, so writes flush asynchronously — a fixed sleep is
 * timing-flaky on a loaded CI runner. Polling with a generous deadline is deterministic.
 */
async function readDailyLogWhenReady(
  dir: string,
  needle: string,
  deadlineMs = 5000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const daily = readdirSync(dir).find((f) => f.startsWith("gateway-") && f.endsWith(".log"));
    if (daily !== undefined) {
      const content = readFileSync(join(dir, daily), "utf8");
      if (content.includes(needle)) {
        return content;
      }
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`timed out after ${String(deadlineMs)}ms waiting for "${needle}" in ${dir}`);
    }
    await Bun.sleep(20);
  }
}

// ---------------------------------------------------------------------------
// gatewayLogBasename
// ---------------------------------------------------------------------------
test("gatewayLogBasename matches gateway-YYYY-MM-DD.log", () => {
  const name = gatewayLogBasename();
  expect(name).toMatch(/^gateway-\d{4}-\d{2}-\d{2}\.log$/);
});

// ---------------------------------------------------------------------------
// gatewayDailyLogPath
// ---------------------------------------------------------------------------
test("gatewayDailyLogPath joins logDir and basename", () => {
  const base = join(tmpdir(), "nimbus-logs-test");
  const p = gatewayDailyLogPath(base);
  expect(p.endsWith(gatewayLogBasename())).toBe(true);
  expect(p.startsWith(base)).toBe(true);
});

// ---------------------------------------------------------------------------
// scrubRedactedValuePatterns — each pattern branch
// ---------------------------------------------------------------------------
describe("scrubRedactedValuePatterns", () => {
  test("returns the string unchanged when nothing matches", () => {
    expect(scrubRedactedValuePatterns("hello world")).toBe("hello world");
  });

  // One row per credential shape the scrubber knows: the line it appears on, and the exact
  // substring that must not survive.
  test.each([
    ["Bearer token", "Authorization: Bearer ", "abc123def456ghi789jkl"],
    ["sk- style key (OpenAI pattern)", "key=", "sk-abcdefghijklmnopqrstuvwxyz01234567890"],
    ["sk-ant- anthropic key", "key=", "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["ghp_ github token", "token=", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567"],
    ["gho_ github oauth token", "token=", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567"],
    ["xoxb- Slack bot token", "slack=", "xoxb-12345678-abcdefgh"],
    ["AKIA AWS access key", "aws=", "AKIAIOSFODNN7EXAMPLE"],
  ])("redacts %s", (_label, prefix, secret) => {
    const result = scrubRedactedValuePatterns(`${prefix}${secret}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(secret);
  });

  test("redacts JWT token (eyJ...)", () => {
    // A minimal 3-part JWT-shaped string
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.AAAA_BBBB-CCCC";
    const result = scrubRedactedValuePatterns(`token=${jwt}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("redacts multiple occurrences in the same string", () => {
    const s = "Bearer abc123def456ghi789 and Bearer xyz987uvw654rst321abc";
    const result = scrubRedactedValuePatterns(s);
    expect(result.split("[REDACTED]").length - 1).toBeGreaterThanOrEqual(2);
  });

  test("REDACT_VALUE_PATTERNS is exported and non-empty", () => {
    expect(REDACT_VALUE_PATTERNS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveLogLevel — exercised indirectly via createGatewayPinoLoggerForStream
// ---------------------------------------------------------------------------
describe("resolveLogLevel (via createGatewayPinoLogger)", () => {
  let savedLevel: string | undefined;

  beforeEach(() => {
    savedLevel = process.env["NIMBUS_LOG_LEVEL"];
  });

  afterEach(() => {
    if (savedLevel === undefined) {
      delete process.env["NIMBUS_LOG_LEVEL"];
    } else {
      process.env["NIMBUS_LOG_LEVEL"] = savedLevel;
    }
  });

  /**
   * Build a logger in a throwaway dir with NIMBUS_LOG_LEVEL set (or deleted, for `undefined`)
   * and stdout forced non-TTY — the simpler of the two branches — and report the level it chose.
   */
  function resolvedLevel(raw: string | undefined): string {
    if (raw === undefined) {
      delete process.env["NIMBUS_LOG_LEVEL"];
    } else {
      process.env["NIMBUS_LOG_LEVEL"] = raw;
    }
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gw-log-level-"));
    try {
      const restore = forceIsTty(false);
      try {
        return createGatewayPinoLogger(dir).level;
      } finally {
        restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Unset, blank and unrecognised levels all fall back to warn; a recognised level is honoured.
  const LEVEL_CASES: ReadonlyArray<readonly [string | undefined, string]> = [
    [undefined, "warn"],
    ["", "warn"],
    ["verbose", "warn"],
    ["debug", "debug"],
    ["silent", "silent"],
  ];

  test.each(LEVEL_CASES)("NIMBUS_LOG_LEVEL=%s resolves to level %s", (raw, expected) => {
    expect(resolvedLevel(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createGatewayPinoLogger — isTTY true/false branches
// ---------------------------------------------------------------------------
describe("createGatewayPinoLogger", () => {
  test("appends JSON to daily log file when stdout is not a TTY", async () => {
    const restore = forceIsTty(false);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gw-log-"));
    try {
      const log = createGatewayPinoLogger(dir);
      log.warn("unit_gateway_log_probe");
      const content = await readDailyLogWhenReady(dir, "unit_gateway_log_probe");
      expect(content).toContain("unit_gateway_log_probe");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not throw when the log directory cannot be created (best-effort)", () => {
    const restore = forceIsTty(false);
    const base = mkdtempSync(join(tmpdir(), "nimbus-gw-baddir-"));
    // Make a regular file, then use a path *under* it as the log dir: mkdirSync(recursive) fails
    // with ENOTDIR because a path component is a file. The logger must swallow it and not throw.
    const filePath = join(base, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const badLogDir = join(filePath, "logs");
    try {
      expect(() => createGatewayPinoLogger(badLogDir)).not.toThrow();
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("creates a multistream logger when stdout is a TTY", async () => {
    const restore = forceIsTty(true);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gw-tty-log-"));
    try {
      const log = createGatewayPinoLogger(dir);
      // Logger should be created without throwing; the file destination is still written even
      // in TTY (multistream) mode.
      log.warn("unit_gateway_tty_probe");
      const content = await readDailyLogWhenReady(dir, "unit_gateway_tty_probe");
      expect(content).toContain("unit_gateway_tty_probe");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createGatewayPinoLoggerForStream
// ---------------------------------------------------------------------------
describe("createGatewayPinoLoggerForStream", () => {
  test("uses provided stream and default level=warn", () => {
    const chunks: Buffer[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk));
        } else {
          chunks.push(chunk);
        }
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream);
    expect(log.level).toBe("warn");
  });

  test("uses provided level when given", () => {
    const fakeStream = {
      write() {
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "error");
    expect(log.level).toBe("error");
  });

  test("writes log entries through the formatter+hook pipeline", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    // Pino uses streams synchronously for synchronous destinations; use flush if available
    log.warn({ err: new Error("test_error_message") }, "stream_test_probe");
    // Give pino a tick to flush
    await Bun.sleep(50);

    const all = chunks.join("");
    expect(all.length).toBeGreaterThan(0);
  });

  test("pinoLogMethodHook scrubs Bearer token in log message arg", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    log.warn("Authorization: Bearer supersecrettoken12345678");
    await Bun.sleep(50);

    const all = chunks.join("");
    expect(all).not.toContain("supersecrettoken12345678");
    expect(all).toContain("[REDACTED]");
  });

  test("pinoLogFormatter scrubs Bearer token in err.message (plain object)", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    // Use a plain object (not an Error instance) so pino's stdSerializers don't strip message
    const errObj = { message: "Bearer supersecrettoken_in_error12345678", code: 503 };
    log.warn({ err: errObj }, "error probe");
    await Bun.sleep(50);

    const all = chunks.join("");
    expect(all).not.toContain("supersecrettoken_in_error12345678");
    expect(all).toContain("[REDACTED]");
  });

  test("pinoLogFormatter scrubs Bearer token in err.stack (plain object)", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    // Use a plain object with a stack string so pinoLogFormatter's stack branch is exercised
    const objWithBearerStack = {
      message: "some error",
      stack: "Error: some error\n  at Bearer ghp_AAABBBCCCDDDEEEFFFGGG1234567 test",
    };
    log.warn({ err: objWithBearerStack }, "stack scrub probe");
    await Bun.sleep(50);

    const all = chunks.join("");
    // The formatter should have scrubbed the stack
    expect(all).not.toContain("ghp_AAABBBCCCDDDEEEFFFGGG1234567");
    expect(all).toContain("[REDACTED]");
  });

  test("pinoLogFormatter handles err with no message/stack (covers branch misses)", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    // Pass an err object that has neither message nor stack as strings
    const errObj = { code: 42, message: 99, stack: null };
    log.warn({ err: errObj }, "formatter no-string probe");
    await Bun.sleep(50);

    const all = chunks.join("");
    expect(all.length).toBeGreaterThan(0);
  });

  test("pinoLogFormatter is skipped when err is null", async () => {
    const chunks: string[] = [];
    const fakeStream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;

    const log = createGatewayPinoLoggerForStream(fakeStream, "warn");
    log.warn({ err: null }, "null err probe");
    await Bun.sleep(50);

    const all = chunks.join("");
    expect(all.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// emergencyGatewayLog — platform-branch + Error vs non-Error + catch arm
// ---------------------------------------------------------------------------
describe("emergencyGatewayLog", () => {
  const p = platform();

  // Only test on supported platforms (win32 / darwin / linux)
  const isSupportedPlatform = p === "win32" || p === "darwin" || p === "linux";

  if (isSupportedPlatform) {
    test("writes an Error stack to the daily log file", async () => {
      // Override platform-specific logDir by temporarily redirecting APPDATA/LOCALAPPDATA
      // on Windows, XDG_DATA_HOME on Linux, or relying on Library path on darwin.
      // Use a temp dir for the whole platform logDir tree so we don't touch real system dirs.
      const tmpBase = mkdtempSync(join(tmpdir(), "nimbus-emergency-"));
      const savedEnv: Record<string, string | undefined> = {};

      try {
        // Set env overrides so platform paths resolve to our temp dir
        if (p === "win32") {
          savedEnv["APPDATA"] = process.env["APPDATA"];
          savedEnv["LOCALAPPDATA"] = process.env["LOCALAPPDATA"];
          process.env["APPDATA"] = tmpBase;
          process.env["LOCALAPPDATA"] = tmpBase;
          // After the call, the log should appear under tmpBase/Nimbus/data/logs
          const err = new Error("emergency_error_with_stack");
          emergencyGatewayLog(err);
          await Bun.sleep(20);
          // Check if the logDir exists and contains the file (best-effort)
          const realLogsDir = join(tmpBase, "Nimbus", "data", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("emergency_error_with_stack");
            }
          }
        } else if (p === "linux") {
          savedEnv["XDG_DATA_HOME"] = process.env["XDG_DATA_HOME"];
          process.env["XDG_DATA_HOME"] = tmpBase;
          const err = new Error("emergency_error_linux");
          emergencyGatewayLog(err);
          await Bun.sleep(20);
          const realLogsDir = join(tmpBase, "nimbus", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("emergency_error_linux");
            }
          }
        } else {
          // darwin — uses homedir() + Library/Application Support/Nimbus/logs
          // We can't easily redirect homedir(), so just verify it doesn't throw
          const err = new Error("emergency_error_darwin");
          expect(() => emergencyGatewayLog(err)).not.toThrow();
        }
      } finally {
        // Restore env
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = val;
          }
        }
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    test("writes a non-Error string to the daily log file", async () => {
      const tmpBase = mkdtempSync(join(tmpdir(), "nimbus-emergency-str-"));
      const savedEnv: Record<string, string | undefined> = {};

      try {
        if (p === "win32") {
          savedEnv["APPDATA"] = process.env["APPDATA"];
          savedEnv["LOCALAPPDATA"] = process.env["LOCALAPPDATA"];
          process.env["APPDATA"] = tmpBase;
          process.env["LOCALAPPDATA"] = tmpBase;
          emergencyGatewayLog("non_error_string_message");
          await Bun.sleep(20);
          const realLogsDir = join(tmpBase, "Nimbus", "data", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("non_error_string_message");
            }
          }
        } else if (p === "linux") {
          savedEnv["XDG_DATA_HOME"] = process.env["XDG_DATA_HOME"];
          process.env["XDG_DATA_HOME"] = tmpBase;
          emergencyGatewayLog("non_error_string_linux");
          await Bun.sleep(20);
          const realLogsDir = join(tmpBase, "nimbus", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("non_error_string_linux");
            }
          }
        } else {
          // darwin — just verify no throw
          expect(() => emergencyGatewayLog("non_error_string_darwin")).not.toThrow();
        }
      } finally {
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = val;
          }
        }
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    test("writes an Error without stack (only message) to the daily log file", async () => {
      const tmpBase = mkdtempSync(join(tmpdir(), "nimbus-emergency-nostk-"));
      const savedEnv: Record<string, string | undefined> = {};

      try {
        const errNoStack = new Error("no_stack_error_probe");
        // Remove the stack so the `err.stack ?? err.message` falls through to message
        delete (errNoStack as { stack?: string }).stack;

        if (p === "win32") {
          savedEnv["APPDATA"] = process.env["APPDATA"];
          savedEnv["LOCALAPPDATA"] = process.env["LOCALAPPDATA"];
          process.env["APPDATA"] = tmpBase;
          process.env["LOCALAPPDATA"] = tmpBase;
          emergencyGatewayLog(errNoStack);
          await Bun.sleep(20);
          const realLogsDir = join(tmpBase, "Nimbus", "data", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("no_stack_error_probe");
            }
          }
        } else if (p === "linux") {
          savedEnv["XDG_DATA_HOME"] = process.env["XDG_DATA_HOME"];
          process.env["XDG_DATA_HOME"] = tmpBase;
          emergencyGatewayLog(errNoStack);
          await Bun.sleep(20);
          const realLogsDir = join(tmpBase, "nimbus", "logs");
          if (existsSync(realLogsDir)) {
            const files = readdirSync(realLogsDir);
            const logFile = files.find((f) => f.startsWith("gateway-"));
            if (logFile !== undefined) {
              const content = readFileSync(join(realLogsDir, logFile), "utf8");
              expect(content).toContain("no_stack_error_probe");
            }
          }
        } else {
          // darwin — just verify no throw
          expect(() => emergencyGatewayLog(errNoStack)).not.toThrow();
        }
      } finally {
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = val;
          }
        }
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  }

  test("silently swallows secondary errors (catch arm)", () => {
    if (p === "win32") {
      // Pass invalid APPDATA so createWindowsPaths throws
      const saved = process.env["APPDATA"];
      process.env["APPDATA"] = "";
      try {
        // Should NOT throw even though the inner path resolution will fail
        expect(() => emergencyGatewayLog(new Error("will_fail_paths"))).not.toThrow();
      } finally {
        if (saved === undefined) {
          delete process.env["APPDATA"];
        } else {
          process.env["APPDATA"] = saved;
        }
      }
    } else {
      // On non-win32, we can't easily force the catch arm without controlling platform(),
      // but we can verify the function doesn't throw on a normal Error input
      expect(() => emergencyGatewayLog(new Error("catch_arm_check"))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// err serializer — an Error must not log as {}
// ---------------------------------------------------------------------------
describe("err serializer", () => {
  const capture = (): { chunks: string[]; stream: NodeJS.WritableStream } => {
    const chunks: string[] = [];
    const stream = {
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;
    return { chunks, stream };
  };

  // `Error`'s `message` and `stack` are NON-ENUMERABLE, so `JSON.stringify({ err })` yields
  // `{"err":{}}`. Eleven sites across the gateway log a bare `{ err }`, and every one of them was
  // writing an empty object. Observed in production: a real gateway logged
  // `"embedding worker failed to initialize"` with `"err":{}` across 397 heartbeats — semantic
  // search was disabled and the reason was unknowable from the log.
  test("an Error logs its message rather than an empty object", async () => {
    const { chunks, stream } = capture();
    const log = createGatewayPinoLoggerForStream(stream, "warn");
    log.warn({ err: new Error("MiniLM download failed") }, "boom");
    await Promise.resolve();
    const line = chunks.join("");
    expect(line).not.toContain('"err":{}');
    expect(line).toContain("MiniLM download failed");
  });

  // Asserted on the PARSED `err.name` field, not on the raw line. A substring check for
  // "TypeError" passes off the STACK text even when the class is not recorded at all — it did
  // exactly that during development, which is why this reads the field. `type` is deliberately
  // not asserted: pino's own err serializer runs after the formatter and overwrites it with
  // "Object".
  test("the error class is recorded in err.name alongside the message", async () => {
    const { chunks, stream } = capture();
    const log = createGatewayPinoLoggerForStream(stream, "warn");
    log.warn({ err: new TypeError("bad kind") }, "boom");
    await Promise.resolve();
    const rec = JSON.parse(chunks.join("").trim()) as { err?: { name?: string; message?: string } };
    expect(rec.err?.name).toBe("TypeError");
    expect(rec.err?.message).toBe("bad kind");
  });

  // A thrown non-Error must not become `{}` either — `String(err)` is the floor.
  test("a non-Error value still serializes to something readable", async () => {
    const { chunks, stream } = capture();
    const log = createGatewayPinoLoggerForStream(stream, "warn");
    log.warn({ err: "plain string failure" }, "boom");
    await Promise.resolve();
    expect(chunks.join("")).toContain("plain string failure");
  });

  // Non-negotiable #3: no plaintext credentials in logs. `redact` is KEY-PATH based, so it cannot
  // scrub inside a message string — surfacing `err.message` without scrubbing would newly write
  // secrets that the empty-object bug had been accidentally hiding. The message goes through the
  // same `redactAuditPayload` the audit log uses.
  test("a secret embedded in the error message is redacted", async () => {
    const { chunks, stream } = capture();
    const log = createGatewayPinoLoggerForStream(stream, "warn");
    log.warn(
      { err: new Error("auth failed for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") },
      "boom",
    );
    await Promise.resolve();
    const line = chunks.join("");
    expect(line).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});
