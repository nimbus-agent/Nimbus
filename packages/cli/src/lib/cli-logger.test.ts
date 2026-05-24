// packages/cli/src/lib/cli-logger.test.ts
//
// Phase 6 commit 4 of 14 — covers `createCliFileLogger`, the
// `NIMBUS_LOG_LEVEL` resolver, and the calendar-date-stamped log path.
//
// `ensureGatewayDirs` is not mocked by the shared harness, so the test
// points `CliPlatformPaths` at a real temp directory and lets the file
// logger create its destination on disk. Pino's `destination({ sync })`
// writes synchronously, so reading the file back is deterministic.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import { createCliFileLogger } from "./cli-logger.ts";

const ORIG_LOG_LEVEL = process.env["NIMBUS_LOG_LEVEL"];

afterAll(() => {
  if (ORIG_LOG_LEVEL === undefined) delete process.env["NIMBUS_LOG_LEVEL"];
  else process.env["NIMBUS_LOG_LEVEL"] = ORIG_LOG_LEVEL;
});

function makePaths(root: string): CliPlatformPaths {
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "data", "logs"),
    socketPath: join(root, "fake.sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

describe("createCliFileLogger", () => {
  let dir: string;
  let paths: CliPlatformPaths;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-cli-logger-"));
    paths = makePaths(dir);
    delete process.env["NIMBUS_LOG_LEVEL"];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIG_LOG_LEVEL === undefined) delete process.env["NIMBUS_LOG_LEVEL"];
    else process.env["NIMBUS_LOG_LEVEL"] = ORIG_LOG_LEVEL;
  });

  test("writes a log file under the resolved logDir using the local calendar date", async () => {
    const { logger, logPath } = await createCliFileLogger(paths);

    // logPath lives under logDir; basename matches `cli-YYYY-MM-DD.log`.
    expect(dirname(logPath)).toBe(paths.logDir);
    const baseRe = /^cli-\d{4}-\d{2}-\d{2}\.log$/;
    const base = logPath.slice(dirname(logPath).length + 1);
    expect(baseRe.test(base)).toBe(true);

    // The file logger uses pino.destination({ sync: true }), so by the
    // time `logger.info(...)` returns the bytes are on disk.
    logger.info({ scope: "test" }, "hello from cli-logger.test");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("hello from cli-logger.test");
    // pino default JSON shape carries the msg field.
    expect(contents).toMatch(/"msg":"hello from cli-logger.test"/);
  });

  test("ensures the log directory exists before opening the pino destination", async () => {
    // Directories are not pre-created; the helper must create them.
    expect(existsSync(paths.logDir)).toBe(false);
    const { logPath } = await createCliFileLogger(paths);
    expect(existsSync(paths.logDir)).toBe(true);
    expect(existsSync(dirname(logPath))).toBe(true);
  });

  test("respects NIMBUS_LOG_LEVEL=debug — debug entries are written", async () => {
    process.env["NIMBUS_LOG_LEVEL"] = "debug";
    const { logger, logPath } = await createCliFileLogger(paths);
    logger.debug({ scope: "lvl" }, "debug-line-included");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("debug-line-included");
  });

  test("defaults level to info — debug entries are filtered when level unset", async () => {
    const { logger, logPath } = await createCliFileLogger(paths);
    logger.debug({ scope: "lvl" }, "debug-line-filtered");
    logger.info({ scope: "lvl" }, "info-line-included");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).not.toContain("debug-line-filtered");
    expect(contents).toContain("info-line-included");
  });

  test("treats an empty NIMBUS_LOG_LEVEL the same as unset (info default)", async () => {
    process.env["NIMBUS_LOG_LEVEL"] = "   "; // whitespace trims to empty
    const { logger, logPath } = await createCliFileLogger(paths);
    logger.debug({ scope: "lvl" }, "still-filtered");
    logger.info({ scope: "lvl" }, "still-included");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).not.toContain("still-filtered");
    expect(contents).toContain("still-included");
  });

  test("lowercases NIMBUS_LOG_LEVEL (DEBUG -> debug)", async () => {
    process.env["NIMBUS_LOG_LEVEL"] = "DEBUG";
    const { logger, logPath } = await createCliFileLogger(paths);
    logger.debug({ scope: "lvl" }, "uppercase-debug-included");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("uppercase-debug-included");
  });
});
