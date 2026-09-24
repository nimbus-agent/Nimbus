import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliExit } from "../lib/cli-exit.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  applyInitPlan,
  asDemoSymbol,
  awaitGatewayState,
  defaultInitDeps,
  type GatewayLogTail,
  gatewayLogLines,
  INIT_EXIT,
  type InitDeps,
  initExitCode,
  initPlan,
  nextStepLines,
  readGatewayLogTail,
  runInit,
  TOUR_HINT,
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
  // mkdtempSync for the root: atomic creation, random suffix, owner-only perms.
  // The children below are created inside it, so they inherit that protection.
  dir = mkdtempSync(join(tmpdir(), "nimbus-init-"));
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
  const lines = nextStepLines({ file: "src/auth.ts", line: 42, name: "verifyToken" }, true);
  expect(lines.join("\n")).toContain("nimbus why src/auth.ts:42");
  expect(lines.join("\n")).toContain("verifyToken");
});

test("falls back to a generic next step when there is no symbol", () => {
  const text = nextStepLines(null, true).join("\n");
  expect(text).toContain("nimbus why <file>:<line>");
  // The plan's hard rule: never promise a concrete location we cannot produce.
  expect(text).not.toContain("nimbus why src/");
});

test("names `nimbus start` first when nothing has started the gateway", () => {
  // The defect this pins, reproduced on a clean Windows sandbox against v2.18.1:
  // `nimbus init --no-sync` exited 0 and printed exactly these two commands, and BOTH then
  // failed with "Gateway is not running". A first run that ends by naming commands which
  // cannot work is worse than one that ends silently.
  const lines = nextStepLines(null, false);
  expect(lines.join("\n")).toContain("nimbus start");
  // Order is the whole point: start has to come before the commands that need it.
  expect(lines.indexOf("  nimbus start")).toBeLessThan(
    lines.indexOf("  nimbus connector sync filesystem"),
  );
});

test("does NOT name `nimbus start` when the gateway is already up", () => {
  // Without this, the fix above could be satisfied by always printing `nimbus start`, which
  // would tell someone who just indexed through a live gateway to start one they already have.
  expect(nextStepLines(null, true).join("\n")).not.toContain("nimbus start");
});

test("next steps name connector detect after nimbus start", () => {
  const lines = nextStepLines(null, false);
  expect(lines.indexOf("  nimbus connector detect")).toBeGreaterThan(
    lines.indexOf("  nimbus start"),
  );
});

test("nextStepLines names `nimbus wow` last when the gateway is running (generic block)", () => {
  const lines = nextStepLines(null, true);
  expect(lines[lines.length - 1]).toBe("  nimbus wow");
});

test("nextStepLines names `nimbus wow` last when the gateway is running (concrete block)", () => {
  const lines = nextStepLines({ file: "src/auth.ts", line: 42, name: "verifyToken" }, true);
  expect(lines[lines.length - 1]).toBe("  nimbus wow");
});

test("nextStepLines omits `nimbus wow` when nothing is indexed (--no-sync)", () => {
  expect(nextStepLines(null, false).join("\n")).not.toContain("nimbus wow");
});

// ------------------------------------------------------------------ runInit

type Recorded = {
  out: string[];
  err: string[];
  started: number;
  synced: number;
  offered: boolean[];
  confirmedTour: number;
  ranTour: number;
  /** Call order across the offerLocalAuth/confirmTour/runTour trio, for ordering assertions. */
  order: string[];
};

function fakeDeps(
  over: Partial<InitDeps> & { confirmTourAnswer?: boolean; runTourThrows?: () => never } = {},
): { deps: InitDeps; rec: Recorded } {
  const { confirmTourAnswer, runTourThrows, ...depsOver } = over;
  const rec: Recorded = {
    out: [],
    err: [],
    started: 0,
    synced: 0,
    offered: [],
    confirmedTour: 0,
    ranTour: 0,
    order: [],
  };
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
    gatewayLogTail: () => ({
      path: join(dir, "data", "logs", "gateway-2026-07-29.log"),
      lines: ["initializing platform services", "starting embedding runtime"],
    }),
    log: (l) => rec.out.push(l),
    error: (l) => rec.err.push(l),
    inDemoRoot: false,
    interactive: false,
    offerLocalAuth: async (interactive) => {
      rec.offered.push(interactive);
      rec.order.push("offerLocalAuth");
    },
    confirmTour: async () => {
      rec.confirmedTour += 1;
      rec.order.push("confirmTour");
      return confirmTourAnswer ?? false;
    },
    runTour: async () => {
      rec.ranTour += 1;
      rec.order.push("runTour");
      if (runTourThrows) runTourThrows();
    },
    ...depsOver,
  };
  return { deps, rec };
}

/**
 * Runs `fn` with `CI` unset, restoring whatever value (or absence) it had before — even if `fn`
 * throws. Real CI runners (GitHub Actions included, and the Docker harness `verify:docker` runs
 * under) set `CI=true` ambiently, and every guard in `runInit` that reads it (`offerLocalAuth`,
 * the tour offer) would otherwise skip the exact code path a test means to exercise — so any test
 * that expects a TTY-only prompt to actually run needs this, not just the tests that assert the
 * guard itself. Without it, a test can pass on a developer shell that happens not to have `CI`
 * set and fail (or silently exercise the wrong branch) on every CI runner and the Docker harness.
 */
async function withCiUnset(fn: () => Promise<void>): Promise<void> {
  const prev = process.env["CI"];
  delete process.env["CI"];
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env["CI"];
    else process.env["CI"] = prev;
  }
}

/** The inverse of `withCiUnset`, for tests that assert the `CI=true` guard itself. */
async function withCiTrue(fn: () => Promise<void>): Promise<void> {
  const prev = process.env["CI"];
  process.env["CI"] = "true";
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env["CI"];
    else process.env["CI"] = prev;
  }
}

test("full happy path: adds the root, starts the gateway, syncs, prints a real location", async () => {
  const { deps, rec } = fakeDeps();
  await runInit([], deps);
  expect(process.exitCode ?? 0).toBe(0);
  expect(rec.started).toBe(1);
  expect(rec.synced).toBe(1);
  expect(rec.out.join("\n")).toContain("nimbus why src/auth.ts:42");
});

test("after a successful index, init offers local-auth reuse with the TTY flag", async () => {
  // The offer gate reads `CI` — without clearing it here this test only proves the offer fires
  // on a developer machine that happens not to have CI set, and silently passes vacuously (or
  // fails) depending on the runner. Isolate it exactly like the "CI=true skips" test below, just
  // inverted.
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({ interactive: true });
    await runInit([], deps);
    expect(rec.offered).toEqual([true]);
  });
});

test("--no-detect skips the offer", async () => {
  const { deps, rec } = fakeDeps();
  await runInit(["--no-detect"], deps);
  expect(rec.offered).toEqual([]);
});

test("CI=true skips the offer — init must not spawn three CLIs in a pipeline", async () => {
  await withCiTrue(async () => {
    const { deps, rec } = fakeDeps();
    await runInit([], deps);
    expect(rec.offered).toEqual([]);
  });
});

test("--no-sync starts no gateway, so it runs no detection", async () => {
  const { deps, rec } = fakeDeps();
  await runInit(["--no-sync"], deps);
  expect(rec.offered).toEqual([]);
});

test("a failing offer does not fail init", async () => {
  // Same ambient-CI isolation as above: the offer must actually run for this test to exercise
  // its failure path at all.
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({
      offerLocalAuth: async () => {
        throw new Error("gateway went away");
      },
    });
    await runInit([], deps);
    expect(process.exitCode).toBe(0);
    expect(rec.err.join("\n")).toContain("Could not check for existing logins: gateway went away");
  });
});

// ------------------------------------------------- runInit: the tour offer

test("non-interactive: the tour is never offered, but the next-step line names it", async () => {
  const { deps, rec } = fakeDeps({ interactive: false });
  await runInit([], deps);
  expect(rec.confirmedTour).toBe(0);
  expect(rec.ranTour).toBe(0);
  // The "nimbus wow" mention here comes from `nextStepLines`, never from `TOUR_HINT` — nothing
  // threw, so the hook's catch never ran. Assert both so this can't pass on the wrong line.
  expect(rec.out.join("\n")).toContain("nimbus wow");
  expect(rec.out).not.toContain(TOUR_HINT);
});

test("interactive + yes: the tour runs exactly once, after offerLocalAuth", async () => {
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({ interactive: true, confirmTourAnswer: true });
    await runInit([], deps);
    expect(rec.confirmedTour).toBe(1);
    expect(rec.ranTour).toBe(1);
    expect(rec.order).toEqual(["offerLocalAuth", "confirmTour", "runTour"]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test("interactive + no: the tour is not run, and the failure hint is not printed either", async () => {
  // The tour offer is itself CI-gated (finding 2 of the final review), so this must run with CI
  // unset for `confirmTour` to be reached at all — without it this test passed on a developer
  // shell only by accident, and would have silently asserted the wrong branch under `CI=true`.
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({ interactive: true, confirmTourAnswer: false });
    await runInit([], deps);
    expect(rec.confirmedTour).toBe(1);
    expect(rec.ranTour).toBe(0);
    // A plain "no" throws nothing, so the hook's catch never runs — TOUR_HINT is for a FAILED
    // attempt, not a declined one.
    expect(rec.out).not.toContain(TOUR_HINT);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test("interactive + yes + runTour throws CliExit: the hint prints, exit code stays 0", async () => {
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({
      interactive: true,
      confirmTourAnswer: true,
      runTourThrows: () => {
        throw new CliExit(1);
      },
    });
    await runInit([], deps);
    expect(rec.out).toContain(TOUR_HINT);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test("interactive + yes + runTour sets process.exitCode then throws a plain Error: hint prints, exit code stays 0", async () => {
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({
      interactive: true,
      confirmTourAnswer: true,
      runTourThrows: () => {
        process.exitCode = 1;
        throw new Error("boom");
      },
    });
    await runInit([], deps);
    expect(rec.out).toContain(TOUR_HINT);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test("indexed with no demo symbol: the tour is never offered, since its own plan would come back empty too", async () => {
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({
      interactive: true,
      confirmTourAnswer: true,
      demoSymbol: async () => null,
    });
    await runInit([], deps);
    expect(rec.confirmedTour).toBe(0);
    expect(rec.ranTour).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
    // The generic next-step block still names `nimbus wow` — only the offer itself is skipped.
    expect(rec.out.join("\n")).toContain("nimbus wow");
  });
});

test("CI=true skips the tour offer even with a demo symbol and interactive: true", async () => {
  await withCiTrue(async () => {
    const { deps, rec } = fakeDeps({ interactive: true, confirmTourAnswer: true });
    await runInit([], deps);
    expect(rec.confirmedTour).toBe(0);
    expect(rec.ranTour).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test("--no-sync (config-only) with interactive: true never offers the tour", async () => {
  const { deps, rec } = fakeDeps({ interactive: true, confirmTourAnswer: true });
  await runInit(["--no-sync"], deps);
  expect(rec.confirmedTour).toBe(0);
  expect(rec.ranTour).toBe(0);
});

test("confirmTour itself rejecting: the hint prints, exit code stays 0", async () => {
  await withCiUnset(async () => {
    const { deps, rec } = fakeDeps({
      interactive: true,
      confirmTour: async () => {
        throw new Error("prompt aborted");
      },
    });
    await runInit([], deps);
    expect(rec.out).toContain(TOUR_HINT);
    expect(rec.ranTour).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
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

test("--demo: refuses before doing anything — no gateway spawn, no config write, no wizard", async () => {
  const { deps, rec } = fakeDeps({ inDemoRoot: true });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.usage);
  expect(rec.err.join("\n")).toBe(
    "The demo root is set up by `nimbus demo`, not `init` — run `nimbus demo` to seed the synthetic org, or run `nimbus init` without --demo for your real install.",
  );
  // None of init's deps ran: no gateway spawn, no sync, and (since applyInitPlan/appendFilesystemRoot
  // is never reached) no nimbus.toml write either.
  expect(rec.started).toBe(0);
  expect(rec.synced).toBe(0);
  expect(existsSync(join(configDir, "nimbus.toml"))).toBe(false);
});

test("--demo: even --no-sync and --help-shaped args still refuse (the check is unconditional)", async () => {
  const { deps, rec } = fakeDeps({ inDemoRoot: true });
  await runInit(["--no-sync"], deps);
  expect(process.exitCode).toBe(INIT_EXIT.usage);
  expect(rec.started).toBe(0);
  expect(rec.synced).toBe(0);
  expect(existsSync(join(configDir, "nimbus.toml"))).toBe(false);
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

// ------------------------------------------- runInit: gateway never ready
//
// The whole point of this block. A gateway that never came up indexed nothing,
// so `init` must say so and exit non-zero — printing the generic `Next:` block
// and exiting 0 is what made #925 and #928 invisible for as long as they were.

test("a gateway that never became ready is a FAILURE, not a degraded success", async () => {
  const { deps, rec } = fakeDeps({ startGateway: async () => false });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.gatewayUnavailable);
  expect(process.exitCode).not.toBe(0);
  expect(rec.synced).toBe(0);
});

test("the gateway-never-ready failure names the failure and never prints a next step", async () => {
  const { deps, rec } = fakeDeps({ startGateway: async () => false });
  await runInit([], deps);
  const err = rec.err.join("\n");
  // What actually failed, in the failure stream.
  expect(err).toContain("Gateway never became ready");
  expect(err).toContain("nothing was indexed");
  // What to do next.
  expect(err).toContain("nimbus doctor");
  expect(err).toContain("nimbus start");
  // The lie this test exists to prevent: a "Next:"/"Try it:" block implying the
  // command did its job.
  const all = [...rec.out, ...rec.err].join("\n");
  expect(all).not.toContain("Try it:");
  expect(all).not.toContain("nimbus why <file>:<line>");
});

test("the gateway-never-ready failure inlines the tail of the gateway log", async () => {
  const logPath = join(dir, "data", "logs", "gateway-2026-07-29.log");
  const { deps, rec } = fakeDeps({
    startGateway: async () => false,
    gatewayLogTail: () => ({
      path: logPath,
      lines: ["initializing platform services", "fatal: PlatformInitError: Vault operation failed"],
    }),
  });
  await runInit([], deps);
  const err = rec.err.join("\n");
  // A path the user has to go read is exactly why this went unnoticed: inline it.
  expect(err).toContain(logPath);
  expect(err).toContain("fatal: PlatformInitError: Vault operation failed");
});

test("the gateway-never-ready failure never claims log lines it does not have", async () => {
  const { deps, rec } = fakeDeps({ startGateway: async () => false, gatewayLogTail: () => null });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.gatewayUnavailable);
  const err = rec.err.join("\n");
  expect(err).toContain("no Gateway log");
  expect(err).not.toContain("  | ");
});

// -------------------------------------- runInit: partial vs total failure

test("a sync failure is reported as a failure, distinct from a dead gateway", async () => {
  const { deps, rec } = fakeDeps({
    syncFilesystem: async () => {
      throw new Error("connector unavailable");
    },
  });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.notIndexed);
  expect(INIT_EXIT.notIndexed).not.toBe(INIT_EXIT.gatewayUnavailable);
  const err = rec.err.join("\n");
  expect(err).toContain("indexing did not complete");
  expect(err).toContain("connector unavailable");
  expect([...rec.out, ...rec.err].join("\n")).not.toContain("Try it:");
});

test("indexing that found no symbol is still a SUCCESS, with an honest note", async () => {
  // Gateway fine, sync fine, index simply has nothing worth suggesting yet.
  // That is a partial success and must stay distinguishable from a failure.
  const { deps, rec } = fakeDeps({ demoSymbol: async () => null });
  await runInit([], deps);
  expect(process.exitCode ?? 0).toBe(INIT_EXIT.ok);
  expect(rec.synced).toBe(1);
  const out = rec.out.join("\n");
  expect(out).toContain("no symbol to suggest yet");
  expect(out).toContain("nimbus why <file>:<line>");
  expect(out).not.toContain("nimbus why src/");
});

test("a demo-symbol lookup that throws does not fail a repository that DID index", async () => {
  const { deps, rec } = fakeDeps({
    demoSymbol: async () => {
      throw new Error("index.demoSymbol unavailable");
    },
  });
  await runInit([], deps);
  expect(process.exitCode ?? 0).toBe(INIT_EXIT.ok);
  expect(rec.synced).toBe(1);
  expect(rec.out.join("\n")).toContain("nimbus why <file>:<line>");
});

test("a running gateway that must be restarted did not index either — non-zero", async () => {
  const { deps, rec } = fakeDeps({ gatewayRunning: async () => true });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.notIndexed);
  expect(rec.err.join("\n")).toContain("not indexed");
  expect([...rec.out, ...rec.err].join("\n")).not.toContain("Try it:");
});

// ---------------------------------------------------------- initExitCode

test("initExitCode maps every outcome to its documented code", () => {
  expect(initExitCode({ kind: "indexed", demo: null })).toBe(0);
  expect(initExitCode({ kind: "config-only" })).toBe(0);
  expect(initExitCode({ kind: "not-a-repo" })).toBe(1);
  expect(initExitCode({ kind: "gateway-unavailable" })).toBe(2);
  expect(initExitCode({ kind: "restart-required" })).toBe(3);
  expect(initExitCode({ kind: "index-failed", message: "boom" })).toBe(3);
});

test("every failure outcome is non-zero and total failure is not collapsed into partial", () => {
  // The guard, stated once: a gateway that never came up can never share an
  // exit code with a run that actually indexed something.
  const failures = [
    initExitCode({ kind: "not-a-repo" }),
    initExitCode({ kind: "gateway-unavailable" }),
    initExitCode({ kind: "restart-required" }),
    initExitCode({ kind: "index-failed", message: "boom" }),
  ];
  for (const code of failures) {
    expect(code).not.toBe(0);
  }
  expect(initExitCode({ kind: "gateway-unavailable" })).not.toBe(
    initExitCode({ kind: "index-failed", message: "boom" }),
  );
  expect(new Set(failures).size).toBe(3);
});

// ------------------------------------------------------- gatewayLogLines

test("gatewayLogLines inlines the tail under its path", () => {
  const tail: GatewayLogTail = { path: "/logs/gateway.log", lines: ["a", "b"] };
  expect(gatewayLogLines(tail).join("\n")).toContain("/logs/gateway.log");
  expect(gatewayLogLines(tail).join("\n")).toContain("  | a");
  expect(gatewayLogLines(tail).join("\n")).toContain("  | b");
});

test("gatewayLogLines says so rather than implying an empty log is a clean one", () => {
  expect(gatewayLogLines({ path: "/logs/gateway.log", lines: [] }).join("\n")).toContain(
    "no readable lines",
  );
  expect(gatewayLogLines(null).join("\n")).toContain("no Gateway log");
});

// ---------------------------------------------------- readGatewayLogTail

test("readGatewayLogTail returns null when there is no log directory at all", () => {
  expect(readGatewayLogTail(join(dir, "definitely-absent"))).toBeNull();
});

test("readGatewayLogTail returns null when the directory holds no gateway log", () => {
  const logDir = join(dir, "logs-empty");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "cli-2026-07-29.log"), "not a gateway log\n", "utf8");
  expect(readGatewayLogTail(logDir)).toBeNull();
});

test("readGatewayLogTail picks the newest gateway log and returns its last lines", async () => {
  const logDir = join(dir, "logs");
  mkdirSync(logDir, { recursive: true });
  const older = join(logDir, "gateway-2026-07-28.log");
  const newer = join(logDir, "gateway-2026-07-29.log");
  writeFileSync(older, "[gateway] yesterday\n", "utf8");
  // Distinct mtimes without relying on filename ordering.
  await new Promise((r) => setTimeout(r, 10));
  writeFileSync(newer, "[gateway] one\n[gateway] two\n[gateway] three\n\n", "utf8");

  const tail = readGatewayLogTail(logDir, 2);
  expect(tail?.path).toBe(newer);
  // Last two non-empty lines, in order, with the `[gateway] ` prefix stripped.
  expect(tail?.lines).toEqual(["two", "three"]);
});

test("readGatewayLogTail ignores a directory that happens to be named like a log", () => {
  const logDir = join(dir, "logs-dir-entry");
  mkdirSync(join(logDir, "gateway-decoy.log"), { recursive: true });
  expect(readGatewayLogTail(logDir)).toBeNull();
});

test("readGatewayLogTail never emits a fragment when the log exceeds its read window", () => {
  // A long-lived gateway log is far bigger than the tail window, so the read
  // starts mid-line. That leading fragment is not a log line and must not be
  // shown as one.
  const logDir = join(dir, "logs-big");
  mkdirSync(logDir, { recursive: true });
  const p = join(logDir, "gateway-2026-07-29.log");
  const body = Array.from({ length: 4000 }, (_, i) => `[gateway] line ${String(i)}`).join("\n");
  writeFileSync(p, `${body}\n`, "utf8");
  expect(body.length).toBeGreaterThan(16_384);

  const tail = readGatewayLogTail(logDir, 3);
  expect(tail?.lines).toEqual(["line 3997", "line 3998", "line 3999"]);
  // Ask for far more than the window holds: every line returned is a whole one.
  for (const line of readGatewayLogTail(logDir, 5000)?.lines ?? []) {
    expect(line).toMatch(/^line \d+$/);
  }
});

test("readGatewayLogTail reports an empty log as empty rather than as missing", () => {
  const logDir = join(dir, "logs-blank");
  mkdirSync(logDir, { recursive: true });
  const p = join(logDir, "gateway-2026-07-29.log");
  writeFileSync(p, "", "utf8");
  expect(readGatewayLogTail(logDir)).toEqual({ path: p, lines: [] });
});

// ------------------------------------------------- awaitGatewayState (race)
//
// The gateway binds its IPC socket and only THEN writes gateway.json
// (packages/gateway/src/index.ts: `await platform.ipc.start()` precedes
// `writeGatewayStateFile`). `runStart` returns as soon as the socket answers,
// so a one-shot state read straight afterwards can miss a gateway that is
// perfectly healthy — and now that a dead gateway exits 2, that miss would be
// a FALSE failure on a working machine.

test("awaitGatewayState waits out the bind→state-file gap instead of failing", async () => {
  let reads = 0;
  const ok = await awaitGatewayState({
    readState: async () => {
      reads += 1;
      // Absent for the first two polls, exactly like the real race.
      return reads > 2 ? { pid: 1, socketPath: "s" } : undefined;
    },
    timeoutMs: 5_000,
    pollMs: 10,
    now: () => 0,
    sleep: async () => {},
  });
  expect(ok).toBe(true);
  expect(reads).toBe(3);
});

test("awaitGatewayState still gives up — a state file that never lands is a failure", async () => {
  let clock = 0;
  const ok = await awaitGatewayState({
    readState: async () => undefined,
    timeoutMs: 100,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(ok).toBe(false);
});

test("awaitGatewayState does not poll at all when the state file is already there", async () => {
  let reads = 0;
  const ok = await awaitGatewayState({
    readState: async () => {
      reads += 1;
      return { pid: 1, socketPath: "s" };
    },
    timeoutMs: 5_000,
    pollMs: 10,
    sleep: async () => {
      throw new Error("must not sleep when the gateway is already registered");
    },
  });
  expect(ok).toBe(true);
  expect(reads).toBe(1);
});

test("awaitGatewayState defaults terminate against a real clock", async () => {
  // No injected clock: proves the production defaults cannot spin forever.
  expect(
    await awaitGatewayState({ readState: async () => undefined, timeoutMs: 1, pollMs: 1 }),
  ).toBe(false);
});

// ------------------------------------------------------------------ --help

test("--help documents every exit code and does no work", async () => {
  const { deps, rec } = fakeDeps();
  await runInit(["--help"], deps);
  const out = rec.out.join("\n");
  for (const code of ["0", "1", "2", "3"]) {
    expect(out).toContain(`  ${code}  `);
  }
  expect(out).toContain("Exit codes:");
  expect(out).toContain("--no-sync");
  // Help must not start a gateway or write config.
  expect(rec.started).toBe(0);
  expect(rec.synced).toBe(0);
  expect(existsSync(join(configDir, "nimbus.toml"))).toBe(false);
  expect(process.exitCode ?? 0).toBe(0);
});

test("-h is the same help", async () => {
  const { deps, rec } = fakeDeps();
  await runInit(["-h"], deps);
  expect(rec.out.join("\n")).toContain("Exit codes:");
  expect(rec.started).toBe(0);
});

test("a thrown non-Error still reaches the failure report", async () => {
  // Rejections cross an IPC boundary, so they are not guaranteed to be Errors.
  const { deps, rec } = fakeDeps({
    syncFilesystem: async () => {
      throw "filesystem connector exploded";
    },
  });
  await runInit([], deps);
  expect(process.exitCode).toBe(INIT_EXIT.notIndexed);
  expect(rec.err.join("\n")).toContain("filesystem connector exploded");
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

test("defaultInitDeps reads the gateway log tail from the supplied logDir", () => {
  const paths = fakePaths();
  expect(defaultInitDeps(paths).gatewayLogTail()).toBeNull();
  mkdirSync(paths.logDir, { recursive: true });
  const p = join(paths.logDir, "gateway-2026-07-29.log");
  writeFileSync(p, "[gateway] starting embedding runtime\n", "utf8");
  expect(defaultInitDeps(paths).gatewayLogTail()).toEqual({
    path: p,
    lines: ["starting embedding runtime"],
  });
});

test("defaultInitDeps log/error write to the console without throwing", () => {
  const deps = defaultInitDeps(fakePaths());
  expect(() => {
    deps.log("");
    deps.error("");
  }).not.toThrow();
});
