import { existsSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { spinner } from "@clack/prompts";
import { IPCClient } from "../ipc-client/index.ts";
import { GatewayLogTailer, truncatePreview } from "../lib/gateway-log-tail.ts";
import {
  ensureGatewayDirs,
  gatewayStatePath,
  isProcessAlive,
  readGatewayState,
} from "../lib/gateway-process.ts";
import { spawnGateway } from "../lib/spawn-gateway.ts";
import { getCliPlatformPaths } from "../paths.ts";

const ONBOARDING_MARKER = ".nimbus-post-start-onboarding";
const SOCKET_PROBE_TIMEOUT_MS = 2000;
// Generous upper bound for everything `createPlatformServices()` does before
// IPC binds: DB migrations, MCP mesh spawn, sync scheduler init. The
// embedding worker no longer blocks here — it inits in the background and
// the bridge gracefully no-ops calls until ready (see worker-bridge.ts).
// First-run DB migrations on a populated index are the slowest realistic
// step at the moment; 60s is plenty.
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

async function probeSocketReachable(socketPath: string, timeoutMs: number): Promise<boolean> {
  const client = new IPCClient(socketPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("probe timeout"));
      }, timeoutMs);
    });
    await Promise.race([client.connect(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await client.disconnect().catch(() => {});
  }
}

async function waitForGatewayReady(
  socketPath: string,
  pid: number,
  deadlineMs: number,
  onTick?: (elapsedMs: number) => void,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!isProcessAlive(pid)) {
      return false;
    }
    if (await probeSocketReachable(socketPath, READY_POLL_INTERVAL_MS)) {
      return true;
    }
    onTick?.(Date.now() - start);
    await sleep(READY_POLL_INTERVAL_MS);
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

/**
 * Pure decision-layer for `runStart`. Given the existing state file (if any),
 * whether its pid is alive, and whether the recorded socket is reachable,
 * returns the action the dispatcher should take.
 *
 * Extracted from `runStart` so the parse + state-file decision is testable
 * without spawning a real gateway subprocess.
 */
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

async function printOnboardingHintIfNoConnectors(
  client: IPCClient,
  markerPath: string,
): Promise<void> {
  const rows = await client.call<Array<{ serviceId?: string }>>("connector.listStatus", {});
  if (Array.isArray(rows) && rows.length === 0) {
    console.log("");
    console.log("Next — connect a service so the index has data to search:");
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

async function maybePrintFirstRunHints(
  paths: ReturnType<typeof getCliPlatformPaths>,
): Promise<void> {
  if (!process.stdout.isTTY || process.env["CI"] === "true") {
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

export async function runStart(args: string[]): Promise<void> {
  const paths = getCliPlatformPaths();
  await ensureGatewayDirs(paths);

  const existing = await readGatewayState(paths);
  if (existing !== undefined) {
    const pidAlive = isProcessAlive(existing.pid);
    const reachable =
      pidAlive && (await probeSocketReachable(existing.socketPath, SOCKET_PROBE_TIMEOUT_MS));
    if (reachable) {
      console.log(`Gateway already running (pid ${String(existing.pid)}).`);
      return;
    }
    if (pidAlive) {
      console.warn(
        `Gateway state points to pid ${String(existing.pid)}, but its IPC socket is not reachable.`,
      );
      console.warn(
        `Treating state as stale and starting fresh — if pid ${String(existing.pid)} is still hung, stop it manually` +
          (process.platform === "win32"
            ? ` (e.g. taskkill /PID ${String(existing.pid)} /F).`
            : ` (e.g. kill ${String(existing.pid)}).`),
      );
    }
    await unlink(gatewayStatePath(paths)).catch(() => {});
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
  const ready = await waitForGatewayReady(paths.socketPath, pid, readyTimeoutMs, (elapsedMs) => {
    const next = tailer.pollLatest(tailedLogPath);
    if (next !== null && next.length > 0) {
      lastPreview = next;
    }
    const elapsedSec = Math.round(elapsedMs / 1000);
    const suffix = lastPreview === "" ? "" : ` — ${truncatePreview(lastPreview)}`;
    s.message(`Waiting for Gateway IPC (${String(elapsedSec)}s)${suffix}`);
  });
  if (!ready) {
    s.stop("Gateway did not become ready");
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
