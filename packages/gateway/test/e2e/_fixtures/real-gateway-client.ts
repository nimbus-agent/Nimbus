// Shared real-gateway fixture for E2E tests that must go over a REAL socket.
//
// A real socket is the ONE layer that catches a handler wired into an inner dispatcher without the
// outer router's match in `ipc/server/dispatchers.ts` — that combination compiles cleanly and every
// unit test calling the inner dispatcher directly stays green, while a real client gets "Method not
// found". Boots a real gateway subprocess (`gateway-runner.ts`) and drives it with a minimal
// JSON-RPC client — no mocks at the IPC layer.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "gateway-runner.ts");

export const BOOT_TIMEOUT_MS = 60_000;
export const TEST_TIMEOUT_MS = 120_000;

function pipeOrSocket(dir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-e2e-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
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

export type RpcReply = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * A minimal JSON-RPC 2.0 client over the raw socket — request/response only, no notification
 * routing needed here (unlike `tail-stream.e2e.test.ts`'s `TailTestClient`), since
 * `ask.explainLast` and `agent.invoke` are both plain call/reply methods.
 */
export class TinyIpcClient {
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

export async function startRealGateway(
  tag: string,
  opts?: { configFiles?: Record<string, string>; env?: Record<string, string> },
): Promise<{
  socketPath: string;
  stop: () => Promise<void>;
}> {
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-e2e-${tag}-`));
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath: pipeOrSocket(tmp, tag),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  for (const [name, text] of Object.entries(opts?.configFiles ?? {})) {
    writeFileSync(join(paths.configDir, name), text);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    // Neither `ask.explainLast` nor a fresh-index `agent.invoke` touches search or embeddings —
    // skipping the runtime avoids a real (or stalled) MiniLM/CDN fetch slowing boot for no reason
    // relevant to what this test asserts.
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
    // Never raise a real OS toast (or probe for one) from a test-booted gateway.
    NIMBUS_NOTIFICATIONS: "off",
    ...opts?.env,
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
