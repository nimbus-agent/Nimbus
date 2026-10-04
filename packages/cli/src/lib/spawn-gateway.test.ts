import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import type { SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import type { GatewayLaunchPlan } from "./resolve-gateway-launch.ts";
import { type SpawnGatewayDeps, spawnGateway, stripInspectorEnv } from "./spawn-gateway.ts";

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

  it("a .nimbus-profile that exists but cannot be read (a directory) does not fail the launch", async () => {
    // The profile is an optional hint: an unreadable one falls back to the default profile rather
    // than leaving the user with no gateway at all.
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    mkdirSync(join(paths.configDir, ".nimbus-profile"), { recursive: true });

    process.env["NIMBUS_GATEWAY_EXECUTABLE"] = process.execPath;
    const result = await spawnGateway(paths);
    expect(result.pid).toBeGreaterThan(0);
    expect(readFileSync(result.logPath, "utf8")).toContain("nimbus: spawning gateway");
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

// The real-spawn cases above prove a child starts; they cannot see WHAT it was started with, and
// the host decides which side of the `win32` branch they take. These inject the launch plan, the
// spawn and the platform (`SpawnGatewayDeps`), so every leg checks both platforms' flags and the
// exact env the daemon receives — nothing here starts a process.
describe("spawnGateway — the launch it hands the child (injected spawn)", () => {
  type SpawnCall = { command: string; args: string[]; options: SpawnOptions };
  const ENV_KEYS = ["NIMBUS_PROFILE", "NIMBUS_HTTP_PORT", "NODE_INSPECT_RESUME_ON_START"] as const;
  let dir: string;
  let savedEnv: Map<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-spawn-di-"));
    savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** `child.pid` is what the fake spawn reports; `{ pid: undefined }` is a spawn that failed. */
  function fakeLaunch(
    plan: GatewayLaunchPlan,
    platform: NodeJS.Platform,
    child: { readonly pid: number | undefined } = { pid: 4242 },
  ): { deps: SpawnGatewayDeps; spawns: SpawnCall[]; unrefs: () => number } {
    const spawns: SpawnCall[] = [];
    let unrefs = 0;
    const deps: SpawnGatewayDeps = {
      resolveLaunch: () => plan,
      spawn: (command, args, options) => {
        spawns.push({ command, args: [...args], options });
        return {
          pid: child.pid,
          unref: (): void => {
            unrefs += 1;
          },
        };
      },
      platform,
    };
    return { deps, spawns, unrefs: () => unrefs };
  }

  function readyPaths(): CliPlatformPaths {
    const paths = makePaths(dir);
    mkdirSync(paths.logDir, { recursive: true });
    return paths;
  }

  const SOURCE_PLAN: GatewayLaunchPlan = {
    ok: true,
    cmd: ["bun-bin", "run", "packages/gateway/src/index.ts"],
    cwd: "repo-root",
  };

  it("spawns the planned command in its cwd, output to today's log, hidden, then unrefs it", async () => {
    const paths = readyPaths();
    const fake = fakeLaunch(SOURCE_PLAN, "linux");
    const result = await spawnGateway(paths, {}, fake.deps);

    expect(result.pid).toBe(4242);
    expect(result.logStartOffset).toBe(0);
    expect(result.logPath.startsWith(paths.logDir)).toBe(true);
    expect(result.logPath).toMatch(/gateway-\d{4}-\d{2}-\d{2}\.log$/);
    expect(readFileSync(result.logPath, "utf8")).toContain(
      "nimbus: spawning gateway (bun-bin run packages/gateway/src/index.ts) ---",
    );

    expect(fake.spawns).toHaveLength(1);
    const call = fake.spawns[0] as SpawnCall;
    expect(call.command).toBe("bun-bin");
    expect(call.args).toEqual(["run", "packages/gateway/src/index.ts"]);
    expect(call.options.cwd).toBe("repo-root");
    // By VALUE: a present-but-false flag is exactly the bug the daemon launch must not have.
    expect(call.options.windowsHide).toBe(true);
    const stdio = call.options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(call.options.env?.["NIMBUS_GATEWAY_LOG_PATH"]).toBe(result.logPath);
    expect(fake.unrefs()).toBe(1);
  });

  it("detaches the daemon on win32 only, whatever OS runs the test", async () => {
    const onWindows = fakeLaunch(SOURCE_PLAN, "win32");
    await spawnGateway(readyPaths(), {}, onWindows.deps);
    expect(onWindows.spawns[0]?.options.detached).toBe(true);

    for (const platform of ["linux", "darwin"] as const) {
      const elsewhere = fakeLaunch(SOURCE_PLAN, platform);
      await spawnGateway(readyPaths(), {}, elsewhere.deps);
      expect(elsewhere.spawns).toHaveLength(1);
      expect("detached" in (elsewhere.spawns[0]?.options ?? {})).toBe(false);
    }
  });

  it("hands the child the active profile and extraEnv, with the inspector variables stripped", async () => {
    const paths = readyPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, ".nimbus-profile"), "work\n", "utf8");
    process.env["NODE_INSPECT_RESUME_ON_START"] = "1";
    const fake = fakeLaunch(SOURCE_PLAN, "linux");
    await spawnGateway(paths, { extraEnv: { NIMBUS_HTTP_PORT: "7475" } }, fake.deps);

    const env = fake.spawns[0]?.options.env ?? {};
    expect(env["NIMBUS_PROFILE"]).toBe("work");
    expect(env["NIMBUS_HTTP_PORT"]).toBe("7475");
    expect("NODE_INSPECT_RESUME_ON_START" in env).toBe(false);
    // The parent's own environment is copied, not handed over and mutated.
    expect(process.env["NIMBUS_HTTP_PORT"]).toBeUndefined();
    expect(process.env["NODE_INSPECT_RESUME_ON_START"]).toBe("1");
  });

  it("forwards no profile for 'default', for an empty file, or for one that cannot be read", async () => {
    const paths = readyPaths();
    mkdirSync(paths.configDir, { recursive: true });
    const profileFile = join(paths.configDir, ".nimbus-profile");
    for (const body of ["default\n", "   \n"]) {
      writeFileSync(profileFile, body, "utf8");
      const fake = fakeLaunch(SOURCE_PLAN, "linux");
      await spawnGateway(paths, {}, fake.deps);
      expect("NIMBUS_PROFILE" in (fake.spawns[0]?.options.env ?? {})).toBe(false);
    }
    rmSync(profileFile);
    mkdirSync(profileFile);
    const unreadable = fakeLaunch(SOURCE_PLAN, "linux");
    await spawnGateway(paths, {}, unreadable.deps);
    expect(unreadable.spawns).toHaveLength(1);
    expect("NIMBUS_PROFILE" in (unreadable.spawns[0]?.options.env ?? {})).toBe(false);
  });

  it("a spawn that returns no pid rejects, and the child is never unref'd or reported", async () => {
    const paths = readyPaths();
    const fake = fakeLaunch(SOURCE_PLAN, "linux", { pid: undefined });
    await expect(spawnGateway(paths, {}, fake.deps)).rejects.toThrow(
      "Gateway spawn did not return a process id",
    );
    expect(fake.spawns).toHaveLength(1);
    expect(fake.unrefs()).toBe(0);
  });

  it("an empty launch command is refused before the log is opened or anything spawned", async () => {
    for (const cmd of [[], [""]]) {
      const paths = readyPaths();
      const fake = fakeLaunch({ ok: true, cmd }, "linux");
      await expect(spawnGateway(paths, {}, fake.deps)).rejects.toThrow(
        "Gateway launch command is empty",
      );
      expect(fake.spawns).toHaveLength(0);
      expect(readdirSync(paths.logDir)).toEqual([]);
    }
  });

  it("a launch plan that is not ok rejects with its own message, before any log or spawn", async () => {
    const paths = readyPaths();
    const fake = fakeLaunch({ ok: false, message: "no gateway binary anywhere" }, "linux");
    await expect(spawnGateway(paths, {}, fake.deps)).rejects.toThrow("no gateway binary anywhere");
    expect(fake.spawns).toHaveLength(0);
    expect(readdirSync(paths.logDir)).toEqual([]);
  });
});
