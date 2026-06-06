import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import { spawnGateway, stripInspectorEnv } from "./spawn-gateway.ts";

describe("stripInspectorEnv", () => {
  test("removes Bun inspector env vars set by VS Code auto-attach", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      BUN_INSPECT: "ws+unix:///tmp/bun.sock",
      BUN_INSPECT_BRK: "1",
      BUN_INSPECT_NOTIFY: "ws+unix:///tmp/notify.sock",
      BUN_INSPECT_PRELOAD: "/some/preload.js",
      BUN_INSPECT_CONNECT_TO: "ws://127.0.0.1:63855",
      BUN_INSPECT_DISABLE: "0",
      NODE_INSPECT_RESUME_ON_START: "1",
      NODE_OPTIONS: "--inspect=63855",
    };
    const out = stripInspectorEnv(env);
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["BUN_INSPECT"]).toBeUndefined();
    expect(out["BUN_INSPECT_BRK"]).toBeUndefined();
    expect(out["BUN_INSPECT_NOTIFY"]).toBeUndefined();
    expect(out["BUN_INSPECT_PRELOAD"]).toBeUndefined();
    expect(out["BUN_INSPECT_CONNECT_TO"]).toBeUndefined();
    expect(out["BUN_INSPECT_DISABLE"]).toBeUndefined();
    expect(out["NODE_INSPECT_RESUME_ON_START"]).toBeUndefined();
    expect(out["NODE_OPTIONS"]).toBeUndefined();
  });

  test("leaves the input env untouched", () => {
    const env: NodeJS.ProcessEnv = { BUN_INSPECT: "1", PATH: "/usr/bin" };
    stripInspectorEnv(env);
    expect(env["BUN_INSPECT"]).toBe("1");
  });

  test("returns a copy with non-inspector keys preserved", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      NIMBUS_PROFILE: "work",
    };
    const out = stripInspectorEnv(env);
    expect(out).toEqual(env);
    expect(out).not.toBe(env);
  });
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

function previousExecutableEnv(): string | undefined {
  return process.env["NIMBUS_GATEWAY_EXECUTABLE"];
}

function restoreExecutableEnv(prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env["NIMBUS_GATEWAY_EXECUTABLE"];
  } else {
    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = prev;
  }
}

describe("spawnGateway — launch failure", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = previousExecutableEnv();
    dir = mkdtempSync(join(tmpdir(), "nimbus-spawn-fail-"));
    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = join(dir, "no-such-binary");
  });

  afterEach(() => {
    restoreExecutableEnv(prevEnv);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when the resolver cannot locate a gateway", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    await expect(spawnGateway(paths)).rejects.toThrow(/NIMBUS_GATEWAY_EXECUTABLE/);
  });
});

describe("spawnGateway — happy path via NIMBUS_GATEWAY_EXECUTABLE", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = previousExecutableEnv();
    dir = mkdtempSync(join(tmpdir(), "nimbus-spawn-ok-"));
  });

  afterEach(() => {
    restoreExecutableEnv(prevEnv);
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns the configured executable, returns pid + logPath + offset, and appends a marker", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });

    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;

    const result = await spawnGateway(paths);
    expect(typeof result.pid).toBe("number");
    expect(result.pid).toBeGreaterThan(0);
    expect(result.logPath.startsWith(paths.logDir)).toBe(true);
    expect(result.logStartOffset).toBe(0);
    expect(existsSync(result.logPath)).toBe(true);

    const logContents = readFileSync(result.logPath, "utf8");
    expect(logContents).toContain("nimbus: spawning gateway");

    try {
      process.kill(result.pid);
    } catch {
      /* the child may have already exited */
    }
  });

  it("preserves the existing log file's offset across a second spawn (append mode)", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;

    const first = await spawnGateway(paths);
    expect(first.logStartOffset).toBe(0);

    const second = await spawnGateway(paths);
    expect(second.logPath).toBe(first.logPath);
    expect(second.logStartOffset).toBeGreaterThan(0);

    for (const pid of [first.pid, second.pid]) {
      try {
        process.kill(pid);
      } catch {
        /* may have exited */
      }
    }
  });

  it("propagates `extraEnv` to the child process (no throw)", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;

    const result = await spawnGateway(paths, {
      extraEnv: { NIMBUS_TEST_KEY: "hello", NIMBUS_TEST_KEY_2: "world" },
    });
    expect(typeof result.pid).toBe("number");
    try {
      process.kill(result.pid);
    } catch {
      /* may have exited */
    }
  });

  it("forwards an explicit profile from <configDir>/.nimbus-profile", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, ".nimbus-profile"), "work\n", "utf8");

    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;
    const result = await spawnGateway(paths);
    expect(typeof result.pid).toBe("number");
    try {
      process.kill(result.pid);
    } catch {
      /* may have exited */
    }
  });

  it("ignores a 'default' or empty profile name", async () => {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, ".nimbus-profile"), "default", "utf8");

    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;
    const result = await spawnGateway(paths);
    expect(typeof result.pid).toBe("number");
    try {
      process.kill(result.pid);
    } catch {
      /* may have exited */
    }
  });
});
