import { existsSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { spinner } from "@clack/prompts";
import { IPCClient } from "../ipc-client/index.ts";
import { readDemoSeedMarker } from "../lib/demo-banner.ts";
import { GatewayLogTailer, truncatePreview } from "../lib/gateway-log-tail.ts";
import {
  ensureGatewayDirs,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "../lib/gateway-process.ts";
import {
  probeSocketReachable as probeClientReachable,
  SOCKET_PROBE_TIMEOUT_MS,
} from "../lib/socket-probe.ts";
import { spawnGateway } from "../lib/spawn-gateway.ts";
import { getCliPlatformPaths } from "../paths.ts";

const ONBOARDING_MARKER = ".nimbus-post-start-onboarding";
const DEFAULT_READY_WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 250;

function resolveReadyWaitTimeoutMs(): number {
  const raw = process.env["NIMBUS_START_READY_TIMEOUT_MS"];
  if (raw === undefined || raw === "") {
    return DEFAULT_READY_WAIT_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_READY_WAIT_TIMEOUT_MS;
  }
  return n;
}

function probeSocketReachable(socketPath: string, timeoutMs: number): Promise<boolean> {
  return probeClientReachable(new IPCClient(socketPath), timeoutMs);
}

export type ReadyWaitDeps = {
  readonly isAlive: (pid: number) => boolean;
  readonly probe: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  /** The pid recorded in gateway.json, or undefined while the file is absent or unreadable. */
  readonly statePid: () => Promise<number | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

/**
 * Ready means BOTH: the socket answers AND gateway.json names the process we spawned. The gateway
 * binds its socket before it writes that file, and every other command reads the file first and
 * reports "Gateway is not running" when it is absent — so returning on the socket alone let
 * `nimbus start && nimbus <cmd>` (and `nimbus demo`'s own tour) fail in the gap between the two.
 * The pid must match: a file left by an earlier gateway is not evidence about this one.
 */
export async function waitForGatewayReady(
  socketPath: string,
  pid: number,
  deadlineMs: number,
  onTick: ((elapsedMs: number) => void) | undefined,
  deps: ReadyWaitDeps,
): Promise<boolean> {
  const start = deps.now();
  while (deps.now() - start < deadlineMs) {
    if (!deps.isAlive(pid)) {
      return false;
    }
    if ((await deps.probe(socketPath, READY_POLL_INTERVAL_MS)) && (await deps.statePid()) === pid) {
      return true;
    }
    onTick?.(deps.now() - start);
    await deps.sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}

export function wantsNoWizard(args: readonly string[]): boolean {
  return args.includes("--no-wizard");
}

export type StartDecision =
  | { action: "reuse"; pid: number; reason: "gateway already running" }
  | { action: "abort-stale-clear"; pid: number; reason: "stale state, will clear and restart" }
  | { action: "start-fresh"; reason: "no existing state" };

export function decideStartAction(
  existing: { pid: number; socketPath: string } | undefined,
  pidAlive: boolean,
  reachable: boolean,
): StartDecision {
  if (existing === undefined) {
    return { action: "start-fresh", reason: "no existing state" };
  }
  if (pidAlive && reachable) {
    return { action: "reuse", pid: existing.pid, reason: "gateway already running" };
  }
  return {
    action: "abort-stale-clear",
    pid: existing.pid,
    reason: "stale state, will clear and restart",
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** The real-install first-run hint: shown once, when no connector is registered yet. */
export async function printOnboardingHintIfNoConnectors(
  client: IPCClient,
  markerPath: string,
): Promise<void> {
  const rows = await client.call<Array<{ serviceId?: string }>>("connector.listStatus", {});
  if (Array.isArray(rows) && rows.length === 0) {
    console.log("");
    console.log("Next — connect a service so the index has data to search:");
    console.log(
      "  nimbus connector detect        # reuse gh / aws / kubectl logins you already have",
    );
    console.log("  nimbus connector auth github");
    console.log("  nimbus connector sync github");
    console.log("  nimbus doctor");
  }
  try {
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    /* non-fatal */
  }
}

/**
 * The demo root's first-run hint, keyed on the demo SEED marker (`demo-seed.json`, read through
 * `lib/demo-banner.ts` — the same reader the banner uses), never on connectors or the onboarding
 * marker. A demo index has no connector rows even when seeded (the seeder writes items directly),
 * and `nimbus demo` starts its gateway with `--no-wizard`, so it never writes the onboarding
 * marker either: keyed on either, the hint told a user with a fully seeded demo to seed it.
 */
export function printDemoSeedHintIfUnseeded(dataDir: string): void {
  if (readDemoSeedMarker(dataDir) !== undefined) return;
  console.log("");
  console.log("Seed the synthetic org with: nimbus demo");
}

async function maybePrintFirstRunHints(
  paths: ReturnType<typeof getCliPlatformPaths>,
): Promise<void> {
  if (!process.stdout.isTTY || process.env["CI"] === "true") {
    return;
  }
  // Derived from `CliPlatformPaths.demo`, never the env var. In the demo root, connector
  // auth/sync are refused by the gateway, so the real-install hint below would be wrong twice
  // over: wrong install AND a refused command.
  if (paths.demo === true) {
    printDemoSeedHintIfUnseeded(paths.dataDir);
    return;
  }
  const markerPath = join(paths.dataDir, ONBOARDING_MARKER);
  if (existsSync(markerPath)) {
    return;
  }
  for (let i = 0; i < 30; i++) {
    const state = await readGatewayState(paths);
    if (state === undefined || !isProcessAlive(state.pid)) {
      await sleep(200);
      continue;
    }
    const client = new IPCClient(state.socketPath);
    try {
      await client.connect();
      await printOnboardingHintIfNoConnectors(client, markerPath);
    } catch {
      /* IPC not ready yet */
    } finally {
      await client.disconnect().catch(() => {});
    }
    return;
  }
}

async function handleExistingGatewayState(
  paths: ReturnType<typeof getCliPlatformPaths>,
  existing: { pid: number; socketPath: string },
): Promise<"reuse" | "start-fresh"> {
  const pidAlive = isProcessAlive(existing.pid);
  const reachable =
    pidAlive && (await probeSocketReachable(existing.socketPath, SOCKET_PROBE_TIMEOUT_MS));
  if (reachable) {
    console.log(`Gateway already running (pid ${String(existing.pid)}).`);
    return "reuse";
  }
  if (pidAlive) {
    const killHint =
      process.platform === "win32"
        ? ` (e.g. taskkill /PID ${String(existing.pid)} /F).`
        : ` (e.g. kill ${String(existing.pid)}).`;
    console.warn(
      `Gateway state points to pid ${String(existing.pid)}, but its IPC socket is not reachable.`,
    );
    console.warn(
      `Treating state as stale and starting fresh — if pid ${String(existing.pid)} is still hung, stop it manually${killHint}`,
    );
  }
  await unlink(gatewayStatePath(paths)).catch(() => {});
  return "start-fresh";
}

async function reportGatewayNotReady(
  paths: ReturnType<typeof getCliPlatformPaths>,
  pid: number,
  logPath: string | undefined,
  readyTimeoutMs: number,
): Promise<void> {
  const stillAlive = isProcessAlive(pid);
  console.error(
    stillAlive
      ? `Gateway pid ${String(pid)} is still running but never bound ${paths.socketPath} within ${String(readyTimeoutMs / 1000)}s.`
      : `Gateway pid ${String(pid)} exited before binding ${paths.socketPath}.`,
  );
  console.error(`Log: ${logPath}`);
  if (stillAlive) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* best-effort */
    }
  }
  await unlink(gatewayStatePath(paths)).catch(() => {});
}

export async function runStart(args: string[]): Promise<void> {
  const paths = getCliPlatformPaths();
  await ensureGatewayDirs(paths);

  const existing = await readGatewayState(paths);
  if (existing !== undefined && (await handleExistingGatewayState(paths, existing)) === "reuse") {
    return;
  }

  const s = spinner();
  s.start("Starting Gateway");

  let pid: number | undefined;
  let logPath: string | undefined;
  let logStartOffset = 0;
  try {
    const spawned = await spawnGateway(paths);
    pid = spawned.pid;
    logPath = spawned.logPath;
    logStartOffset = spawned.logStartOffset;
  } catch (e) {
    s.stop("Could not start Gateway");
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  s.message("Waiting for Gateway IPC");
  const readyTimeoutMs = resolveReadyWaitTimeoutMs();
  const tailer = new GatewayLogTailer(logStartOffset);
  let lastPreview = "";
  const tailedLogPath = logPath;
  const ready = await waitForGatewayReady(
    paths.socketPath,
    pid,
    readyTimeoutMs,
    (elapsedMs) => {
      const next = tailer.pollLatest(tailedLogPath);
      if (next !== null && next.length > 0) {
        lastPreview = next;
      }
      const elapsedSec = Math.round(elapsedMs / 1000);
      const suffix = lastPreview === "" ? "" : ` — ${truncatePreview(lastPreview)}`;
      s.message(`Waiting for Gateway IPC (${String(elapsedSec)}s)${suffix}`);
    },
    {
      isAlive: isProcessAlive,
      probe: probeSocketReachable,
      statePid: async () => (await readGatewayState(paths))?.pid,
      sleep,
      now: Date.now,
    },
  );
  if (!ready) {
    s.stop("Gateway did not become ready");
    await reportGatewayNotReady(paths, pid, logPath, readyTimeoutMs);
    process.exitCode = 1;
    return;
  }

  s.stop(`Gateway started (pid ${String(pid)})`);
  console.log(`Socket: ${paths.socketPath}`);
  console.log(`Log:    ${logPath}`);
  if (!wantsNoWizard(args)) {
    await maybePrintFirstRunHints(paths);
  }
}
