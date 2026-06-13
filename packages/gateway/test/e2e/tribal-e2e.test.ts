// Tribal-knowledge (Slice 6c) end-to-end: a REAL gateway subprocess with [tribal].enabled, driven
// over IPC. Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1) — repeat detection is inert in
// that mode (covered by the unit suite), so this harness seeds the cluster ledger directly and
// proves the boot wiring + IPC surface end-to-end: status/list/dismiss, the I25 capture fail-closed
// (`not_configured` when no KB destination is configured — it returns BEFORE any HITL), and the
// `not_found` path. A second gateway proves the privacy fail-closed (empty watch_channels → boot
// aborts). The full capture WRITE (owner-HITL → connector dispatch) is exercised by the unit suite
// (tribal-write-gate / dispatcher capture); it needs an IPC consent round-trip out of scope here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", reject);
      sock.on("data", (chunk) => {
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
    cb(msg as { result?: unknown; error?: unknown });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}

const FIXTURES_DIR = join(import.meta.dir, "_fixtures");
const RUNNER = join(FIXTURES_DIR, "gateway-runner.ts");

async function until<T>(probe: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pipePath(tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-tribal-e2e-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : "";
}

describe("tribal e2e (real gateway subprocess, IPC surface + I25 fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-tribal-e2e-"));
  const dataDir = join(tmp, "data");
  const sinkDir = join(tmp, "sink");
  const socketPath = process.platform === "win32" ? pipePath("a") : join(tmp, "gateway.sock");
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  const ipc = new TestIpcClient();

  beforeAll(async () => {
    const paths = {
      configDir: join(tmp, "config"),
      dataDir,
      logDir: join(tmp, "logs"),
      socketPath,
      extensionsDir: join(tmp, "extensions"),
      tempDir: join(tmp, "tmp"),
    };
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(sinkDir, { recursive: true });
    // [tribal] enabled with a watch allowlist, but NO [tribal.notion]/[tribal.confluence] → a
    // capture must fail closed with not_configured (the I25 config-only-destination boundary).
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      ["[tribal]", "enabled = true", 'watch_channels = ["C0"]'].join("\n"),
    );

    gateway = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_CHATOPS_E2E_SINK_DIR: sinkDir,
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_E2E_SEED_TRIBAL_JSON: JSON.stringify([
          { clusterId: "k-seed", question: "how do I deploy the gateway?", channelId: "C0" },
        ]),
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
    };
    void collect(gateway.stdout as ReadableStream<Uint8Array>);
    void collect(gateway.stderr as ReadableStream<Uint8Array>);

    try {
      await until(
        () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
        "ready",
        60_000,
      );
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
      );
    }
    await ipc.connect(socketPath);
  }, 120_000);

  afterAll(async () => {
    ipc.close();
    gateway?.kill();
    await gateway?.exited.catch(() => {});
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("tribal.status reports the watcher enabled with the seeded cluster", async () => {
    const status = await ipc.call<{ enabled: boolean; clusters: number }>("tribal.status", {});
    expect(status.enabled).toBe(true);
    expect(status.clusters).toBe(1);
  });

  test("tribal.list returns the seeded cluster", async () => {
    const rows = await ipc.call<{ clusterId: string }[]>("tribal.list", {});
    expect(rows.map((c) => c.clusterId)).toContain("k-seed");
  });

  test("I25: capture with no configured KB destination fails closed (not_configured)", async () => {
    const r = await ipc.call<{ ok: boolean; error?: string }>("tribal.capture", {
      clusterId: "k-seed",
      target: "notion",
    });
    expect(r).toEqual({ ok: false, error: "not_configured" });
  });

  test("capture of an unknown cluster → not_found", async () => {
    const r = await ipc.call<{ ok: boolean; error?: string }>("tribal.capture", {
      clusterId: "does-not-exist",
    });
    expect(r).toEqual({ ok: false, error: "not_found" });
  });

  test("tribal.dismiss puts the cluster into cooldown (status dismissed)", async () => {
    await ipc.call("tribal.dismiss", { clusterId: "k-seed" });
    const rows = await ipc.call<{ clusterId: string }[]>("tribal.list", { status: "dismissed" });
    expect(rows.map((c) => c.clusterId)).toContain("k-seed");
  });
});

describe("tribal e2e — privacy fail-closed (enabled with empty watch_channels)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-tribal-e2e-fc-"));
  const socketPath = process.platform === "win32" ? pipePath("b") : join(tmp, "gateway.sock");
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";

  afterAll(async () => {
    gateway?.kill();
    await gateway?.exited.catch(() => {});
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("the gateway boot aborts (never becomes ready) with a watch_channels error", async () => {
    const paths = {
      configDir: join(tmp, "config"),
      dataDir: join(tmp, "data"),
      logDir: join(tmp, "logs"),
      socketPath,
      extensionsDir: join(tmp, "extensions"),
      tempDir: join(tmp, "tmp"),
    };
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      ["[tribal]", "enabled = true", "watch_channels = []"].join("\n"),
    );
    gateway = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
    };
    void collect(gateway.stdout as ReadableStream<Uint8Array>);
    void collect(gateway.stderr as ReadableStream<Uint8Array>);

    const code = await gateway.exited;
    expect(code).not.toBe(0);
    expect(gatewayLog).not.toContain("[gateway] ready (e2e)");
    expect(gatewayLog).toContain("watch_channels");
  }, 60_000);
});
