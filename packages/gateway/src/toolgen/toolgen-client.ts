import { pathToFileURL } from "node:url";
import { wrapServerSpec } from "../connectors/lazy-mesh/wrap-server-spec.ts";
import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import type { ToolgenBroker } from "./toolgen-broker.ts";
import { BROKERED_FETCH_METHOD, type ToolgenEnvelope } from "./toolgen-types.ts";

/** How long a `close()` waits for a graceful exit before escalating to SIGKILL. */
const CLOSE_ESCALATION_MS = 2_000;

/**
 * Backstop for a single `describe`/`call` round trip over `wireToolProtocol`'s wire, when the
 * caller does not supply its own. Deliberately generous and distinct from
 * `[tool_generation].request_timeout_ms` (the BROKER's per-fetch bound): a `call` invocation can
 * legitimately make several sequential brokered fetches, each already bounded on its own, so this
 * only needs to catch a child that is genuinely wedged — an infinite loop, a hung await on
 * something that will never resolve — never a slow-but-working one.
 */
const DEFAULT_PROTOCOL_REQUEST_TIMEOUT_MS = 60_000;

export interface ToolSpawnSpec {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/**
 * How a generated tool is launched.
 *
 * The script is IMPORTED via a tiny `-e` stub, never named as bun's entry point and never passed
 * inline. Both alternatives are measured dead ends recorded in `exec/exec-runtimes.ts`: naming the
 * file as the entry point (`bun run <path>` / `bun <path>`) fails under the Windows AppContainer
 * with `CouldntReadCurrentDirectory` — its startup path for a file entry point touches something
 * the sandbox denies, where `-e` does not — and `import()` of a granted file works there. Passing
 * the body inline is bounded by the Windows helper's `wchar_t cmdline[32768]`, and a generated tool
 * is a whole module, not a snippet. The `-e` import stub satisfies both constraints at once.
 *
 * Goes through `wrapServerSpec`, so I15/D10 applies to a generated tool exactly as to a connector:
 * the resulting command/args re-launch this same binary in the `__nimbus-sandbox` role, which reads
 * `NIMBUS_SANDBOX_POLICY_JSON`/`NIMBUS_SANDBOX_CWD` and is what actually confines the real `bun -e`
 * process — see `sandbox-wrapper.ts`'s `runSandboxWrapper`. That is the ONE confinement layer.
 * `spawnGeneratedTool` spawns this wrapped spec PLAINLY (no second, caller-side `SandboxRunner`),
 * the same pattern every other long-lived stdio child in this tree uses
 * (`connectors/lazy-mesh/user-mcp.ts`) — wrapping the spec a second time through a runner would
 * launch the wrapper role process itself inside an OS sandbox, which then tries to build a SECOND,
 * nested `SandboxRunner` and confine the real command again from inside an already-confined
 * process. That shape has no precedent anywhere else in the tree and is not what this does.
 */
export function buildToolSpawnSpec(envelope: ToolgenEnvelope, cwd: string): ToolSpawnSpec {
  const href = pathToFileURL(envelope.scriptPath).href;
  const spec = wrapServerSpec(
    {
      command: process.execPath,
      args: ["-e", `await import(${JSON.stringify(href)});`],
      env: extensionProcessEnv({}),
    },
    envelope.artifact.manifest,
    cwd,
  );
  return { command: spec.command, args: spec.args, env: spec.env as Record<string, string> };
}

export interface GeneratedToolHandle {
  describe(): Promise<{ name: string; description: string; inputSchema: unknown }>;
  call(args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The minimal shape `wireToolProtocol` needs from a spawned child: write a line to its stdin,
 * subscribe to raw stdout chunks, and kill it. Factored out (rather than driving `Bun.spawn`'s
 * result directly) so the SAME protocol logic `spawnGeneratedTool` drives can be exercised in a
 * test against a child spawned some other way, without reimplementing the framing twice.
 */
export interface ToolChildIo {
  writeLine(line: string): void;
  onStdoutData(cb: (chunk: Uint8Array) => void): void;
  /**
   * Signal the child. Defaults to the platform's terminate signal; `close()` passes `"SIGKILL"`
   * when the graceful window expires. Optional rather than required so an existing no-op fake
   * still satisfies the shape.
   */
  kill(signal?: NodeJS.Signals | number): void;
  /** Resolves once the child has actually exited. */
  waitExit(): Promise<void>;
}

/**
 * Adapts a `Bun.spawn` subprocess (stdin + stdout piped; stderr may be piped or inherited) to the
 * `ToolChildIo` shape. Exported so the runtime round-trip test drives the EXACT same adapter code
 * production spawns through, rather than reimplementing it a second time.
 */
export function ioFromSpawnedChild<Err extends "pipe" | "inherit" | "ignore" = "pipe">(
  child: Bun.Subprocess<"pipe", "pipe", Err>,
): ToolChildIo {
  let onData: ((chunk: Uint8Array) => void) | undefined;
  const pump = (async (): Promise<void> => {
    const reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onData?.(value);
    }
  })();
  // A read error must not crash the process — it surfaces as a hung/failed request instead, which
  // is the failure mode worth seeing (and is what the caller's own timeout/rejection reports).
  pump.catch(() => {});

  return {
    writeLine: (line) => {
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    },
    onStdoutData: (cb) => {
      onData = cb;
    },
    kill: (signal) => {
      // Already-exited children make this a no-op on some platforms and an ESRCH throw on others;
      // either way a kill that finds nothing to kill is success, not a failure to propagate.
      try {
        child.kill(signal);
      } catch {
        /* the child is already gone, which is the outcome this call wanted */
      }
    },
    waitExit: async () => {
      await child.exited;
    },
  };
}

interface InboundMessage {
  readonly id: string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Parse one line of the wire protocol. Never throws; an unparseable line is simply dropped. */
function parseInboundLine(line: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const out: {
    id: string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  } = { id: o["id"] };
  if (typeof o["method"] === "string") out.method = o["method"];
  if ("params" in o) out.params = o["params"];
  if ("result" in o) out.result = o["result"];
  if ("error" in o) out.error = o["error"];
  return out;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drive the hand-rolled line-delimited JSON protocol a generated tool speaks, over an already
 * spawned child.
 *
 * Deliberately NOT `@mastra/mcp`, which holds its SDK client PRIVATE and exposes only
 * `setElicitationRequestHandler` — there is no public API there for a custom server->client
 * handler. And deliberately not the official MCP SDK either, on the child side: the emitted script
 * (`emitToolScript`) imports NOTHING, because it runs from a directory with no `node_modules` and a
 * sandbox grant that deliberately does not include one.
 *
 * So both ends speak one protocol: `{id, method, params}` in, `{id, result}` or `{id, error}` out.
 * A message whose `method` equals `BROKERED_FETCH_METHOD` is the tool asking the gateway to make a
 * request — and is the ONLY route out of that process. Named via the constant rather than quoted,
 * so D29(a)'s confinement scan stays a one-file rule. Every other inbound line with no `method` is
 * a reply to one of OUR outbound requests (`describe`/`call`), matched by `id`.
 *
 * Messages crossing this boundary are `unknown` until narrowed here — a compromised or buggy
 * generated tool is exactly the untrusted-input case non-negotiable 7 exists for.
 */
export function wireToolProtocol(
  io: ToolChildIo,
  envelope: ToolgenEnvelope,
  broker: ToolgenBroker,
  requestTimeoutMs = DEFAULT_PROTOCOL_REQUEST_TIMEOUT_MS,
): GeneratedToolHandle {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;
  let buf = "";
  let closed = false;
  // ONE decoder for the life of the handle, fed with `{ stream: true }`. Decoding each chunk
  // independently corrupts any multi-byte character the pipe happens to split: both halves become
  // U+FFFD, and because the surrounding JSON still parses, a `call` result or a `describe`
  // description silently loses characters instead of failing loudly. A stateful decoder holds the
  // partial sequence across the boundary, which is the only way the reassembled line is the text
  // the tool actually wrote.
  const decoder = new TextDecoder("utf-8");

  const send = (msg: Record<string, unknown>): void => {
    io.writeLine(JSON.stringify(msg));
  };

  const failAllPending = (reason: string): void => {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  };

  /** Dispatch one parsed line: a brokered fetch, an unrecognized request, or a reply to ours. */
  const handleInbound = (msg: InboundMessage): void => {
    // The tool asking US to make a request — the only route out of that process.
    if (msg.method === BROKERED_FETCH_METHOD) {
      const id = msg.id;
      void broker
        .handleFetch(envelope.artifact.toolId, msg.params)
        .then((result) => send({ id, result }))
        .catch((err: unknown) => send({ id, error: errorMessageOf(err) }));
      return;
    }

    // Any other message carrying a `method` is an inbound request we do not recognize —
    // never treated as a reply, so it cannot spuriously resolve a pending call sharing its id.
    if (msg.method !== undefined) return;

    // A reply to one of OUR requests.
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) {
      p.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
      return;
    }
    p.resolve(msg.result);
  };

  io.onStdoutData((chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.trim() === "") continue;
      const msg = parseInboundLine(line);
      if (msg !== null) handleInbound(msg);
    }
  });

  // A wedged child (an infinite loop, a hung await on something that never resolves) must not
  // hang a `describe`/`call` caller forever — the request-timeout bound applies to the BROKER's
  // own outbound fetch, not to the child's own compute, so nothing else catches this.
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("generated tool handle is closed"));
    const id = `g${String(++seq)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`generated tool did not respond to "${method}" within ${requestTimeoutMs}ms`),
        );
      }, requestTimeoutMs);
      // Wrapped so EITHER a real reply or the timeout above clears the other's timer/pending
      // entry — whichever settles first must not leave the loser dangling.
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ id, method, params });
    });
  };

  return {
    describe: async () => {
      const r = await request("describe", {});
      const o = (r !== null && typeof r === "object" && !Array.isArray(r) ? r : {}) as Record<
        string,
        unknown
      >;
      return {
        name: typeof o["name"] === "string" ? o["name"] : envelope.artifact.toolName,
        description: typeof o["description"] === "string" ? o["description"] : "",
        // `unknown`, deliberately: this crosses a process boundary and is untrusted until a caller
        // validates it. The REGISTRY's artifact remains the source of truth; this value exists so a
        // caller can COMPARE the two and detect an altered on-disk script.
        inputSchema: o["inputSchema"],
      };
    },
    call: async (args) => await request("call", args),
    close: async () => {
      if (closed) return;
      closed = true;
      failAllPending("generated tool handle was closed");
      io.kill();
      // A generated tool has no signal-handling logic of its own (`emitToolScript` installs none),
      // so SIGTERM is expected to end it promptly. When it does not — an ignored signal, a tight
      // loop that never yields — the window expires and this ESCALATES to SIGKILL rather than
      // merely giving up waiting. That distinction is the whole point: `ToolgenRegistry.revokeAll`
      // awaits these calls and the shutdown drain treats a resolved `close()` as success, so
      // resolving on a still-live child would report a clean drain while the process survived the
      // gateway — breaking the "ephemeral means ephemeral" guarantee that is this feature's reason
      // for having no schema migration at all. The timer is cleared on the fast path so it never
      // outlives `close()` and dangles in a caller's (e.g. a test's) event loop.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          io.kill("SIGKILL");
          finish();
        }, CLOSE_ESCALATION_MS);
        void io.waitExit().then(finish);
      });
    },
  };
}

/**
 * Spawn a generated tool and serve its brokered-fetch requests until closed.
 *
 * Spawns the `wrapServerSpec`-wrapped spec PLAINLY, via `Bun.spawn` — no `SandboxRunner` here. The
 * spec's command already re-launches this binary in the `__nimbus-sandbox` role, and THAT process
 * is what builds a `SandboxRunner` and confines the real `bun -e` command when it starts (see
 * `buildToolSpawnSpec`'s docstring). This function has no `SandboxRunner` to hold and consults none
 * — the gate that gets an owner's approval before spawning anything (Task 8's
 * `assertToolConfinement`) is what verifies confinement is possible at all, ahead of this call.
 * Fewer capabilities in this file is the point, matching every other `wrapServerSpec`-then-plain-
 * spawn caller in the tree (`connectors/lazy-mesh/user-mcp.ts`).
 *
 * The only evidence of confinement visible from here is that `buildToolSpawnSpec`'s returned `env`
 * carries `NIMBUS_SANDBOX_POLICY_JSON` — asserted directly in `toolgen-client.test.ts`.
 *
 * `onExit`, when supplied, fires once the child has actually exited — for ANY reason, including a
 * crash, not only a graceful `close()`. The wiring caller (`platform/assemble.ts`) uses it to call
 * `ToolgenRegistry.markTerminated`, so a dead tool stops being offered to the model and stops
 * counting against the session's tool budget (`forSession`/`countForSession`) the moment it is
 * actually dead, rather than only when something later happens to notice. Firing it after an
 * owner-initiated `revoke()` is harmless and expected: `revoke()` already deletes the registry
 * entry before this fires, and `markTerminated` on an unknown toolId is a no-op.
 */
/**
 * Wires `onExit` to fire once the child behind `io` has actually exited, for any reason.
 *
 * Factored out of `spawnGeneratedTool` so the exit-detection logic itself can be exercised in a
 * test against a REAL, unsandboxed child (`toolgen-client.test.ts`) the same way `wireToolProtocol`
 * already is — sandbox confinement is a separate concern owned by `buildToolSpawnSpec` and the
 * integration test under `test/integration/toolgen/`, not this function's job.
 */
export function wireExitCallback(io: ToolChildIo, onExit: () => void): void {
  void io.waitExit().then(onExit);
}

export async function spawnGeneratedTool(
  envelope: ToolgenEnvelope,
  broker: ToolgenBroker,
  cwd: string,
  onExit?: () => void,
): Promise<GeneratedToolHandle> {
  const spec = buildToolSpawnSpec(envelope, cwd);
  // stderr is INHERITED, not piped. A pipe nothing reads is a deadlock: `ioFromSpawnedChild`
  // consumes only stdout, so once a generated tool wrote about one pipe buffer of stderr its
  // writes would block forever, and the tool would stop answering `describe`/`call` while
  // `wireToolProtocol` reported it as merely wedged. A generated body is owner-approved code that
  // may legitimately log, and the runtime itself prints warning traces there, so this is a
  // reachable state rather than a theoretical one. Inheriting also puts that output where an owner
  // debugging their own tool can actually see it.
  const child = Bun.spawn<"pipe", "pipe", "inherit">([spec.command, ...spec.args], {
    env: spec.env,
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const io = ioFromSpawnedChild(child);
  if (onExit !== undefined) {
    wireExitCallback(io, onExit);
  }
  return wireToolProtocol(io, envelope, broker);
}
