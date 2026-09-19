import { unlink } from "node:fs/promises";

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
 * Signal the gateway recorded in `paths`' state file and WAIT until its process is gone, so a
 * caller can delete its directory. `nimbus stop` only signals: on Windows SIGTERM is
 * TerminateProcess and the process's handles on nimbus.db / -wal / the log are released a moment
 * later, so an immediate recursive delete fails with EBUSY/EPERM (spec § 4.4).
 *
 * A live pid is NOT proof that the process is our gateway. `gateway.json` survives a reboot (or
 * a crash), and the OS may since have handed that pid to an unrelated process — which SIGTERM
 * would then kill (on Windows, `TerminateProcess`, with no chance to refuse). So before
 * signalling, the recorded socket is probed exactly the way `nimbus start` does before it reuses
 * a state file (`socket-probe.ts`). A pid that is alive but whose socket does not answer is
 * treated as STALE: nothing is signalled, the state file is deleted, and the result is
 * `"not-running"` — every caller is about to recreate or remove the demo root anyway.
 *
 * The cost of that choice, accepted: a genuinely HUNG demo gateway (alive, socket dead) is left to
 * the OS rather than killed. On Windows the caller's subsequent root removal then fails loudly with
 * EBUSY instead of silently succeeding, which names the problem; killing a pid we cannot prove is
 * ours has no such visible failure mode.
 */
export async function stopAndWaitForExit(
  paths: CliPlatformPaths,
  opts: {
    readonly deadlineMs?: number;
    readonly pollMs?: number;
    readonly probeTimeoutMs?: number;
  } = {},
): Promise<"stopped" | "not-running"> {
  const state = await readGatewayState(paths);
  if (
    state === undefined ||
    !isProcessAlive(state.pid) ||
    !(await probeSocketReachable(
      rawSocketClient(state.socketPath),
      opts.probeTimeoutMs ?? SOCKET_PROBE_TIMEOUT_MS,
    ))
  ) {
    await unlink(gatewayStatePath(paths)).catch(() => undefined);
    return "not-running";
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
  await unlink(gatewayStatePath(paths)).catch(() => undefined);
  return "stopped";
}
