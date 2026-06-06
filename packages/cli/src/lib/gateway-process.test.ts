import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import {
  ensureGatewayDirs,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "./gw-state-helpers.ts";

const liveProcs = new Set<Bun.Subprocess>();

afterEach(() => {
  for (const p of liveProcs) {
    try {
      p.kill();
    } catch {
      /* noop */
    }
  }
  liveProcs.clear();
});

afterAll(() => {
  for (const p of liveProcs) {
    try {
      p.kill();
    } catch {
      /* noop */
    }
  }
  liveProcs.clear();
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

function spawnNoop(): Bun.Subprocess {
  const proc = Bun.spawn(["bun", "-e", "process.stdin.on('data', () => {});"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  liveProcs.add(proc);
  return proc;
}

describe("gatewayStatePath", () => {
  it("returns <dataDir>/gateway.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gwp-path-"));
    try {
      const paths = makePaths(dir);
      expect(gatewayStatePath(paths)).toBe(join(paths.dataDir, "gateway.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns true for a spawned subprocess and false after it exits", async () => {
    const proc = spawnNoop();
    const pid = proc.pid;
    expect(typeof pid).toBe("number");
    if (typeof pid !== "number") return;
    expect(isProcessAlive(pid)).toBe(true);

    proc.kill();
    liveProcs.delete(proc);
    await proc.exited;
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("returns false for an implausibly-high PID that does not exist", () => {
    expect(isProcessAlive(2_147_483_640)).toBe(false);
  });
});

describe("ensureGatewayDirs", () => {
  it("creates dataDir and logDir if missing (recursive)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gwp-ensure-"));
    try {
      const paths = makePaths(dir);
      expect(existsSync(paths.dataDir)).toBe(false);
      expect(existsSync(paths.logDir)).toBe(false);

      await ensureGatewayDirs(paths);
      expect(existsSync(paths.dataDir)).toBe(true);
      expect(existsSync(paths.logDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — running twice does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-gwp-ensure-2-"));
    try {
      const paths = makePaths(dir);
      await ensureGatewayDirs(paths);
      await ensureGatewayDirs(paths);
      expect(existsSync(paths.dataDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readGatewayState", () => {
  let dir: string;
  let paths: CliPlatformPaths;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-gwp-read-"));
    paths = makePaths(dir);
    await mkdir(paths.dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the state file does not exist", async () => {
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns the parsed state for a valid file (with optional logPath)", async () => {
    const stateFile = gatewayStatePath(paths);
    const payload = {
      pid: process.pid,
      socketPath: join(dir, "nimbus.sock"),
      logPath: join(dir, "gateway.log"),
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");

    const state = await readGatewayState(paths);
    expect(state).toBeDefined();
    expect(state?.pid).toBe(payload.pid);
    expect(state?.socketPath).toBe(payload.socketPath);
    expect(state?.logPath).toBe(payload.logPath);
  });

  it("omits logPath when absent in the file", async () => {
    const stateFile = gatewayStatePath(paths);
    const noLogSock = join(dir, "no-log.sock");
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, socketPath: noLogSock }), "utf8");
    const state = await readGatewayState(paths);
    expect(state?.pid).toBe(process.pid);
    expect(state?.socketPath).toBe(noLogSock);
    expect(state?.logPath).toBeUndefined();
  });

  it("omits logPath when present but the empty string", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(
      stateFile,
      JSON.stringify({ pid: process.pid, socketPath: join(dir, "x.sock"), logPath: "" }),
      "utf8",
    );
    const state = await readGatewayState(paths);
    expect(state?.logPath).toBeUndefined();
  });

  it("returns undefined when the JSON shape is invalid (pid not a number)", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(
      stateFile,
      JSON.stringify({ pid: "not-a-number", socketPath: join(dir, "x.sock") }),
      "utf8",
    );
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when socketPath is missing", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(stateFile, JSON.stringify({ pid: 1234 }), "utf8");
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when pid is non-finite (NaN)", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(
      stateFile,
      JSON.stringify({ pid: "Infinity-bad", socketPath: join(dir, "x.sock") }),
      "utf8",
    );
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when logPath is the wrong type (number)", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(
      stateFile,
      JSON.stringify({ pid: process.pid, socketPath: join(dir, "x.sock"), logPath: 42 }),
      "utf8",
    );
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when the file is malformed JSON", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(stateFile, "{not json", "utf8");
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when the top-level JSON is an array", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(stateFile, JSON.stringify([1, 2, 3]), "utf8");
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("returns undefined when the top-level JSON is null", async () => {
    const stateFile = gatewayStatePath(paths);
    writeFileSync(stateFile, "null", "utf8");
    const state = await readGatewayState(paths);
    expect(state).toBeUndefined();
  });

  it("roundtrips a real subprocess pid (write -> read -> kill)", async () => {
    const proc = spawnNoop();
    const pid = proc.pid;
    if (typeof pid !== "number") {
      throw new Error("spawned subprocess has no pid");
    }
    const stateFile = gatewayStatePath(paths);
    writeFileSync(stateFile, JSON.stringify({ pid, socketPath: join(dir, "live.sock") }), "utf8");

    const state = await readGatewayState(paths);
    expect(state?.pid).toBe(pid);
    expect(isProcessAlive(pid)).toBe(true);

    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(pid);
  });
});
