import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import {
  applyInitPlan,
  asDemoSymbol,
  defaultInitDeps,
  type InitDeps,
  initPlan,
  nextStepLines,
  runInit,
} from "./init.ts";

let dir: string;
let repo: string;
let configDir: string;

/**
 * Paths pinned entirely inside the test's temp dir.
 *
 * `dataDir` matters most: the gateway state file lives there and
 * NIMBUS_CONFIG_DIR does not relocate it, so without this the
 * `defaultInitDeps` tests would see whatever gateway is running on the
 * developer's machine and pass or fail by accident.
 */
function fakePaths(): CliPlatformPaths {
  return {
    configDir,
    dataDir: join(dir, "data"),
    logDir: join(dir, "data", "logs"),
    socketPath: join(dir, "nimbus.sock"),
    extensionsDir: join(dir, "data", "extensions"),
    tempDir: join(dir, "tmp"),
  };
}

beforeEach(() => {
  dir = join(tmpdir(), `nimbus-init-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  repo = join(dir, "repo");
  configDir = join(dir, "config");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- initPlan

test("plans an add when the cwd is a git repo not yet configured", () => {
  expect(initPlan({ cwd: repo, configDir }).kind).toBe("add-root");
});

test("refuses when the cwd is not a git repository", () => {
  expect(initPlan({ cwd: dir, configDir }).kind).toBe("not-a-repo");
});

test("reports already-configured on a second run", () => {
  const opts = { cwd: repo, configDir };
  applyInitPlan(initPlan(opts), opts);
  expect(initPlan(opts).kind).toBe("already-configured");
});

test("applyInitPlan writes the root with code indexing enabled", () => {
  const opts = { cwd: repo, configDir };
  applyInitPlan(initPlan(opts), opts);
  const written = readFileSync(join(configDir, "nimbus.toml"), "utf8");
  expect(written).toContain("[[filesystem.roots]]");
  expect(written).toContain("code_index = true");
});

// ----------------------------------------------------------- nextStepLines

test("prints a real file:line when the index yielded a symbol", () => {
  const lines = nextStepLines({ file: "src/auth.ts", line: 42, name: "verifyToken" });
  expect(lines.join("\n")).toContain("nimbus why src/auth.ts:42");
  expect(lines.join("\n")).toContain("verifyToken");
});

test("falls back to a generic next step when there is no symbol", () => {
  const text = nextStepLines(null).join("\n");
  expect(text).toContain("nimbus why <file>:<line>");
  // The plan's hard rule: never promise a concrete location we cannot produce.
  expect(text).not.toContain("nimbus why src/");
});

// ------------------------------------------------------------------ runInit

type Recorded = { out: string[]; err: string[]; started: number; synced: number };

function fakeDeps(over: Partial<InitDeps> = {}): { deps: InitDeps; rec: Recorded } {
  const rec: Recorded = { out: [], err: [], started: 0, synced: 0 };
  const deps: InitDeps = {
    cwd: repo,
    configDir,
    gatewayRunning: async () => false,
    startGateway: async () => {
      rec.started += 1;
      return true;
    },
    syncFilesystem: async () => {
      rec.synced += 1;
    },
    demoSymbol: async () => ({ file: "src/auth.ts", line: 42, name: "verifyToken" }),
    log: (l) => rec.out.push(l),
    error: (l) => rec.err.push(l),
    ...over,
  };
  return { deps, rec };
}

test("full happy path: adds the root, starts the gateway, syncs, prints a real location", async () => {
  const { deps, rec } = fakeDeps();
  await runInit([], deps);
  expect(process.exitCode ?? 0).toBe(0);
  expect(rec.started).toBe(1);
  expect(rec.synced).toBe(1);
  expect(rec.out.join("\n")).toContain("nimbus why src/auth.ts:42");
});

test("--no-sync writes config and stops without touching the gateway", async () => {
  const { deps, rec } = fakeDeps();
  await runInit(["--no-sync"], deps);
  expect(rec.started).toBe(0);
  expect(rec.synced).toBe(0);
  expect(rec.out.join("\n")).toContain("nimbus connector sync filesystem");
});

test("exits non-zero outside a git repository", async () => {
  const { deps, rec } = fakeDeps({ cwd: dir });
  await runInit([], deps);
  expect(process.exitCode).toBe(1);
  expect(rec.err.join("\n")).toContain("git repository");
});

test("a gateway already running when a NEW root is added is told to restart, not killed", async () => {
  // The daemon loads [[filesystem.roots]] at startup (platform/assemble.ts), so
  // syncing now would index nothing and the demo line would be a lie. Killing
  // the user's running daemon from `init` is not ours to do either.
  const { deps, rec } = fakeDeps({ gatewayRunning: async () => true });
  await runInit([], deps);
  expect(rec.synced).toBe(0);
  expect(rec.started).toBe(0);
  const text = rec.out.join("\n");
  expect(text).toContain("nimbus stop");
  expect(text).toContain("nimbus start");
});

test("an already-configured root syncs against the running gateway", async () => {
  const opts = { cwd: repo, configDir };
  applyInitPlan(initPlan(opts), opts);
  const { deps, rec } = fakeDeps({ gatewayRunning: async () => true });
  await runInit([], deps);
  expect(rec.started).toBe(0);
  expect(rec.synced).toBe(1);
  expect(rec.out.join("\n")).toContain("nimbus why src/auth.ts:42");
});

test("degrades to the generic next step when the gateway will not start", async () => {
  const { deps, rec } = fakeDeps({ startGateway: async () => false });
  await runInit([], deps);
  expect(rec.synced).toBe(0);
  expect(rec.out.join("\n")).toContain("nimbus why <file>:<line>");
});

test("degrades to the generic next step when the sync fails", async () => {
  // A failed sync must not turn `init` into a failed command — the config edit
  // already succeeded and is the durable half of the work.
  const { deps, rec } = fakeDeps({
    syncFilesystem: async () => {
      throw new Error("connector unavailable");
    },
  });
  await runInit([], deps);
  expect(process.exitCode ?? 0).toBe(0);
  expect(rec.out.join("\n")).toContain("nimbus why <file>:<line>");
});

test("degrades to the generic next step when the index has no symbol yet", async () => {
  const { deps, rec } = fakeDeps({ demoSymbol: async () => null });
  await runInit([], deps);
  expect(rec.synced).toBe(1);
  expect(rec.out.join("\n")).toContain("nimbus why <file>:<line>");
});

afterEach(() => {
  // Bun leaks process.exitCode across test files unless it is reset explicitly.
  process.exitCode = 0;
});

// ------------------------------------------------- asDemoSymbol (wire input)

test("asDemoSymbol accepts a well-formed reply", () => {
  expect(asDemoSymbol({ file: "a.ts", line: 3, name: "f" })).toEqual({
    file: "a.ts",
    line: 3,
    name: "f",
  });
});

test("asDemoSymbol defaults a missing name rather than rejecting the reply", () => {
  expect(asDemoSymbol({ file: "a.ts", line: 3 })?.name).toBe("symbol");
  expect(asDemoSymbol({ file: "a.ts", line: 3, name: 7 })?.name).toBe("symbol");
});

for (const bad of [
  null,
  undefined,
  "nope",
  7,
  {},
  { file: "a.ts" },
  { line: 3 },
  { file: 1, line: 3 },
  { file: "a.ts", line: "3" },
  { file: "a.ts", line: Number.NaN },
  { file: "a.ts", line: Number.POSITIVE_INFINITY },
]) {
  test(`asDemoSymbol rejects ${JSON.stringify(bad) ?? "undefined"}`, () => {
    // A malformed hint must degrade to the generic next step, never crash init
    // or print a location that does not exist.
    expect(asDemoSymbol(bad)).toBeNull();
  });
}

// ----------------------------------------------------------- defaultInitDeps

test("defaultInitDeps reads configDir from the supplied paths", () => {
  const deps = defaultInitDeps(fakePaths());
  expect(deps.configDir).toBe(join(dir, "config"));
  expect(deps.cwd).toBe(process.cwd());
});

test("defaultInitDeps reports no gateway when no state file exists", async () => {
  // The state file lives under dataDir, which NIMBUS_CONFIG_DIR does not move —
  // hence the injected paths, so this cannot read a real running gateway.
  await expect(defaultInitDeps(fakePaths()).gatewayRunning()).resolves.toBe(false);
});

test("defaultInitDeps effects fail loudly when the gateway is absent", async () => {
  const deps = defaultInitDeps(fakePaths());
  await expect(deps.syncFilesystem()).rejects.toThrow(/Gateway is not running/);
  await expect(deps.demoSymbol("/repo")).rejects.toThrow(/Gateway is not running/);
});

test("defaultInitDeps log/error write to the console without throwing", () => {
  const deps = defaultInitDeps(fakePaths());
  expect(() => {
    deps.log("");
    deps.error("");
  }).not.toThrow();
});
