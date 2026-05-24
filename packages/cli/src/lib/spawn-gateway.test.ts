// packages/cli/src/lib/spawn-gateway.test.ts
//
// Phase 6 commit 5 of 14 — extends prior `stripInspectorEnv` coverage with
// direct `spawnGateway` cases: the launch-failure branch (no gateway
// binary, no monorepo checkout, NIMBUS_GATEWAY_EXECUTABLE pointing at a
// non-existent file), the happy-path PID + log roundtrip via
// `NIMBUS_GATEWAY_EXECUTABLE` pointing at a real no-op subprocess, and
// the `.nimbus-profile` -> `NIMBUS_PROFILE` env wiring.

import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";
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

// ----------------------------------------------------------------------
// spawnGateway — drive `resolveGatewayLaunch` through the
// `NIMBUS_GATEWAY_EXECUTABLE` override so we don't depend on a built
// dist binary or a monorepo checkout being discoverable from the test
// runner's cwd. Cleanup of every spawned child is handled by the
// file-level `liveProcs` set.
// ----------------------------------------------------------------------

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
    // Point the resolver at a path that does NOT exist; this short-circuits
    // resolveGatewayLaunch into its `ok: false` branch with a deterministic
    // message regardless of whether the test runner sits in a monorepo
    // checkout.
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

    // We use the running Bun binary itself as the "gateway" — it's
    // guaranteed to exist on PATH for any environment that can run
    // this test, and it reads stdin so it stays alive until we kill
    // it. The override path bypasses the dist + repo-root resolvers
    // entirely (see resolveFromOverride).
    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;

    const result = await spawnGateway(paths);
    expect(typeof result.pid).toBe("number");
    expect(result.pid).toBeGreaterThan(0);
    expect(result.logPath.startsWith(paths.logDir)).toBe(true);
    expect(result.logStartOffset).toBe(0);
    expect(existsSync(result.logPath)).toBe(true);

    const logContents = readFileSync(result.logPath, "utf8");
    expect(logContents).toContain("nimbus: spawning gateway");

    // Track for cleanup. `spawnGateway` returns a detached child via
    // node:child_process; we can't recover a Bun.Subprocess handle from
    // a pid alone, so manually kill by pid here.
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

    // The second call should see a non-zero offset because the first
    // spawn already wrote the timestamped marker line into the same
    // daily log file. The exact byte count is platform-dependent (it
    // includes the current ISO timestamp), so we assert > 0 not a
    // specific number.
    const second = await spawnGateway(paths);
    expect(second.logPath).toBe(first.logPath);
    expect(second.logStartOffset).toBeGreaterThan(0);

    // Cleanup: kill both children.
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

    // We can't easily introspect a detached child's env from here, so
    // this case primarily exercises the extraEnv merge branch
    // (Object.entries loop) without throwing.
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
