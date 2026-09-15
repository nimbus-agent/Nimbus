// E2E over a REAL gateway socket for `nimbus explain last` (spec §3.1, §9).
//
// This is the ONE layer that catches a handler wired into `diagnostics-rpc.ts`'s
// `dispatchDiagnosticsRpc` switch without a matching entry in `tryDispatchDiagnosticsRpc`'s own
// method-prefix/name match in `ipc/server/dispatchers.ts` — that combination compiles cleanly and
// every unit test that calls `dispatchDiagnosticsRpc` directly stays green, because those tests
// never go through the outer router at all. Over a real socket, the outer router is exactly what
// decides whether the request reaches the inner dispatcher in the first place: miss the routing
// entry and a real client gets "Method not found", live. This repo has shipped exactly that
// defect before.
//
// Boots a real gateway subprocess (the same `gateway-runner.ts` fixture `tail-stream.e2e.test.ts`
// uses) and drives it over a real Unix-socket/named-pipe connection with a minimal JSON-RPC client
// — no mocks at the IPC layer.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");

const BOOT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

function pipeOrSocket(dir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-explainlast-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : join(dir, `gw-${tag}.sock`);
}

async function until(probe: () => boolean, what: string, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - start > ms) {
      throw new Error(`timed out waiting for ${what} after ${String(ms)}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

type RpcReply = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * A minimal JSON-RPC 2.0 client over the raw socket — request/response only, no notification
 * routing needed here (unlike `tail-stream.e2e.test.ts`'s `TailTestClient`), since
 * `ask.explainLast` and `agent.invoke` are both plain call/reply methods.
 */
class TinyIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: RpcReply) => void>();

  connect(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => reject(e));
      sock.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let idx = this.buffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line !== "") this.onLine(line);
          idx = this.buffer.indexOf("\n");
        }
      });
      this.sock = sock;
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") return;
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as RpcReply);
  }

  raw(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /**
   * Calls `method` and returns the result, throwing on a JSON-RPC error — the shape the task
   * brief's illustrative snippet assumed.
   */
  async call<T>(method: string, params: unknown): Promise<T> {
    const reply = await this.raw(method, params);
    if (reply.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.result as T;
  }

  disconnect(): void {
    this.sock?.destroy();
  }
}

async function startTestGateway(tag: string): Promise<{
  socketPath: string;
  stop: () => Promise<void>;
}> {
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-explainlast-${tag}-`));
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath: pipeOrSocket(tmp, tag),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
  };
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    // Neither `ask.explainLast` nor a fresh-index `agent.invoke` touches search or embeddings —
    // skipping the runtime avoids a real (or stalled) MiniLM/CDN fetch slowing boot for no reason
    // relevant to what this test asserts.
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
  };

  const proc = Bun.spawn(["bun", RUNNER], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let log = "";
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  try {
    await until(
      () => log.includes("[gateway] ready (e2e)"),
      `${tag} gateway bind`,
      BOOT_TIMEOUT_MS,
    );
  } catch (e) {
    proc.kill();
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- gateway output ---\n${log.slice(-4000)}`,
    );
  }

  let stopped = false;
  return {
    socketPath: paths.socketPath,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill();
      try {
        await proc.exited;
      } catch {
        // best-effort — the process is being torn down regardless
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("explain last over a real socket", () => {
  test(
    "reports the empty state on a fresh gateway, then the ask, over a real ask.explainLast route",
    async () => {
      const gw = await startTestGateway("basic");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        // Over a REAL socket: this is the only layer that catches a handler wired into
        // `dispatchDiagnosticsRpc` but never added to `tryDispatchDiagnosticsRpc`'s outer match —
        // that returns "Method not found" live while every unit test calling the sub-dispatcher
        // directly stays green.
        const empty = await client.call<{ record: unknown; reason: string }>(
          "ask.explainLast",
          null,
        );
        expect(empty).toEqual({ record: null, reason: "no_ask_since_start" });

        // A fresh gateway has an empty index, so this ask takes the `empty_index` route rather
        // than actually answering — and records WITHOUT throwing either way (`run-ask.ts`'s
        // `recordExplainSafely` runs on every exit path). Assert on the recorded question, not on
        // a particular route, so this test does not depend on which route a fresh index happens
        // to take.
        const askReply = await client.raw("agent.invoke", {
          input: "what is indexed?",
          stream: false,
        });
        // `agent.invoke` may itself surface a domain error on an empty index (a separate,
        // already-covered concern) — what matters here is only that a record now exists.
        void askReply;

        const after = await client.call<{ record: Record<string, unknown> | null }>(
          "ask.explainLast",
          null,
        );
        expect(after.record?.["question"]).toBe("what is indexed?");

        // Assert the KEY SET a real gateway produced (fix-wave finding CRITICAL 2), not just that
        // SOME record came back. `explain-format.ts`'s CLI-side parser is a strict, independently
        // declared mirror of the gateway's `AskExplainRecord` — a gateway-side rename of any field
        // here would not degrade the CLI report, it would replace it with a malformed-response
        // error, and no unit test on either side alone can catch that: this is the one place both
        // shapes are checked against what actually crossed the wire. A fresh, empty index takes
        // the `empty_index` route, whose only field beyond the shared base is `route` itself;
        // `modelRoute` and `fallbackFromLocalRouter` are never set on this route, so they must be
        // ABSENT here, not merely unchecked.
        const record = after.record;
        expect(record).not.toBeNull();
        if (record !== null && record !== undefined) {
          expect(new Set(Object.keys(record))).toEqual(
            new Set([
              "askedAt",
              "durationMs",
              "question",
              "source",
              "persona",
              "classifier",
              "route",
            ]),
          );
          expect(record["route"]).toBe("empty_index");
        }
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
