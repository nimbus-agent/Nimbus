import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { ExecResult, TerminationReason } from "./exec-result.ts";

export interface RunConfinedOptions {
  readonly policy: SandboxPolicy;
  readonly cwd: string;
  readonly maxOutputBytes: number;
  readonly maxWallClockMs: number;
  readonly now?: () => number;
}

/** Escalation delay before SIGKILL when SIGTERM is ignored (POSIX; on Windows SIGTERM is forceful). */
const KILL_ESCALATION_MS = 2_000;

/**
 * Drop a trailing INCOMPLETE UTF-8 sequence.
 *
 * Needed only where WE made the cut. Mid-stream splits are healed by concatenating every chunk
 * before decoding; but the output cap can slice mid-character, and decoding that fragment yields a
 * U+FFFD we manufactured ourselves. That is worse than it looks: U+FFFD re-encodes to 3 bytes, so
 * cutting four emoji at a 10-byte cap produced 11 bytes of output -- back OVER the very cap the
 * trim was enforcing.
 */
function trimPartialUtf8(buf: Uint8Array): Uint8Array {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte -- keep walking back to the lead byte
    const need = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
    return need === back ? buf : buf.subarray(0, buf.length - back);
  }
  return buf;
}

/**
 * Spawn `cmd` through the platform sandbox runner and capture bounded output.
 *
 * Two hard stops, both of which KILL rather than merely stop reading: the wall clock, and the
 * output cap. Truncating the buffer while letting the child run would leave a
 * `while(true) console.log()` burning CPU and IO until the wall clock with every byte discarded --
 * pointless work with no upside. Note this is resource hygiene on code the owner explicitly read
 * and approved, NOT a security boundary; the sandbox confinement is the boundary.
 */
export function runConfined(
  runner: SandboxRunner,
  cmd: string,
  args: string[],
  opts: RunConfinedOptions,
): Promise<ExecResult> {
  const now = opts.now ?? Date.now;
  const started = now();

  return new Promise<ExecResult>((resolve) => {
    const child = runner.spawn(cmd, args, {
      policy: opts.policy,
      // The I1 baseline allowlist, NOT the gateway's environment and NOT `{}`.
      //
      // The intent is the same as inheriting nothing -- a stray token in `process.env` reaching
      // approved-but-untrusted code would be an exfiltration path the filesystem and network rules
      // never see -- but a literally empty block does not work: `CreateProcessW` fails with 203
      // (ERROR_ENVVAR_NOT_FOUND) when the child has no `SystemRoot`, so on Windows EVERY execution
      // died at exit 68 before running a line. `extensionProcessEnv` is the same
      // invariant-governed scoping every spawned MCP child already uses, and its BASELINE_KEYS
      // carries `SYSTEMROOT`/`PATH`/`TEMP` and nothing secret. Reusing it beats a second, private
      // answer to a question this tree has already answered once.
      env: extensionProcessEnv({}),
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outChunks: Uint8Array[] = [];
    const errChunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    let reason: TerminationReason = "exited";
    let settled = false;
    let stopping = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    // NB: do NOT unref() these timers -- an awaited promise settling from an unref'd timer makes
    // `bun test` spin forever on Windows. Both are cleared on settle.
    const wallTimer = setTimeout(() => {
      // Only claim the wall clock if nothing else has already ended this run. An output-cap kill
      // the child outlives by a moment must keep reporting `output_cap` — that is the cause; the
      // wall clock merely arrived afterwards.
      if (reason === "exited") reason = "wall_clock";
      stop();
    }, opts.maxWallClockMs);

    /**
     * Idempotent. Every call used to schedule ANOTHER escalation timer while `settle()` cleared
     * only the last one, so a child emitting several chunks past a full budget left earlier timers
     * armed to fire `SIGKILL` after the promise had already resolved — at a pid the OS may by then
     * have reused. One stop, one escalation.
     */
    function stop(): void {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
    }

    function settle(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (escalation !== undefined) clearTimeout(escalation);
      // Trim only when WE cut the stream. Left alone otherwise, so genuinely invalid UTF-8 from
      // the child is reported as-is rather than quietly losing its last byte.
      const decode = (chunks: Uint8Array[]): string => {
        const joined = Buffer.concat(chunks);
        return new TextDecoder().decode(truncated ? trimPartialUtf8(joined) : joined);
      };
      resolve({
        exitCode,
        stdout: decode(outChunks),
        stderr: decode(errChunks),
        durationMs: now() - started,
        truncated,
        terminationReason: reason,
      });
    }

    /**
     * Accumulate raw BYTES, never decoded strings.
     *
     * Two separate reasons, both of which bite on non-ASCII output. `maxOutputBytes` is a byte
     * budget, but a decoded string's `.length` counts UTF-16 code units -- one emoji is 4 bytes and
     * 2 code units, so a 1 MiB cap measured that way admits up to ~4 MiB. And decoding per chunk is
     * wrong on its own terms: a multi-byte character split across a chunk boundary decodes to
     * U+FFFD, silently corrupting output that was never truncated at all.
     *
     * The budget is shared across stdout and stderr: it bounds the memory this function holds, and
     * a child can choose which stream to flood.
     */
    function overflow(): void {
      truncated = true;
      if (reason === "exited") reason = "output_cap";
      stop();
    }

    function absorb(chunk: unknown, into: Uint8Array[]): void {
      const buf = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
      const room = opts.maxOutputBytes - bytes;
      // A chunk arriving with the budget ALREADY exactly full is still an overflow. Returning here
      // without marking it -- the obvious reading of "no room left, nothing to do" -- left the
      // child running to the wall clock while the result claimed `truncated: false`, so output was
      // dropped and the caller was told none had been.
      if (room <= 0) {
        if (buf.byteLength > 0) overflow();
        return;
      }
      const slice = buf.byteLength > room ? buf.subarray(0, room) : buf;
      bytes += slice.byteLength;
      into.push(slice);
      if (buf.byteLength > room) overflow();
    }

    child.stdout?.on("data", (c: unknown) => absorb(c, outChunks));
    child.stderr?.on("data", (c: unknown) => absorb(c, errChunks));
    child.on("error", () => settle(null));
    child.on("close", (code: number | null) => settle(code));
  });
}
