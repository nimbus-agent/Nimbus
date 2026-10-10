// E2E over a REAL gateway socket for `notifications.status` / `notifications.test` (pre-S3 item E).
//
// Proves the OUTER routing in `ipc/server/dispatchers.ts` (the `PHASE4_PLATFORM_DISPATCHERS` table
// entry), not only the inner handler map — a handler wired without its routing entry compiles,
// passes every unit test that calls it directly, and returns "Method not found" over a real socket.
// Also proves the assemble.ts wiring end to end: the runtime `assemblePlatformServices` builds is
// the one the IPC context reads, and the env override reaches it.
//
// Boots the shared `gateway-runner.ts` fixture with NIMBUS_NOTIFICATIONS=off, so no toast is ever
// raised and no platform tool is ever spawned.
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
    ? `\\\\.\\pipe\\nimbus-notif-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
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
 * routing needed here (unlike `tail-stream.e2e.test.ts`'s `TailTestClient`), since both
 * `notifications.*` methods are plain call/reply methods.
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

  /** Calls `method` and returns the result, throwing on a JSON-RPC error. */
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
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-notif-${tag}-`));
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
    // Nothing here touches search or embeddings.
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
    // The point of this test: a gateway booted by a test NEVER raises a real toast. With the env
    // override the service is disabled, never probes (no PowerShell/osascript/notify-send spawn),
    // and notifications.test reports that it did not deliver.
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

const EXPECTED_BACKEND: Record<string, string> = {
  win32: "windows-toast",
  darwin: "macos-osascript",
  linux: "linux-libnotify",
};

describe("notifications.* over a real socket", () => {
  test(
    "status reports disabled-by-env with the real backend; test reports it did not deliver",
    async () => {
      const gw = await startTestGateway("off");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        const status = await client.call<Record<string, unknown>>("notifications.status", {});
        expect(status).toEqual({
          backend: EXPECTED_BACKEND[process.platform] ?? "none",
          enabled: false,
          content: "full",
          available: null,
          reason: "disabled by NIMBUS_NOTIFICATIONS=off",
          disabledBy: "env",
          rateLimitedTotal: 0,
          delivers: false,
        });

        const result = await client.call<Record<string, unknown>>("notifications.test", {});
        expect(result).toEqual({
          delivered: false,
          reason: "disabled by NIMBUS_NOTIFICATIONS=off",
          status,
        });

        // Negative control: the router answers "Method not found" for a name nobody claims, so the
        // two successes above are the routing entry at work, not a catch-all.
        const missing = await client.raw("notifications.nope", {});
        expect(missing.error?.code).toBe(-32601);
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
