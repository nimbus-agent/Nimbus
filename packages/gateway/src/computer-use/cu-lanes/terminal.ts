import type { ChildProcess } from "node:child_process";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { createSandboxRunner } from "../../platform/sandbox/sandbox-runner.ts";
import type {
  CuTerminalLaunchPolicy,
  OpenTerminalLaneOptions,
  TerminalLane,
  TerminalWriteResult,
} from "../cu-types.ts";

/**
 * The terminal lane's driver: a long-lived shell, confined by `SandboxRunner`, driven over ordinary
 * stdio pipes. The ONLY file in the tree that spawns a shell for computer-use or writes to its
 * stdin (static rule D26(c) confines `openTerminalLane` to this file plus `platform/assemble.ts`).
 *
 * NOT A PTY, and that is a decision rather than a shortcut. Spec § 3.5 says "a PTY under the
 * sandbox", but § 4.3.1 narrows the lane to line-oriented only, which removes the only thing a PTY
 * would buy — and a real PTY needs a native module, in a binary this architecture requires to
 * `bun build --compile` and ship alone. The absence of a tty is moreover STRONGER than the
 * classifier: `vi`, `less`, `top` and `fzf` refuse to start against a pipe on their own, so the
 * lane's scope bound holds at the OS level instead of depending on us to keep them out.
 *
 * COMMAND COMPLETION is detected by QUIESCENCE, never by an injected sentinel. Appending an
 * `echo <nonce>` after the approved line would give exact boundaries at the cost of writing bytes
 * to the shell that the owner never saw or approved — the precise property I35's terminal clause
 * exists to hold. The cost of quiescence is that a command which pauses mid-run can look finished;
 * that is disclosed on the result (`settled`) and its late output is carried onto the next result
 * behind an explicit notice rather than dropped or silently merged.
 */

/**
 * How long to wait for the FIRST byte before concluding a command produced no output.
 *
 * A SEPARATE, longer window than the inter-chunk one below, and the separation is a correctness fix
 * rather than tuning. With a single 300 ms timer armed at write time, any command slower to its
 * first byte than 300 ms — a Python or Node start, a `find`, a cold disk read, and routinely
 * process startup on Windows under AppContainer — resolved with `output: ""` and `settled: "quiet"`
 * while still running. Its real output then landed in `carried` and was prepended to the NEXT
 * command's result. Nothing was lost, but everything was MISATTRIBUTED: the model was told command
 * 1 printed nothing, then shown command 1's output labelled as command 2's, and the audit row's
 * replay body recorded the same lie.
 *
 * The two windows cannot be one value. Collapsing them upward makes every silent command (`mkdir`,
 * `mv`, `export`) cost a full second before it returns; collapsing them downward reintroduces the
 * misattribution. So: wait up to a second for anything at all, then 300 ms of silence once output
 * has started.
 */
export const TERMINAL_FIRST_BYTE_MS = 1_000;
/** Silence AFTER the first byte that counts as "the command finished". */
export const TERMINAL_QUIET_MS = 300;
/** Hard ceiling on one command's collection window, whatever the stream is doing. */
export const TERMINAL_SETTLE_MS = 15_000;
/** Byte ceiling on one result. Shared across stdout and stderr — a child chooses which to flood. */
export const TERMINAL_OUTPUT_MAX_BYTES = 65_536;

/**
 * Prefixed to output that arrived after a previous command's window closed.
 *
 * LABELLED, never silently prepended. `TERMINAL_FIRST_BYTE_MS` narrows the misattribution window;
 * it cannot close it, because no timeout can distinguish "finished silently" from "still thinking".
 * Carrying the bytes forward is what stops them being LOST; saying where they came from is what
 * stops them being WRONG — and the same string lands on the `cu_action` replay body, so a human
 * reading the row later sees the same caveat the model did.
 */
export const CARRIED_OUTPUT_NOTICE =
  "[nimbus: output below arrived after the previous command's collection window closed]";

/** Injected so this file is testable with no shell installed and no sandbox helper present. */
export interface TerminalLaneRuntime {
  spawnShell(args: {
    readonly cmd: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly launch: CuTerminalLaunchPolicy;
  }): ChildProcess;
}

/**
 * Drop a trailing INCOMPLETE UTF-8 sequence — needed only where WE made the cut. Decoding a
 * fragment yields a U+FFFD we manufactured, which re-encodes to 3 bytes and can push a capped
 * buffer back OVER its own cap. Same helper, same reasoning, as `exec/exec-run.ts`.
 */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  return 4;
}

function trimPartialUtf8(buf: Uint8Array): Uint8Array {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte — keep walking back to the lead byte
    return sequenceLength(b) === back ? buf : buf.subarray(0, buf.length - back);
  }
  return buf;
}

export async function openTerminalLane(
  opts: OpenTerminalLaneOptions,
  runtime?: TerminalLaneRuntime,
): Promise<TerminalLane> {
  let rt = runtime;
  if (rt === undefined) {
    const runner = await createSandboxRunner();
    rt = {
      spawnShell: ({ cmd, args, cwd, launch }) =>
        runner.spawn(cmd, [...args], {
          policy: launch.policy,
          // The I1 baseline allow-list plus the shell's history/rc suppression — NOT the gateway's
          // environment. A stray token in `process.env` reaching an owner-approved-but-untrusted
          // command would be an exfiltration path the filesystem and network rules never see.
          env: extensionProcessEnv({ ...launch.envOverlay }),
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        }),
    };
  }

  const { launch } = opts;
  const child = rt.spawnShell({
    cmd: launch.shellPath,
    args: launch.argv,
    cwd: launch.cwd,
    launch,
  });

  let exited = false;
  child.once("close", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });

  /**
   * Bytes that arrived while no `write` was collecting. Carried onto the next result rather than
   * dropped: it is the owner's own shell output, and losing it silently would make the audit row's
   * replay body a description of something that never happened.
   */
  let carried: Uint8Array[] = [];
  let carriedBytes = 0;
  let collector: ((chunk: Uint8Array) => void) | null = null;
  /** Guards against two writes collecting at once — see the check at the top of `write`. */
  let inFlight = false;

  const absorbIdle = (chunk: Uint8Array): void => {
    const room = TERMINAL_OUTPUT_MAX_BYTES - carriedBytes;
    if (room <= 0) return;
    const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    carriedBytes += slice.byteLength;
    carried.push(slice);
  };

  const onData = (c: unknown): void => {
    const buf = c instanceof Uint8Array ? c : new TextEncoder().encode(String(c));
    if (collector !== null) collector(buf);
    else absorbIdle(buf);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const lane: TerminalLane = {
    isAlive: () => !exited,

    async write(bytes: string): Promise<TerminalWriteResult> {
      if (exited) {
        throw new Error("ERR_CU_TERMINAL_DEAD: the shell is not alive");
      }
      // Concurrent entry would overwrite `collector`, so two in-flight writes would collect into
      // each other's buffers and one promise would never settle. `cu-gate.ts` already serialises
      // `runAction` per session, so this is unreachable through the gate — which is exactly why it
      // belongs here: a driver whose correctness depends on its caller's discipline is a contract
      // no test of either side can check, and this lane's only caller today is not its only caller
      // forever.
      if (inFlight) {
        throw new Error("ERR_CU_CONCURRENT_WRITE: a write is already collecting on this lane");
      }
      inFlight = true;

      return await new Promise<TerminalWriteResult>((resolve) => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (carried.length > 0) {
          // Labelled, not silently prepended — see CARRIED_OUTPUT_NOTICE.
          const notice = new TextEncoder().encode(`${CARRIED_OUTPUT_NOTICE}\n`);
          chunks.push(notice, ...carried);
          total = notice.byteLength + carriedBytes;
        }
        carried = [];
        carriedBytes = 0;

        let settled: TerminalWriteResult["settled"] = "quiet";
        let truncated = total >= TERMINAL_OUTPUT_MAX_BYTES;
        let done = false;
        /** Has anything arrived since the write? Chooses which silence window applies. */
        let sawOutput = false;
        // NB: do NOT unref these timers — an awaited promise settling from an unref'd timer makes
        // `bun test` spin forever on Windows. Both are cleared on settle.
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const settleCap = setTimeout(() => {
          settled = "settle_cap";
          finish();
        }, TERMINAL_SETTLE_MS);

        function finish(): void {
          if (done) return;
          done = true;
          collector = null;
          inFlight = false;
          if (quiet !== undefined) clearTimeout(quiet);
          clearTimeout(settleCap);
          child.off("close", onClose);
          const joined = Buffer.concat(chunks);
          resolve({
            output: new TextDecoder().decode(truncated ? trimPartialUtf8(joined) : joined),
            settled,
            truncated,
          });
        }

        function onClose(): void {
          settled = "exited";
          finish();
        }
        child.once("close", onClose);

        /**
         * Arm the silence timer with the window that applies RIGHT NOW: the long first-byte window
         * until something has arrived, the short inter-chunk window afterwards. `settled` records
         * which one expired, so a caller can tell "produced nothing within a second" from
         * "finished".
         */
        function armQuiet(): void {
          if (quiet !== undefined) clearTimeout(quiet);
          const window = sawOutput ? TERMINAL_QUIET_MS : TERMINAL_FIRST_BYTE_MS;
          quiet = setTimeout(() => {
            settled = sawOutput ? "quiet" : "no_output";
            finish();
          }, window);
        }

        collector = (chunk: Uint8Array): void => {
          sawOutput = true;
          const room = TERMINAL_OUTPUT_MAX_BYTES - total;
          if (room <= 0) {
            truncated = true;
            settled = "output_cap";
            finish();
            return;
          }
          const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          total += slice.byteLength;
          chunks.push(slice);
          if (chunk.byteLength > room) {
            truncated = true;
            settled = "output_cap";
            finish();
            return;
          }
          armQuiet();
        };

        // THE WRITE. Exactly the approved bytes plus the one newline that submits them — no
        // sentinel, no prelude, nothing appended. This single line is what invariant I35's terminal
        // clause is about, and it is the reason command completion is detected by quiescence above
        // rather than by anything written here.
        child.stdin?.write(`${bytes}\n`);
        armQuiet();
      });
    },

    async close(): Promise<void> {
      if (exited) return;
      try {
        child.stdin?.end();
      } catch {
        // The shell may already be gone; the kill below is what actually matters.
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (exited) return resolve();
        child.once("close", () => resolve());
        setTimeout(() => resolve(), 2_000);
      });
      exited = true;
    },
  };

  return lane;
}
