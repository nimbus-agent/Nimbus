/**
 * Coverage for the gateway state-file helpers (`gateway.json`).
 *
 * Tier D — was at 0 % line coverage.
 *
 * Exercises:
 *  - `gatewayStateFilePath` — joins dataDir with "gateway.json".
 *  - `writeGatewayStateFile` — JSON shape, logPath param, NIMBUS_GATEWAY_LOG_PATH env fallback,
 *    and "logPath absent when neither source is set".
 *  - `removeGatewayStateFile` — silent no-op when the file is absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processEnvDelete, processEnvSet } from "./env-access.ts";
import {
  gatewayStateFilePath,
  removeGatewayStateFile,
  writeGatewayStateFile,
} from "./gateway-state-file.ts";
import type { PlatformPaths } from "./paths.ts";

function makePaths(dir: string): PlatformPaths {
  return {
    configDir: dir,
    dataDir: dir,
    logDir: join(dir, "logs"),
    socketPath: join(dir, "gw.sock"),
    extensionsDir: join(dir, "ext"),
    tempDir: dir,
  };
}

describe("gatewayStateFilePath", () => {
  test("returns dataDir/gateway.json", () => {
    const paths = makePaths("/tmp/some/dir");
    expect(gatewayStateFilePath(paths)).toBe(join("/tmp/some/dir", "gateway.json"));
  });
});

describe("writeGatewayStateFile", () => {
  let dir: string;
  let originalLogEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-gw-state-"));
    originalLogEnv = process.env["NIMBUS_GATEWAY_LOG_PATH"];
    processEnvDelete("NIMBUS_GATEWAY_LOG_PATH");
  });

  afterEach(() => {
    processEnvSet("NIMBUS_GATEWAY_LOG_PATH", originalLogEnv);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("writes a valid JSON file with pid + socketPath when no logPath", () => {
    const paths = makePaths(dir);
    writeGatewayStateFile(paths, { pid: 12345, socketPath: "/tmp/sock" });
    const raw = readFileSync(gatewayStateFilePath(paths), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    expect(obj["pid"]).toBe(12345);
    expect(obj["socketPath"]).toBe("/tmp/sock");
    // logPath omitted because no opts.logPath and no env var.
    expect("logPath" in obj).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("includes explicit opts.logPath in the JSON shape", () => {
    const paths = makePaths(dir);
    writeGatewayStateFile(paths, {
      pid: 7,
      socketPath: "/tmp/x",
      logPath: "/var/log/nimbus.log",
    });
    const obj = JSON.parse(readFileSync(gatewayStateFilePath(paths), "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj["logPath"]).toBe("/var/log/nimbus.log");
  });

  test("falls back to NIMBUS_GATEWAY_LOG_PATH env var when opts.logPath is absent", () => {
    processEnvSet("NIMBUS_GATEWAY_LOG_PATH", "/from/env.log");
    const paths = makePaths(dir);
    writeGatewayStateFile(paths, { pid: 99, socketPath: "/tmp/y" });
    const obj = JSON.parse(readFileSync(gatewayStateFilePath(paths), "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj["logPath"]).toBe("/from/env.log");
  });

  test("empty env var does not surface as logPath", () => {
    processEnvSet("NIMBUS_GATEWAY_LOG_PATH", "");
    const paths = makePaths(dir);
    writeGatewayStateFile(paths, { pid: 1, socketPath: "/tmp/z" });
    const obj = JSON.parse(readFileSync(gatewayStateFilePath(paths), "utf8")) as Record<
      string,
      unknown
    >;
    expect("logPath" in obj).toBe(false);
  });

  test("opts.logPath wins over env var when both are set", () => {
    processEnvSet("NIMBUS_GATEWAY_LOG_PATH", "/from/env.log");
    const paths = makePaths(dir);
    writeGatewayStateFile(paths, {
      pid: 2,
      socketPath: "/tmp/a",
      logPath: "/explicit/opts.log",
    });
    const obj = JSON.parse(readFileSync(gatewayStateFilePath(paths), "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj["logPath"]).toBe("/explicit/opts.log");
  });
});

describe("removeGatewayStateFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-gw-state-rm-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* harmless */
    }
  });

  test("deletes the gateway.json when present", () => {
    const paths = makePaths(dir);
    writeFileSync(gatewayStateFilePath(paths), "{}");
    expect(existsSync(gatewayStateFilePath(paths))).toBe(true);
    removeGatewayStateFile(paths);
    expect(existsSync(gatewayStateFilePath(paths))).toBe(false);
  });

  test("silently no-ops when the file is absent", () => {
    const paths = makePaths(dir);
    // File doesn't exist — call must not throw.
    expect(() => removeGatewayStateFile(paths)).not.toThrow();
  });
});
