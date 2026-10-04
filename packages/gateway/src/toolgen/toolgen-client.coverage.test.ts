/**
 * Paths of `toolgen-client.ts` (I39's spawn + wire protocol) that `toolgen-client.test.ts` does
 * not reach: `spawnGeneratedTool` itself — driven through its `spawn` seam over in-memory pipes, so
 * no sandbox wrapper process is started — a spawn that cannot start, a broker refusal that is not
 * an `Error`, and a `close()` whose child dies only from the SIGKILL escalation.
 */
import { describe, expect, test } from "bun:test";
import type { ToolgenBroker } from "./toolgen-broker.ts";
import {
  buildToolSpawnSpec,
  spawnGeneratedTool,
  type ToolChildIo,
  wireToolProtocol,
} from "./toolgen-client.ts";
import { BROKERED_FETCH_METHOD, type ToolgenEnvelope } from "./toolgen-types.ts";

const envelope: ToolgenEnvelope = {
  sessionId: "s-cov",
  scriptPath: "/opt/nimbus/toolgen/tg_cov/index.ts",
  approvedAt: 1,
  artifact: {
    toolId: "tg_cov",
    toolName: "approved-name",
    description: "d",
    body: "b",
    approvedHosts: [],
    credentialHosts: [],
    manifest: {
      id: "toolgen.tg_cov",
      version: "0.0.0",
      permissions: {
        network: [],
        filesystem: { read: ["/opt/nimbus/toolgen/tg_cov"], write: [] },
      },
      updateChannel: "stable",
    },
    inputSchema: { type: "object", properties: {} },
  },
};

const CWD = "/opt/nimbus/toolgen/tg_cov";

/** A broker that must never be reached by these tests' flows. */
const unusedBroker = {
  handleFetch: async () => {
    throw new Error("the broker was not expected to be called");
  },
} as unknown as ToolgenBroker;

interface FakeSubprocess {
  readonly sub: unknown;
  readonly signals: unknown[];
  readonly stdinLines: string[];
}

/**
 * A stand-in for a `Bun.spawn` subprocess with piped stdin/stdout: every complete stdin line is
 * handed to `answer`, whose return value (if any) is written back on stdout as one JSON line.
 * `kill` ends the process.
 */
function fakeSubprocess(answer: (msg: Record<string, unknown>) => unknown): FakeSubprocess {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let markExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    markExited = resolve;
  });
  const signals: unknown[] = [];
  const stdinLines: string[] = [];
  let partial = "";
  const stdin = {
    write: (s: string): number => {
      partial += s;
      for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
        const line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        stdinLines.push(line);
        const reply = answer(JSON.parse(line) as Record<string, unknown>);
        if (reply !== undefined) {
          controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
        }
      }
      return s.length;
    },
    flush: (): void => {},
  };
  const sub = {
    stdin,
    stdout,
    exited,
    kill: (signal?: unknown) => {
      signals.push(signal);
      markExited(143);
      controller?.close();
    },
  };
  return { sub, signals, stdinLines };
}

describe("spawnGeneratedTool", () => {
  test("spawns the WRAPPED spec with stdin/stdout piped, stderr INHERITED and the console hidden, then speaks the protocol over those pipes", async () => {
    const child = fakeSubprocess((msg) =>
      msg["method"] === "describe"
        ? { id: msg["id"], result: { name: "child-says", description: "from the child" } }
        : undefined,
    );
    const spawned: Array<{ cmd: unknown; opts: Record<string, unknown> }> = [];
    const spawn = ((cmd: unknown, opts: Record<string, unknown>) => {
      spawned.push({ cmd, opts });
      return child.sub;
    }) as unknown as typeof Bun.spawn;
    let exits = 0;

    const handle = await spawnGeneratedTool(
      envelope,
      unusedBroker,
      CWD,
      () => {
        exits += 1;
      },
      spawn,
    );

    const spec = buildToolSpawnSpec(envelope, CWD);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd).toEqual([spec.command, ...spec.args]);
    // stderr must be INHERITED: a pipe nothing reads would deadlock a tool that logs.
    expect(spawned[0]?.opts).toMatchObject({
      cwd: CWD,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    // The VALUE, not the key: `windowsHide: false` would pop a visible console window per run on
    // Windows exactly as an absent flag does.
    expect(spawned[0]?.opts["windowsHide"]).toBe(true);
    // The env is the WRAPPED spec's — the one carrying the sandbox policy the wrapper role reads.
    expect(spawned[0]?.opts["env"]).toEqual(spec.env);
    expect(Object.keys(spec.env)).toContain("NIMBUS_SANDBOX_POLICY_JSON");

    await expect(handle.describe()).resolves.toEqual({
      name: "child-says",
      description: "from the child",
      inputSchema: undefined,
    });
    expect(child.stdinLines.map((l) => (JSON.parse(l) as { method?: string }).method)).toEqual([
      "describe",
    ]);
    expect(exits).toBe(0); // still running

    await handle.close();
    await Bun.sleep(0);
    expect(child.signals).toEqual([undefined]);
    expect(exits).toBe(1);
  });

  test("a spawn that cannot start the executable REJECTS the returned promise rather than throwing synchronously", async () => {
    const spawn = (() => {
      throw new Error("ENOENT: nimbus-gateway not found");
    }) as unknown as typeof Bun.spawn;
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = spawnGeneratedTool(envelope, unusedBroker, CWD, undefined, spawn);
    }).not.toThrow();
    await expect(pending).rejects.toThrow("ENOENT: nimbus-gateway not found");
  });

  test("with no onExit callback, a child that dies still fails its outstanding call promptly", async () => {
    // This child never answers; it dies (here: killed from outside) while `call` is pending.
    const child = fakeSubprocess(() => undefined);
    const spawn = (() => child.sub) as unknown as typeof Bun.spawn;
    const handle = await spawnGeneratedTool(envelope, unusedBroker, CWD, undefined, spawn);
    const outstanding = handle.call({ q: 1 });
    (child.sub as { kill: (s?: unknown) => void }).kill("SIGTERM");
    await expect(outstanding).rejects.toThrow('generated tool exited before responding to "call"');
  });
});

describe("wireToolProtocol edges", () => {
  function scriptedIo(): {
    io: ToolChildIo;
    feed: (line: string) => void;
    writes: Array<Record<string, unknown>>;
    signals: unknown[];
  } {
    let onData: ((chunk: Uint8Array) => void) | undefined;
    let markExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const signals: unknown[] = [];
    return {
      io: {
        writeLine: (line) => writes.push(JSON.parse(line) as Record<string, unknown>),
        onStdoutData: (cb) => {
          onData = cb;
        },
        // This child ignores the graceful signal and dies only from SIGKILL.
        kill: (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") markExited();
        },
        waitExit: () => exited,
      },
      feed: (line) => onData?.(new TextEncoder().encode(`${line}\n`)),
      writes,
      signals,
    };
  }

  test("a broker refusal that is not an Error still reaches the child as an error on the same id", async () => {
    const s = scriptedIo();
    const broker = {
      handleFetch: async () => {
        throw "ERR_TOOLGEN_HOST_NOT_APPROVED: evil.example";
      },
    } as unknown as ToolgenBroker;
    wireToolProtocol(s.io, envelope, broker, 5_000);
    s.feed(
      JSON.stringify({
        id: "f9",
        method: BROKERED_FETCH_METHOD,
        params: { url: "https://evil.example/x" },
      }),
    );
    for (let i = 0; i < 50 && s.writes.length === 0; i += 1) await Bun.sleep(1);
    expect(s.writes).toEqual([{ id: "f9", error: "ERR_TOOLGEN_HOST_NOT_APPROVED: evil.example" }]);
  });

  test("a child that dies only from the SIGKILL escalation lets close() resolve, signalled exactly twice", async () => {
    const s = scriptedIo();
    const handle = wireToolProtocol(s.io, envelope, unusedBroker, 5_000);
    // The 2 s escalation window is shortened to 0 ms — only that timer, and only while `close()`
    // arms it (synchronously), so nothing else ever sees the swap.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) =>
      realSetTimeout(handler, timeout === 2_000 ? 0 : timeout)) as typeof setTimeout;
    let closing: Promise<void>;
    try {
      closing = handle.close();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await closing;
    expect(s.signals).toEqual([undefined, "SIGKILL"]);
    // The exit that the SIGKILL produced arrives after close() already settled; it must not
    // re-run the teardown (no third signal).
    await Bun.sleep(0);
    expect(s.signals).toEqual([undefined, "SIGKILL"]);
  });
});
