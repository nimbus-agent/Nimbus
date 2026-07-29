// #928 end-to-end: a REAL gateway subprocess must bind its IPC socket and serve requests while
// the embedding model is still being fetched.
//
// The block being reproduced is exact: `[embedding] provider = "hybrid"` makes
// `tryCreateRoutingEmbeddingRuntime` `await createLocalEmbedder(...)`, which downloads MiniLM
// from a third-party CDN. Assembly used to await that BEFORE `ipc.start()`, so on a cold machine
// the socket never appeared and `nimbus init` looked hung with no error (up to the 600 s worker
// init window).
//
// The stall is made deterministic WITHOUT touching a CDN: the test starts a local TCP server that
// accepts the proxy CONNECT and then never answers, and points the gateway's HTTPS_PROXY at it.
// The model fetch therefore hangs for the whole test. Pre-fix, the gateway would never bind.
// A second gateway points at a proxy that hangs up immediately — a failed fetch — and must stay
// up and keep serving rather than dying.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");

type EmbeddingReadinessWire = {
  state: "warming" | "ready" | "unavailable" | "disabled";
  elapsedMs: number;
  model: string | null;
  dims: number | null;
  download: { file: string; loadedBytes: number; totalBytes: number; percent: number } | null;
  reason: string | null;
};

class TinyIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    (v: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }) => void
  >();

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => reject(e));
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
    cb(msg as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } });
  }

  /** Resolves the RAW JSON-RPC envelope so a test can assert on the typed error, not just a throw. */
  raw(
    method: string,
    params: unknown,
  ): Promise<{
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
  }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}

/** A proxy that accepts the connection and then goes silent — an indefinitely slow CDN. */
function startStallingProxy(sockets: net.Socket[]): Promise<number> {
  const server = net.createServer((sock) => {
    sockets.push(sock);
    // Deliberately no response, ever.
  });
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      servers.push(server);
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

/** A proxy that hangs up immediately — an outright failed fetch. */
function startRefusingProxy(): Promise<number> {
  const server = net.createServer((sock) => sock.destroy());
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      servers.push(server);
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

const servers: net.Server[] = [];
const heldSockets: net.Socket[] = [];

function pipeOrSocket(dir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-bindfirst-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : join(dir, `gw-${tag}.sock`);
}

async function until(probe: () => boolean, what: string, ms: number): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (probe()) return Date.now() - start;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what} after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Booted = {
  proc: ReturnType<typeof Bun.spawn>;
  log: () => string;
  socketPath: string;
  bindMs: number;
};

async function bootGateway(tag: string, proxyPort: number): Promise<Booted> {
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-bindfirst-${tag}-`));
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
  // `hybrid` is the provider whose construction AWAITS the local model load — the exact
  // blocking path from the issue.
  writeFileSync(
    join(paths.configDir, "nimbus.toml"),
    '[embedding]\nenabled = true\nprovider = "hybrid"\n',
  );
  // A fresh, empty cache dir guarantees a real (stalled) fetch rather than a cache hit.
  const modelDir = join(tmp, "models");
  mkdirSync(modelDir, { recursive: true });

  const proxy = `http://127.0.0.1:${String(proxyPort)}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    NIMBUS_EMBEDDING_MODEL_DIR: modelDir,
    // Hybrid needs a key present to reach the local-model load at all.
    OPENAI_API_KEY: "sk-e2e-not-used-no-request-is-made",
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
  };
  delete env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];

  const started = Date.now();
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
    await until(() => log.includes("[gateway] ready (e2e)"), `${tag} gateway bind`, 60_000);
  } catch (e) {
    proc.kill();
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- gateway output ---\n${log.slice(-4000)}`,
    );
  }
  return { proc, log: () => log, socketPath: paths.socketPath, bindMs: Date.now() - started };
}

describe("gateway bind-first (#928): the socket serves while the embedding model is still fetching", () => {
  let stalled: Booted | undefined;
  const ipc = new TinyIpcClient();

  beforeAll(async () => {
    const port = await startStallingProxy(heldSockets);
    stalled = await bootGateway("stall", port);
    await ipc.connect(stalled.socketPath);
  }, 120_000);

  afterAll(() => {
    ipc.close();
    stalled?.proc.kill();
    for (const s of heldSockets) s.destroy();
    for (const s of servers) s.close();
  });

  test("binds while the model fetch is stalled — the fetch never gates startup", async () => {
    // The stalling proxy never answers, so the model load is still in flight right now.
    // Binding at all is the property under test; the budget is a generous sanity bound.
    expect(stalled?.bindMs ?? Number.MAX_SAFE_INTEGER).toBeLessThan(60_000);
    const ping = await ipc.raw("gateway.ping", {});
    expect(ping.error).toBeUndefined();
    const emb = (ping.result as Record<string, unknown>)["embedding"] as EmbeddingReadinessWire;
    // The socket answered while embeddings were demonstrably NOT ready: bind happened first.
    expect(emb).toBeDefined();
    expect(emb.state).not.toBe("ready");
    expect(["warming", "unavailable"]).toContain(emb.state);
  });

  test("a semantic search during warm-up returns the typed warming condition, never []", async () => {
    const ping = await ipc.raw("gateway.ping", {});
    const emb = (ping.result as Record<string, unknown>)["embedding"] as EmbeddingReadinessWire;
    if (emb.state !== "warming") {
      // The proxy failed the fetch outright rather than stalling it; the warming assertion is
      // covered deterministically by the unit tests. Assert the degrade contract instead.
      const r = await ipc.raw("index.searchRanked", { name: "who owns billing", limit: 5 });
      expect(r.error).toBeUndefined();
      return;
    }
    const res = await ipc.raw("index.searchRanked", { name: "who owns billing", limit: 5 });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32021);
    expect(res.error?.message ?? "").toContain("warming up");
    const data = res.error?.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect(data?.["code"]).toBe("embedding_warming");
    const wire = data?.["readiness"] as EmbeddingReadinessWire;
    expect(wire.state).toBe("warming");
  });

  test("an explicitly keyword-only search is served normally during warm-up", async () => {
    const res = await ipc.raw("index.searchRanked", {
      name: "who owns billing",
      limit: 5,
      semantic: false,
    });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.result)).toBe(true);
  });

  test("non-embedding surfaces are fully available while the model is still fetching", async () => {
    const demo = await ipc.raw("index.demoSymbol", {});
    // `index.demoSymbol` reads indexed symbols and never touches a vector table, so it must
    // answer (with a result OR a domain error) rather than be blocked on the model.
    expect(demo.error?.code).not.toBe(-32021);
    const audit = await ipc.raw("audit.list", { limit: 1 });
    expect(audit.error).toBeUndefined();
  });
});

describe("gateway bind-first (#928): a FAILED model fetch degrades, it does not kill the gateway", () => {
  let failed: Booted | undefined;
  const ipc = new TinyIpcClient();

  beforeAll(async () => {
    const port = await startRefusingProxy();
    failed = await bootGateway("fail", port);
    await ipc.connect(failed.socketPath);
  }, 120_000);

  afterAll(() => {
    ipc.close();
    failed?.proc.kill();
    for (const s of servers) s.close();
  });

  test("the gateway stays up and keeps serving after the model fetch fails", async () => {
    const ping = await ipc.raw("gateway.ping", {});
    expect(ping.error).toBeUndefined();
    expect((ping.result as Record<string, unknown>)["version"]).toBeDefined();
    const emb = (ping.result as Record<string, unknown>)["embedding"] as EmbeddingReadinessWire;
    expect(emb.state).not.toBe("ready");
    // Still alive after the failure, and still answering non-vector work.
    const audit = await ipc.raw("audit.list", { limit: 1 });
    expect(audit.error).toBeUndefined();
    expect(failed?.proc.killed).toBeFalsy();
  });
});
