// Share & Virality (Slice 8a) end-to-end: a REAL gateway subprocess driven over IPC. Proves the
// I27 outbound-share round-trip end-to-end: the share-gate reads the seeded session turns
// (collectSession), redacts secrets + PII, prompts the LOCAL owner over the broadcast channel
// (share.approvalRequest), and — only after the owner approves via share.approvalRespond — signs +
// persists + writes the share file. A second create that the owner REJECTS persists/writes nothing
// (fail-closed). verify-share then re-verifies the written file's signature over the same gateway.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); the session_memory store still serves
// getRecentTurns from the no-vec rows the runner seeds, so redaction has real PII to strip.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type NotificationHandler = (params: Record<string, unknown>) => void;

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();

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

  /** Register a handler for a JSON-RPC notification (broadcast, no `id`). */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notifyHandlers.set(method, handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") {
      const method = msg["method"];
      if (typeof method === "string") {
        const handler = this.notifyHandlers.get(method);
        if (handler !== undefined) {
          handler((msg["params"] as Record<string, unknown> | undefined) ?? {});
        }
      }
      return;
    }
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
    ? `\\\\.\\pipe\\nimbus-share-e2e-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : "";
}

const SESSION_ID = "e2e-share-1";
const SECRET_EMAIL = "alice@corp.com";
const SECRET_IP = "10.1.2.3";

interface CreateResult {
  status: string;
  contentHash?: string;
}
interface VerifyResult {
  ok: boolean;
  signatureValid: boolean;
  contentHashValid: boolean;
  expired: boolean;
  errors: string[];
}

describe("share e2e (real gateway subprocess — I27 create → owner approve → verify round-trip)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-share-e2e-"));
  const dataDir = join(tmp, "data");
  const outPath = join(tmp, "out", "share.json");
  const rejectedPath = join(tmp, "out", "rejected.json");
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
    writeFileSync(join(paths.configDir, "nimbus.toml"), "");

    gateway = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_E2E_SEED_SESSION_JSON: JSON.stringify([
          { sessionId: SESSION_ID, role: "user", text: `ping ${SECRET_EMAIL} on ${SECRET_IP}` },
          { sessionId: SESSION_ID, role: "assistant", text: "ack, will reach out" },
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

  test("approved create redacts PII, signs, writes the file; verify reports a VALID signature", async () => {
    // Auto-approve the FIRST approval prompt the gateway broadcasts.
    ipc.onNotification("share.approvalRequest", (params) => {
      const requestId = params["requestId"];
      if (typeof requestId === "string") {
        void ipc.call("share.approvalRespond", { requestId, approved: true });
      }
    });

    const created = await ipc.call<CreateResult>("share.create", {
      sessionId: SESSION_ID,
      kind: "transcript",
      sink: { type: "file", path: outPath },
    });
    expect(created.status).toBe("ok");
    expect(typeof created.contentHash).toBe("string");

    const fileText = readFileSync(outPath, "utf8");
    expect(fileText).not.toContain(SECRET_EMAIL);
    expect(fileText).not.toContain(SECRET_IP);
    expect(fileText).toContain("[REDACTED]");
    const parsed = JSON.parse(fileText) as {
      body: { redactionSet: string[] };
      format: string;
    };
    expect(parsed.format).toBe("nimbus-share/v1");
    expect(parsed.body.redactionSet).toContain("emails");

    const verified = await ipc.call<VerifyResult>("share.verify", { input: outPath });
    expect(verified.signatureValid).toBe(true);
    expect(verified.contentHashValid).toBe(true);
    expect(verified.ok).toBe(true);

    // The share is recorded in the V41 ledger.
    const listed = await ipc.call<{ shares: { contentHash: string }[] }>("share.list", {});
    expect(listed.shares.map((s) => s.contentHash)).toContain(created.contentHash);
  });

  test("rejected approval persists + writes NOTHING (fail-closed)", async () => {
    ipc.onNotification("share.approvalRequest", (params) => {
      const requestId = params["requestId"];
      if (typeof requestId === "string") {
        void ipc.call("share.approvalRespond", { requestId, approved: false });
      }
    });

    const created = await ipc.call<CreateResult>("share.create", {
      sessionId: SESSION_ID,
      kind: "transcript",
      sink: { type: "file", path: rejectedPath },
    });
    expect(created.status).toBe("rejected");
    expect(created.contentHash).toBeUndefined();
    expect(() => readFileSync(rejectedPath, "utf8")).toThrow();
  });
});
