import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { hasFlag } from "../lib/flag-parsing.ts";
import { extractLatestMessage, truncatePreview } from "../lib/gateway-log-tail.ts";
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

/** The tail of the gateway log, with the path it came from. */
export type GatewayLogTail = { path: string; lines: readonly string[] };

/**
 * What actually happened. `runInit` derives both the report and the exit code
 * from this, so the two can never disagree.
 */
export type InitOutcome =
  /** Gateway reachable and the sync ran. `demo` is a hint, not a success criterion. */
  | { kind: "indexed"; demo: DemoSymbolLike | null }
  /** `--no-sync`: the config edit was the whole job. */
  | { kind: "config-only" }
  | { kind: "not-a-repo" }
  /** The gateway never came up. Nothing was indexed. */
  | { kind: "gateway-unavailable" }
  /** A gateway is running but cannot see the new root until it restarts. */
  | { kind: "restart-required" }
  /** Gateway reachable, sync attempted and failed. */
  | { kind: "index-failed"; message: string };

/**
 * The documented exit codes. Distinct on purpose: `init` is the first command a
 * new user runs, and "the Gateway never came up" (2) must never be
 * indistinguishable from "indexed, nothing to suggest yet" (0).
 *
 * Kept in step with the `Exit codes:` block in HELP_LINES and the
 * `nimbus init` section of docs/cli-reference.md.
 */
export const INIT_EXIT = {
  /** Indexed. A `nimbus why` target may or may not have been found. */
  ok: 0,
  /** Usage: not a git repository. Nothing was written. */
  usage: 1,
  /** The Gateway never became ready. Nothing was indexed. */
  gatewayUnavailable: 2,
  /** The Gateway is reachable, but this repository was not indexed. */
  notIndexed: 3,
} as const;

export function initExitCode(outcome: InitOutcome): number {
  switch (outcome.kind) {
    case "indexed":
    case "config-only":
      return INIT_EXIT.ok;
    case "not-a-repo":
      return INIT_EXIT.usage;
    case "gateway-unavailable":
      return INIT_EXIT.gatewayUnavailable;
    case "restart-required":
    case "index-failed":
      return INIT_EXIT.notIndexed;
  }
}

export type InitDeps = {
  cwd: string;
  configDir: string;
  gatewayRunning: () => Promise<boolean>;
  /** Returns whether the gateway became reachable. */
  startGateway: () => Promise<boolean>;
  syncFilesystem: () => Promise<void>;
  demoSymbol: (repoRoot: string) => Promise<DemoSymbolLike | null>;
  /** Last few gateway log lines, or null when there is no log to show. */
  gatewayLogTail: () => GatewayLogTail | null;
  log: (line: string) => void;
  error: (line: string) => void;
};

const HELP_LINES: readonly string[] = [
  "nimbus init — index the git repository in the current directory",
  "",
  "Usage:",
  "  nimbus init [--no-sync]",
  "",
  "Flags:",
  "  --no-sync   write nimbus.toml only; do not start the Gateway and do not index",
  "  --help      this message",
  "",
  "Exit codes:",
  "  0  the repository was indexed (a `nimbus why` target may not exist yet)",
  "  1  the current directory is not a git repository — nothing was written",
  "  2  the Gateway never became ready — nothing was indexed",
  "  3  the Gateway is reachable, but this repository was not indexed",
  "     (the sync failed, or a running Gateway must restart to see the new root)",
];

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
 * Render the gateway log tail for a failure report.
 *
 * Printing a path the user then has to go and read is exactly why #925/#928
 * stayed invisible, so the lines are inlined. The empty and missing cases get
 * their own wording: an empty log must never be rendered as a clean one.
 */
export function gatewayLogLines(tail: GatewayLogTail | null): string[] {
  if (tail === null) {
    return ["Found no Gateway log to show — the Gateway may not have got far enough to write one."];
  }
  if (tail.lines.length === 0) {
    return [`Gateway log: ${tail.path} (no readable lines)`];
  }
  return [`Gateway log: ${tail.path}`, ...tail.lines.map((l) => `  | ${l}`)];
}

const GATEWAY_LOG_TAIL_LINES = 6;
/** Read window for the tail. Bounded so a multi-megabyte log stays cheap. */
const GATEWAY_LOG_TAIL_BYTES = 16_384;
const GATEWAY_LOG_LINE_MAX = 160;

/**
 * The newest `gateway-<date>.log` in `logDir`, or undefined when there is none.
 *
 * Newest by mtime rather than by filename: after a rotation the name that sorts
 * last is only coincidentally the one being written to.
 */
function newestGatewayLog(logDir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    if (!name.startsWith("gateway-") || !name.endsWith(".log")) {
      continue;
    }
    const path = join(logDir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && (best === undefined || st.mtimeMs > best.mtimeMs)) {
        best = { path, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* unreadable entry: skip it rather than fail the whole report */
    }
  }
  return best?.path;
}

function tailLines(path: string, maxLines: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - GATEWAY_LOG_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) {
      return [];
    }
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const raw = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) {
      // The read window began mid-line; that fragment is not a log line.
      raw.shift();
    }
    const out: string[] = [];
    for (let i = raw.length - 1; i >= 0 && out.length < maxLines; i--) {
      const line = raw[i]?.trim() ?? "";
      if (line.length === 0) {
        continue;
      }
      out.unshift(truncatePreview(extractLatestMessage(line), GATEWAY_LOG_LINE_MAX));
    }
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/**
 * Last few lines of the newest gateway log under `logDir`.
 *
 * Returns null only when no gateway log exists at all. A log that exists but
 * yields nothing comes back with `lines: []`, so the report can say "empty"
 * instead of "missing" — two different things to someone debugging a startup.
 */
export function readGatewayLogTail(
  logDir: string,
  maxLines: number = GATEWAY_LOG_TAIL_LINES,
): GatewayLogTail | null {
  const path = newestGatewayLog(logDir);
  if (path === undefined) {
    return null;
  }
  return { path, lines: tailLines(path, maxLines) };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How long a just-started gateway may take to register itself. */
const GATEWAY_STATE_SETTLE_MS = 5_000;
const GATEWAY_STATE_POLL_MS = 50;

export type GatewayStateWait = {
  /** Resolves to the gateway state, or undefined while it is not there yet. */
  readState: () => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
  /** Seams so the loop is testable without a real clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Wait for the gateway to register itself, bounded.
 *
 * The gateway binds its IPC socket and only THEN writes the state file
 * (`gateway/src/index.ts`: `await platform.ipc.start()` precedes
 * `writeGatewayStateFile`), so `runStart` — which returns as soon as the
 * socket answers — can hand back a healthy gateway whose state file is a few
 * milliseconds away. Everything `init` does next goes through
 * `withGatewayIpc`, which reads that file, so a one-shot check here would
 * report a working machine as "the Gateway never became ready". Now that that
 * verdict exits non-zero, guessing it is not an option.
 */
export async function awaitGatewayState(w: GatewayStateWait): Promise<boolean> {
  const timeoutMs = w.timeoutMs ?? GATEWAY_STATE_SETTLE_MS;
  const pollMs = w.pollMs ?? GATEWAY_STATE_POLL_MS;
  const now = w.now ?? Date.now;
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    if ((await w.readState()) !== undefined) {
      return true;
    }
    if (now() - start >= timeoutMs) {
      return false;
    }
    await sleep(pollMs);
  }
}

/**
 * Bring a gateway up if needed, or report why we will not.
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
): Promise<"ready" | "restart-required" | "unavailable"> {
  if (await deps.gatewayRunning()) {
    return addedRoot ? "restart-required" : "ready";
  }
  deps.log("");
  deps.log("Starting the gateway...");
  return (await deps.startGateway()) ? "ready" : "unavailable";
}

/**
 * The demo symbol is a hint, not the job.
 *
 * A lookup that throws leaves an indexed repository indexed, so it degrades to
 * `null` — the generic next step — rather than failing a run that did its work.
 */
async function pickDemo(deps: InitDeps, repoRoot: string): Promise<DemoSymbolLike | null> {
  try {
    return await deps.demoSymbol(repoRoot);
  } catch (e) {
    deps.log(`  (could not read a demo symbol: ${errorMessage(e)})`);
    return null;
  }
}

/**
 * Sync, then ask the index for a demo symbol.
 *
 * A sync that throws is a real failure and is returned as one. It used to be
 * swallowed into the generic next step, which is how a `nimbus init` that
 * indexed nothing still exited 0.
 */
async function indexRepository(deps: InitDeps, repoRoot: string): Promise<InitOutcome> {
  deps.log("Indexing this repository...");
  try {
    await deps.syncFilesystem();
  } catch (e) {
    return { kind: "index-failed", message: errorMessage(e) };
  }
  return { kind: "indexed", demo: await pickDemo(deps, repoRoot) };
}

function reportGatewayUnavailable(deps: InitDeps): void {
  deps.error("");
  deps.error("nimbus init: the Gateway never became ready, so nothing was indexed.");
  deps.error("  The nimbus.toml edit above is done — re-running init will not repeat it.");
  deps.error("");
  for (const line of gatewayLogLines(deps.gatewayLogTail())) {
    deps.error(line);
  }
  deps.error("");
  deps.error("What to try:");
  deps.error("  nimbus doctor      # check the OS prerequisites the Gateway needs");
  deps.error("  nimbus start       # start it again and read the error in full");
  deps.error("Then re-run: nimbus init");
}

function reportIndexFailed(deps: InitDeps, message: string): void {
  deps.error("");
  deps.error("nimbus init: indexing did not complete — the Gateway is up, but the sync failed.");
  deps.error(`  ${message}`);
  deps.error("");
  for (const line of gatewayLogLines(deps.gatewayLogTail())) {
    deps.error(line);
  }
  deps.error("");
  deps.error("What to try:");
  deps.error("  nimbus connector sync filesystem   # re-run just the sync");
  deps.error("  nimbus doctor");
}

function reportRestartRequired(deps: InitDeps): void {
  deps.log("");
  deps.log("A gateway is already running and loads filesystem roots at startup.");
  deps.log("Restart it to pick up the new root:");
  deps.log("  nimbus stop");
  deps.log("  nimbus start");
  deps.error(
    "nimbus init: this repository was not indexed — restart the running Gateway, then re-run nimbus init.",
  );
}

function reportIndexed(deps: InitDeps, demo: DemoSymbolLike | null): void {
  if (demo === null) {
    deps.log("");
    deps.log("Indexed this repository — no symbol to suggest yet.");
  }
  for (const line of nextStepLines(demo)) {
    deps.log(line);
  }
}

/** The single place an outcome becomes output. */
function reportOutcome(outcome: InitOutcome, deps: InitDeps): void {
  switch (outcome.kind) {
    case "not-a-repo":
      deps.error("nimbus init: run this inside a git repository.");
      return;
    case "config-only":
      for (const line of nextStepLines(null)) {
        deps.log(line);
      }
      return;
    case "indexed":
      reportIndexed(deps, outcome.demo);
      return;
    case "gateway-unavailable":
      reportGatewayUnavailable(deps);
      return;
    case "restart-required":
      reportRestartRequired(deps);
      return;
    case "index-failed":
      reportIndexFailed(deps, outcome.message);
      return;
  }
}

/** Everything up to the report: config edit, gateway, sync. */
async function initOutcome(args: string[], deps: InitDeps): Promise<InitOutcome> {
  const opts: InitOptions = { cwd: deps.cwd, configDir: deps.configDir };
  const plan = initPlan(opts);

  if (plan.kind === "not-a-repo") {
    return { kind: "not-a-repo" };
  }

  if (plan.kind === "already-configured") {
    deps.log(`Already configured: ${plan.repoRoot}`);
  } else {
    applyInitPlan(plan, opts);
    deps.log(`Added ${plan.repoRoot} to nimbus.toml (code indexing on).`);
  }

  if (hasFlag(args, "--no-sync")) {
    return { kind: "config-only" };
  }

  const gateway = await ensureSyncableGateway(deps, plan.kind === "add-root");
  if (gateway === "restart-required") {
    return { kind: "restart-required" };
  }
  if (gateway === "unavailable") {
    return { kind: "gateway-unavailable" };
  }
  return await indexRepository(deps, plan.repoRoot);
}

export async function runInit(args: string[], deps: InitDeps = defaultInitDeps()): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    for (const line of HELP_LINES) {
      deps.log(line);
    }
    process.exitCode = INIT_EXIT.ok;
    return;
  }

  const outcome = await initOutcome(args, deps);
  reportOutcome(outcome, deps);
  // Assigned unconditionally: the exit code is derived from the outcome that
  // was just reported, so no earlier writer (runStart's failure signal, say)
  // can leave the two disagreeing.
  process.exitCode = initExitCode(outcome);
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
      // readiness wait, and the log-tail diagnostics on failure. It reports
      // failure through process.exitCode, so clear it first — what is read
      // back afterwards has to be runStart's own verdict and nothing else.
      process.exitCode = 0;
      await runStart(["--no-wizard"]);
      const startFailed = (process.exitCode ?? 0) !== 0;
      // Clear it again either way: runInit derives init's own code from the
      // outcome, and a stale 1 here would shadow the more specific one.
      process.exitCode = 0;
      if (startFailed) {
        return false;
      }
      // The socket answered. Give the gateway its (millisecond) window to write
      // the state file everything downstream reads. See awaitGatewayState.
      return await awaitGatewayState({ readState: () => readGatewayState(paths) });
    },
    syncFilesystem: async () => {
      await withGatewayIpc((c) => c.call("connector.sync", { serviceId: "filesystem" }), paths);
    },
    demoSymbol: async (repoRoot) =>
      asDemoSymbol(await withGatewayIpc((c) => c.call("index.demoSymbol", { repoRoot }), paths)),
    gatewayLogTail: () => readGatewayLogTail(paths.logDir),
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  };
}
