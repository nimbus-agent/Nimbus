// Real-socket routing proof for the oncall.pushed* IPC namespace: a handler present in
// dispatchOncallPushRpc but missing from PHASE4_PLATFORM_DISPATCHERS returns "Method not found" here.
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
    ? `\\\\.\\pipe\\nimbus-oncallpush-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
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
 * `oncall.pushedList` and the `demo.firePage` miss probe are both plain call/reply methods.
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
   * Calls `method` and returns the result, throwing on a JSON-RPC error.
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
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-oncallpush-${tag}-`));
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

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    // `oncall.pushedList` on a default (push-disabled) gateway touches neither search nor embeddings —
    // skipping the runtime avoids a real (or stalled) MiniLM/CDN fetch slowing boot for no reason
    // relevant to what this test asserts.
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
    // Never raise a real OS toast (or probe for one) from a test-booted gateway.
    NIMBUS_NOTIFICATIONS: "off",
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

describe("oncall.* routing over a real socket", () => {
  test(
    "oncall.pushedList is ROUTED (not Method not found) on a default gateway",
    async () => {
      const gw = await startTestGateway("route");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const r = await client.call<{ enabled: boolean; briefs: unknown[] }>(
          "oncall.pushedList",
          {},
        );
        expect(r.enabled).toBe(false); // default off
        expect(r.briefs).toEqual([]);
        // demo.firePage is claimed only by a demo-rooted gateway (Task 10)
        const miss = await client.raw("demo.firePage", {});
        expect(JSON.stringify(miss.error)).toContain("Method not found");
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
