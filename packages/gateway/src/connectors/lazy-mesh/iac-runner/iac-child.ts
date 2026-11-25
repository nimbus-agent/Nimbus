// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-child.ts
// The started child as the iac runner sees it, and the one MCP call it makes (invariants I15, I1;
// static D43(d)). Split out of `iac-runner.ts` with no behaviour change: it builds no profile and
// no `ServerSpec`; the runner hands it an already-wrapped spec.
import type { ChildProcess } from "node:child_process";
import { IAC_ESCALATE_AFTER_MS } from "../../connector-writes/iac-limits.ts";
import type { ServerSpec } from "../slot.ts";

// ---------------------------------------------------------------------------------------------
// The child and the one MCP call it makes.

/** A started child as the runner sees it (a node child process in production, a fake in tests). */
export interface IacChild {
  /** The OS process id, when the child started (recorded so a later boot knows what may be alive). */
  readonly pid?: number;
  /** Writes one JSON-RPC line to the child's stdin. */
  send(line: string): void;
  /** Called with every complete line the child writes to stdout. */
  onLine(cb: (line: string) => void): void;
  /** Called once, when the process has actually exited (or failed to start). */
  onExit(cb: (code: number | null) => void): void;
  /** SIGTERM-class (`force` false) or SIGKILL-class (`force` true). */
  kill(force: boolean): void;
  /** Closes stdin (the connector exits on EOF). */
  closeInput(): void;
}

export type IacChildSpawner = (spec: ServerSpec) => IacChild;

/**
 * Wraps a started process. The child counts as exited when the OS reports it closed, or when it
 * never started; a later `"error"` event (a kill or a write that failed) says nothing about the
 * process being gone, so it must not free the run lock.
 */
export function iacChildFromProcess(proc: ChildProcess): IacChild {
  let exited = false;
  const exitCbs: Array<(code: number | null) => void> = [];
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(code);
  };
  proc.on("close", (code) => finish(code));
  proc.on("error", () => {
    // pid is undefined only when the spawn itself failed; any other error leaves the process there.
    if (proc.pid === undefined) finish(null);
  });
  proc.stderr?.on("data", () => {
    // Drained and dropped: a connector's stderr never reaches the model, the owner or a log.
  });
  proc.stdin?.on("error", () => {
    // A write after the child exited; the exit path reports it.
  });
  return {
    ...(proc.pid === undefined ? {} : { pid: proc.pid }),
    send: (line) => {
      proc.stdin?.write(`${line}\n`);
    },
    onLine: (cb) => {
      let buf = "";
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (d: string) => {
        buf += d;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line !== "") cb(line);
          i = buf.indexOf("\n");
        }
      });
    },
    onExit: (cb) => {
      if (exited) cb(proc.exitCode);
      else exitCbs.push(cb);
    },
    kill: (force) => {
      try {
        proc.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // already gone
      }
    },
    closeInput: () => {
      try {
        proc.stdin?.end();
      } catch {
        // already closed
      }
    },
  };
}

/** At gateway stop: the grace children get to finish (a state write) before SIGKILL. */
export const STOP_GRACE_MS = 15_000;
export const STOP_KILL_WAIT_MS = 5_000;

// The SIGTERM-to-SIGKILL grace, the plan's reap wait and the dispatcher's race over them live in
// `iac-limits.ts`, so the dispatcher's timeout is derived from the same numbers (it must outlast
// all of these: the runner always settles first).
export {
  IAC_EXIT_WAIT_MS as EXIT_WAIT_MS,
  iacEscalationGraceMs as escalationGraceMs,
} from "../../connector-writes/iac-limits.ts";

const ESCALATE_AFTER_MS = IAC_ESCALATE_AFTER_MS;

/** What one call to a child produced; `exited` resolves when the process is really gone. */
export interface ChildCall {
  readonly result: Promise<unknown>;
  readonly exited: Promise<void>;
}

/** The global timers, read at call time (a test may replace them after this module loads). */
function globalTimers(): { set: typeof setTimeout; clear: typeof clearTimeout } {
  return { set: setTimeout, clear: clearTimeout };
}

/**
 * Runs `initialize` then one `tools/call` against `child` and resolves with the call's MCP result.
 * On expiry of `budgetMs` the child is killed (SIGTERM, then SIGKILL after a grace period) and the
 * call rejects with `timeoutText`; a child that exits first rejects the call. `exited` settles only
 * when the process has exited, which is what the run lock waits for.
 */
export function callChildTool(
  child: IacChild,
  toolName: string,
  args: Record<string, unknown>,
  budgetMs: number,
  timeoutText: string,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = globalTimers(),
  escalateAfterMs: number = ESCALATE_AFTER_MS,
): ChildCall {
  let settled = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  let failCall: (e: Error) => void = () => undefined;

  child.onLine((line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC (a stray log line): ignored
    }
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;
    const id = rec["id"];
    if (typeof id === "number") waiters.get(id)?.(rec);
  });
  const request = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      failCall = reject;
      waiters.set(id, (m) => {
        if (m["error"] !== undefined) reject(new Error("iac: the connector reported an error"));
        else resolve(m);
      });
      child.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    child.closeInput();
    child.kill(false);
    escalation = timers.set(() => child.kill(true), escalateAfterMs);
  };
  child.onExit(() => {
    if (escalation !== undefined) timers.clear(escalation);
    if (killTimer !== undefined) timers.clear(killTimer);
    failCall(new Error("iac: the connector exited before it answered"));
    resolveExit();
  });

  const result = new Promise<unknown>((resolve, reject) => {
    killTimer = timers.set(() => {
      if (settled) return;
      settled = true;
      terminate();
      reject(new Error(timeoutText));
    }, budgetMs);
    void (async () => {
      try {
        await request(1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "nimbus-iac-runner", version: "1" },
        });
        child.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        const reply = await request(2, "tools/call", { name: toolName, arguments: args });
        if (settled) return;
        settled = true;
        resolve(reply["result"]);
      } catch (e) {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error("iac: the call failed"));
      } finally {
        if (killTimer !== undefined) timers.clear(killTimer);
        terminate();
      }
    })();
  });
  return { result, exited };
}
