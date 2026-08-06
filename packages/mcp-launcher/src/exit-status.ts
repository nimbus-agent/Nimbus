import { constants } from "node:os";

/**
 * Maps a spawned child's `exit` event `(code, signal)` pair to the exit code THIS process should
 * report to its own parent (the MCP client).
 *
 * `child_process`'s `exit` event fires with `code: null` whenever the child died by signal
 * (SIGTERM/SIGKILL/a crash the OS turned into a signal) — `signal` carries the name in that case.
 * A naive `process.exit(code ?? 0)` treats that `null` as "clean exit" and reports 0, which tells
 * the MCP client the server shut down fine when it was actually killed or crashed.
 *
 * Signal deaths are reported using the conventional `128 + signal number` encoding (the same one a
 * POSIX shell uses for `$?` after a signal death), via `os.constants.signals`. A signal name Node
 * doesn't have a number for falls back to a plain non-zero exit code (`1`) — still non-zero, just
 * without a specific number to add.
 */
export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) {
    const signalNumber = constants.signals[signal];
    return typeof signalNumber === "number" ? 128 + signalNumber : 1;
  }
  return code ?? 0;
}
