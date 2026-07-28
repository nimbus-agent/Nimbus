import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasFlag } from "../lib/flag-parsing.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { appendFilesystemRoot, hasFilesystemRoot } from "../lib/toml-append.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";
import { runStart } from "./start.ts";

export type InitOptions = { cwd: string; configDir: string };

export type InitPlan =
  | { kind: "add-root"; repoRoot: string }
  | { kind: "already-configured"; repoRoot: string }
  | { kind: "not-a-repo" };

/**
 * Structural mirror of the gateway's `DemoSymbol`. Declared here rather than
 * imported because the CLI may not import gateway source — it reaches the
 * gateway over IPC only.
 */
export type DemoSymbolLike = { file: string; line: number; name: string };

export type InitDeps = {
  cwd: string;
  configDir: string;
  gatewayRunning: () => Promise<boolean>;
  /** Returns whether the gateway became reachable. */
  startGateway: () => Promise<boolean>;
  syncFilesystem: () => Promise<void>;
  demoSymbol: (repoRoot: string) => Promise<DemoSymbolLike | null>;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Pure decision step, so the behaviour is testable without touching disk. */
export function initPlan(opts: InitOptions): InitPlan {
  const repoRoot = resolve(opts.cwd);
  if (!existsSync(join(repoRoot, ".git"))) {
    return { kind: "not-a-repo" };
  }

  const tomlPath = join(opts.configDir, "nimbus.toml");
  if (existsSync(tomlPath) && hasFilesystemRoot(readFileSync(tomlPath, "utf8"), repoRoot)) {
    return { kind: "already-configured", repoRoot };
  }
  return { kind: "add-root", repoRoot };
}

/** Effects only. The append-only + backup contract lives in toml-append.ts. */
export function applyInitPlan(plan: InitPlan, opts: InitOptions): void {
  if (plan.kind !== "add-root") {
    return;
  }
  appendFilesystemRoot(opts.configDir, plan.repoRoot);
}

/**
 * The closing suggestion.
 *
 * A concrete `file:line` is printed ONLY when the index actually produced one.
 * Anything else falls back to the placeholder form — promising a location the
 * command cannot produce is the specific failure this shape exists to prevent.
 */
export function nextStepLines(demo: DemoSymbolLike | null): string[] {
  if (demo === null) {
    return ["", "Next:", "  nimbus connector sync filesystem", "  nimbus why <file>:<line>"];
  }
  return ["", "Try it:", `  nimbus why ${demo.file}:${String(demo.line)}   # ${demo.name}`];
}

/**
 * Bring a gateway up if needed, or explain why we will not.
 *
 * A gateway that was ALREADY running cannot see a root we just appended:
 * `platform/assemble.ts` reads `[[filesystem.roots]]` once at startup. Syncing
 * anyway would index nothing and the closing suggestion would be a fiction.
 * Restarting someone's running daemon is also not `init`'s call, so this
 * reports and declines instead.
 */
async function ensureSyncableGateway(
  deps: InitDeps,
  addedRoot: boolean,
): Promise<"ready" | "declined"> {
  const running = await deps.gatewayRunning();
  if (running) {
    if (!addedRoot) {
      return "ready";
    }
    deps.log("");
    deps.log("A gateway is already running and loads filesystem roots at startup.");
    deps.log("Restart it to pick up the new root:");
    deps.log("  nimbus stop");
    deps.log("  nimbus start");
    return "declined";
  }
  deps.log("");
  deps.log("Starting the gateway...");
  return (await deps.startGateway()) ? "ready" : "declined";
}

/**
 * Sync, then ask the index for a demo symbol.
 *
 * Every failure here degrades to `null` rather than propagating: the config
 * edit already succeeded and is the durable half of the work, so a connector
 * hiccup must not turn `init` into a failed command.
 */
async function syncAndPickDemo(deps: InitDeps, repoRoot: string): Promise<DemoSymbolLike | null> {
  try {
    deps.log("Indexing this repository...");
    await deps.syncFilesystem();
    return await deps.demoSymbol(repoRoot);
  } catch (e) {
    deps.log(`  (indexing did not complete: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

export async function runInit(args: string[], deps: InitDeps = defaultInitDeps()): Promise<void> {
  const opts: InitOptions = { cwd: deps.cwd, configDir: deps.configDir };
  const plan = initPlan(opts);

  if (plan.kind === "not-a-repo") {
    deps.error("nimbus init: run this inside a git repository.");
    process.exitCode = 1;
    return;
  }

  if (plan.kind === "already-configured") {
    deps.log(`Already configured: ${plan.repoRoot}`);
  } else {
    applyInitPlan(plan, opts);
    deps.log(`Added ${plan.repoRoot} to nimbus.toml (code indexing on).`);
  }

  if (hasFlag(args, "--no-sync")) {
    for (const line of nextStepLines(null)) {
      deps.log(line);
    }
    return;
  }

  const gateway = await ensureSyncableGateway(deps, plan.kind === "add-root");
  const demo = gateway === "ready" ? await syncAndPickDemo(deps, plan.repoRoot) : null;

  for (const line of nextStepLines(demo)) {
    deps.log(line);
  }
}

/**
 * Validate an `index.demoSymbol` reply.
 *
 * The reply crosses a JSON-RPC boundary, so it is `unknown` here however
 * well-behaved the gateway is. Anything malformed becomes `null` and `init`
 * prints the generic next step — a bad demo hint must never be worse than no
 * demo hint.
 */
export function asDemoSymbol(value: unknown): DemoSymbolLike | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const r = value as Record<string, unknown>;
  const file = r["file"];
  const line = r["line"];
  const name = r["name"];
  if (typeof file !== "string" || typeof line !== "number" || !Number.isFinite(line)) {
    return null;
  }
  return { file, line, name: typeof name === "string" ? name : "symbol" };
}

/**
 * The real effects.
 *
 * `paths` is a parameter rather than a closed-over call so tests can point the
 * gateway-state lookup at a temp directory. It has to be injectable: the state
 * file lives under `dataDir`, which `NIMBUS_CONFIG_DIR` deliberately does NOT
 * relocate, so without this seam these functions would read whatever gateway
 * happens to be running on the developer's machine.
 */
export function defaultInitDeps(paths: CliPlatformPaths = getCliPlatformPaths()): InitDeps {
  return {
    cwd: process.cwd(),
    configDir: paths.configDir,
    gatewayRunning: async () => (await readGatewayState(paths)) !== undefined,
    startGateway: async () => {
      // Delegate rather than re-implement: runStart already owns spawning, the
      // readiness wait, and the log-tail diagnostics on failure.
      await runStart(["--no-wizard"]);
      // runStart signals failure through process.exitCode; clear it so a
      // gateway that would not start degrades `init` to the generic next step
      // instead of failing the command outright.
      const ok = (await readGatewayState(paths)) !== undefined;
      if (ok) {
        process.exitCode = 0;
      }
      return ok;
    },
    syncFilesystem: async () => {
      await withGatewayIpc((c) => c.call("connector.sync", { serviceId: "filesystem" }), paths);
    },
    demoSymbol: async (repoRoot) =>
      asDemoSymbol(await withGatewayIpc((c) => c.call("index.demoSymbol", { repoRoot }), paths)),
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  };
}
