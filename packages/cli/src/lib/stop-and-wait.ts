import { stat, unlink } from "node:fs/promises";
import { uptime } from "node:os";

import type { CliPlatformPaths } from "../paths.ts";
// Deliberately `gw-state-helpers.ts`, NOT `gateway-process.ts`: `test/helpers/cli-mocks.ts`
// replaces `gateway-process.ts` process-wide via `mock.module`, which — in the combined
// `bun test packages/cli/src` run — leaks into every later-loaded test file, exactly the
// problem `gateway-process.test.ts` solved the same way (see that file's own duplicate-module
// comment). `stopAndWaitForExit` exists SPECIFICALLY to synchronize with the REAL OS process the
// real gateway state file names; a caller that wants to skip that goes through `DemoDeps.stop`
// (dependency injection) instead of relying on this module being mockable.
import { gatewayStatePath, isProcessAlive, readGatewayState } from "./gw-state-helpers.ts";
// `rawSocketClient`, not an `IPCClient`: the CLI command tests mock `IPCClient` process-wide, and
// the mock reaches even a direct `@nimbus-dev/client` import — see `socket-probe.ts`.
import { probeSocketReachable, rawSocketClient, SOCKET_PROBE_TIMEOUT_MS } from "./socket-probe.ts";

export class StopTimeoutError extends Error {
  constructor(pid: number, ms: number) {
    super(`Gateway pid ${String(pid)} did not exit within ${String(ms)}ms; nothing was deleted.`);
    this.name = "StopTimeoutError";
  }
}

/**
 * How far a state file's mtime may sit BEFORE the computed boot instant and still count as written
 * in this boot. `Date.now() - os.uptime()` is an estimate (clock adjustments, uptime rounding), so
 * the margin errs toward "this boot" — the direction that never deletes a live gateway's root.
 */
export const BOOT_TIME_SKEW_MS = 60_000;

/**
 * - `"stopped"` — the recorded gateway answered, was signalled, and has exited.
 * - `"not-running"` — nothing to stop: no state file, a dead pid, or a state file older than this
 *   boot (its pid cannot be ours). A stale state file is removed.
 * - `{ status: "unresponsive", pid }` — the state file was written in THIS boot and its pid is
 *   alive, but its socket does not answer: most likely a hung demo gateway. Nothing is signalled
 *   and the state file is kept; the caller must not delete or restart anything under it.
 */
export type StopResult =
  | "stopped"
  | "not-running"
  | { readonly status: "unresponsive"; readonly pid: number };

async function defaultStateFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function defaultBootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Signal the gateway recorded in `paths`' state file and WAIT until its process is gone, so a
 * caller can delete its directory. `nimbus stop` only signals: on Windows SIGTERM is
 * TerminateProcess and the process's handles on nimbus.db / -wal / the log are released a moment
 * later, so an immediate recursive delete fails with EBUSY/EPERM (spec § 4.4).
 *
 * A live pid is NOT proof that the process is our gateway. `gateway.json` survives a reboot (or
 * a crash), and the OS may since have handed that pid to an unrelated process — which SIGTERM
 * would then kill (on Windows, `TerminateProcess`, with no chance to refuse). So before
 * signalling, the recorded socket is probed exactly the way `nimbus start` does before it reuses
 * a state file (`socket-probe.ts`); only a gateway whose socket answers is ever signalled.
 *
 * A pid that is alive but whose socket does NOT answer is one of two things, told apart by boot
 * time (`Date.now() - os.uptime()`, cross-platform):
 * - the state file predates this boot (by more than {@link BOOT_TIME_SKEW_MS}) — the recorded
 *   process cannot be ours, since every process from that boot is gone. The state file is deleted
 *   and the result is `"not-running"`; nothing is signalled.
 * - the state file was written in this boot — most likely OUR gateway, hung. It is neither
 *   signalled (we still cannot prove the pid is ours) nor reported as not running (the caller
 *   would delete its root under it and start a second gateway): the result is
 *   `{ status: "unresponsive", pid }`, the state file is kept, and the caller stops and tells the
 *   user which pid to end.
 */
export async function stopAndWaitForExit(
  paths: CliPlatformPaths,
  opts: {
    readonly deadlineMs?: number;
    readonly pollMs?: number;
    readonly probeTimeoutMs?: number;
    /** The state file's mtime, or `undefined` when it cannot be stat'ed. Injectable for tests. */
    readonly stateFileMtimeMs?: (path: string) => Promise<number | undefined>;
    /** The wall-clock instant this machine booted. Injectable for tests. */
    readonly bootTimeMs?: () => number;
  } = {},
): Promise<StopResult> {
  const statePath = gatewayStatePath(paths);
  const state = await readGatewayState(paths);
  if (state === undefined || !isProcessAlive(state.pid)) {
    await unlink(statePath).catch(() => undefined);
    return "not-running";
  }
  const answers = await probeSocketReachable(
    rawSocketClient(state.socketPath),
    opts.probeTimeoutMs ?? SOCKET_PROBE_TIMEOUT_MS,
  );
  if (!answers) {
    const mtimeMs = await (opts.stateFileMtimeMs ?? defaultStateFileMtimeMs)(statePath);
    const bootMs = (opts.bootTimeMs ?? defaultBootTimeMs)();
    if (mtimeMs === undefined || mtimeMs < bootMs - BOOT_TIME_SKEW_MS) {
      await unlink(statePath).catch(() => undefined);
      return "not-running";
    }
    return { status: "unresponsive", pid: state.pid };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  while (isProcessAlive(state.pid)) {
    if (Date.now() - start > deadlineMs) throw new StopTimeoutError(state.pid, deadlineMs);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await unlink(statePath).catch(() => undefined);
  return "stopped";
}
