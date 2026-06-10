// ChatOps end-to-end (Task 12 / PR #559 deferred boot wiring): a REAL gateway subprocess with
// [chatops].enabled + a SIGNED policy + seeded SCIM users + a mock Slack transport.
//
// The connector-tool layer is a file-backed sink (NIMBUS_CHATOPS_E2E_SINK_DIR — the documented
// e2e seam in assemble.ts, same precedent as NIMBUS_SKIP_EMBEDDING_RUNTIME): assemble swaps the
// real bot-credentialed connector spawn + mesh dispatch for a mock that returns this harness's
// WebSocket URL from slack_socket_open, resolves fixture emails from slack_user_info, and APPENDS
// chat posts / dispatched writes to a sink NDJSON file the test asserts on. This exercises the
// full chatops WIRING through a real gateway — IPC, signed-policy verification, SCIM lookups, the
// executor HITL gate (I2/I20), the audit chain, and the I23 reply surface — without depending on
// the OS sandbox spawn (verified independently: chatops-bot-spawn.test.ts + seccomp-filter.test.ts).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "_fixtures");
const RUNNER = join(FIXTURES_DIR, "gateway-runner.ts");

const ISSUER = "https://idp.e2e.example";
const POLICY_TOML = `
[policy]
version=1
org="acme"
[policy.chatops.channel."C0"]
namespace="project:pay"
unmapped="refuse"
notify=["C_ALERT"]
[policy.chatops.ownership]
"payment-service"="alice@acme.com"
"*"="oncall@acme.com"
`;

interface SinkEvent {
  kind: "chat_post" | "tool" | "dispatch";
  platform?: string;
  channel?: string;
  text?: string;
  toolId?: string;
  type?: string;
  payload?: Record<string, string>;
  args?: Record<string, string>;
}

/** Minimal NDJSON JSON-RPC 2.0 client over the gateway socket / named pipe. */
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
    if (typeof id !== "number") return; // notification
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as { result?: unknown; error?: unknown });
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}

function mention(channel: string, user: string, text: string, ts: string): string {
  return JSON.stringify({
    type: "events_api",
    envelope_id: `env-${ts}`,
    payload: { event: { type: "app_mention", channel, user, text, ts } },
  });
}

async function until<T>(probe: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("chatops e2e (real gateway subprocess + mock connector sink)", () => {
  // mkdtempSync (not join(tmpdir(), name)) — securely creates a unique 0700 dir, dodging the
  // predictable-temp-path CodeQL/Sonar S5443 finding.
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-chatops-e2e-"));
  const dataDir = join(tmp, "data");
  const sinkDir = join(tmp, "sink");
  const sinkPath = join(sinkDir, "mock-chatops-sink.ndjson");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\nimbus-chatops-e2e-${process.pid}-${randomUUID().slice(0, 8)}`
      : join(tmp, "gateway.sock");

  let wsServer: ReturnType<typeof Bun.serve> | undefined;
  let gatewaySocket: Bun.ServerWebSocket<unknown> | undefined;
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  const ipc = new TestIpcClient();

  function sinkEvents(): SinkEvent[] {
    if (!existsSync(sinkPath)) return [];
    return readFileSync(sinkPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as SinkEvent);
  }

  function chatPosts(): { channel: string; text: string }[] {
    return sinkEvents()
      .filter((e) => e.kind === "chat_post")
      .map((e) => ({ channel: e.channel ?? "", text: e.text ?? "" }));
  }

  function dispatches(): SinkEvent[] {
    return sinkEvents().filter((e) => e.kind === "dispatch");
  }

  function sendFrame(frame: string): void {
    if (gatewaySocket === undefined) throw new Error("gateway socket not connected");
    gatewaySocket.send(frame);
  }

  // Read the audit chain straight from the gateway's SQLite file (read-only). The gateway holds
  // its own write connection; busy_timeout + a short retry ride out a concurrent write lock.
  function auditRows(): { actionType: string; hitlStatus: string; actionJson: string }[] {
    const db = new Database(join(dataDir, "nimbus.db"), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const rows = db
        .query("SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id ASC")
        .all() as { action_type: string; hitl_status: string; action_json: string }[];
      return rows.map((r) => ({
        actionType: r.action_type,
        hitlStatus: r.hitl_status,
        actionJson: r.action_json,
      }));
    } finally {
      db.close();
    }
  }

  async function auditRowsWhen(
    pred: (rows: { actionType: string; hitlStatus: string; actionJson: string }[]) => boolean,
    what: string,
  ): Promise<{ actionType: string; hitlStatus: string; actionJson: string }[]> {
    return until(() => {
      try {
        const rows = auditRows();
        return pred(rows) ? rows : undefined;
      } catch {
        return undefined; // SQLITE_BUSY mid-write — retry
      }
    }, what);
  }

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

    // The harness WebSocket server the mock slack_socket_open points the gateway at.
    wsServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("not ws", { status: 400 });
      },
      websocket: {
        open(ws) {
          gatewaySocket = ws;
        },
        message() {
          /* envelope acks — not asserted */
        },
        close(ws) {
          if (gatewaySocket === ws) gatewaySocket = undefined;
        },
      },
    });

    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      [
        "[chatops]",
        "enabled = true",
        "slack_enabled = true",
        'bot_vault_entry = "chatops-bot"',
        "",
        "[identity]",
        "enabled = true",
        `issuer = "${ISSUER}"`,
        'client_id = "e2e-client"',
      ].join("\n"),
    );
    writeFileSync(
      join(sinkDir, "mock-chatops.json"),
      JSON.stringify({
        wsUrl: `ws://127.0.0.1:${wsServer.port}`,
        users: { U_BOB: "bob@acme.com", U_ALICE: "alice@acme.com" },
      }),
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
        NIMBUS_E2E_SEED_SCIM_JSON: JSON.stringify([
          { externalId: "ext-bob", userName: "bob", email: "bob@acme.com", active: true },
          { externalId: "ext-alice", userName: "alice", email: "alice@acme.com", active: true },
        ]),
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        gatewayLog += decoder.decode(chunk);
      }
    };
    void collect(gateway.stdout as ReadableStream<Uint8Array>);
    void collect(gateway.stderr as ReadableStream<Uint8Array>);

    try {
      await until(
        () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
        "ready",
        60_000,
      );
      // The Slack transport (auto-started at boot) dials our WS server via the mock connector.
      await until(() => gatewaySocket, "gateway socket-mode connection", 60_000);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
      );
    }

    // Sign + apply the chatops policy over real IPC (I22 anchor path).
    await ipc.connect(socketPath);
    const signed = (await ipc.call("policy.sign", { toml: POLICY_TOML })) as { org?: string };
    expect(signed.org).toBe("acme");
  }, 120_000);

  afterAll(async () => {
    ipc.close();
    gateway?.kill();
    await gateway?.exited.catch(() => {});
    wsServer?.stop(true);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("read: mapped user gets an answer in the originating channel", async () => {
    sendFrame(mention("C0", "U_BOB", "<@UBOT> who is on call for payment-service?", "100.1"));
    const reply = await until(
      () => chatPosts().find((p) => p.text.includes("oncall = alice")),
      "read reply",
    );
    expect(reply.channel).toBe("C0");
    expect(reply.text).toContain("project:pay");
  }, 60_000);

  test("write: owner-routed card → owner approves → connector tool dispatched + audit approved", async () => {
    sendFrame(
      mention(
        "C0",
        "U_BOB",
        "<@UBOT> run deployment.rollback service=payment-service version=v1.4",
        "200.1",
      ),
    );
    const card = await until(
      () => chatPosts().find((p) => p.text.includes("Approval needed")),
      "approval card",
    );
    expect(card.channel).toBe("C0");
    expect(card.text).toContain("alice@acme.com");

    sendFrame(mention("C0", "U_ALICE", "<@UBOT> approve", "200.2"));
    const rollback = await until(
      () => dispatches().find((e) => e.type === "deployment.rollback"),
      "rollback dispatch",
    );
    expect(rollback.payload).toEqual({ service: "payment-service", version: "v1.4" });
    await until(
      () => chatPosts().find((p) => p.text.includes("approved & executed")),
      "approved reply",
    );
    const rows = await auditRowsWhen(
      (rs) => rs.some((r) => r.actionType === "deployment.rollback" && r.hitlStatus === "approved"),
      "approved audit row",
    );
    expect(
      rows.some((r) => r.actionType === "deployment.rollback" && r.hitlStatus === "approved"),
    ).toBe(true);
  }, 60_000);

  test("write: owner rejects → no dispatch + audit rejected", async () => {
    const before = dispatches().length;
    sendFrame(
      mention(
        "C0",
        "U_BOB",
        "<@UBOT> run deployment.rollback service=payment-service version=v2.0",
        "300.1",
      ),
    );
    await until(
      () =>
        chatPosts().filter((p) => p.text.includes("Approval needed")).length >= 2
          ? true
          : undefined,
      "second approval card",
    );
    sendFrame(mention("C0", "U_ALICE", "<@UBOT> reject", "300.2"));
    await until(() => chatPosts().find((p) => p.text.includes("rejected")), "rejected reply");
    expect(dispatches().length).toBe(before);
    const rows = await auditRowsWhen(
      (rs) => rs.some((r) => r.actionType === "deployment.rollback" && r.hitlStatus === "rejected"),
      "rejected audit row",
    );
    expect(
      rows.some((r) => r.actionType === "deployment.rollback" && r.hitlStatus === "rejected"),
    ).toBe(true);
  }, 60_000);

  test("unmapped user under refuse mode → refusal reply + refusal audit row", async () => {
    sendFrame(mention("C0", "U_EVE", "<@UBOT> who is on call?", "400.1"));
    const refusal = await until(
      () => chatPosts().find((p) => p.text.includes("not enrolled")),
      "refusal reply",
    );
    expect(refusal.channel).toBe("C0");
    const rows = await auditRowsWhen(
      (rs) => rs.some((r) => r.actionType === "chatops.refusal"),
      "refusal audit row",
    );
    const row = rows.find((r) => r.actionType === "chatops.refusal");
    expect(row).toBeDefined();
    expect(row?.actionJson ?? "").toContain("unmapped_user");
  }, 60_000);

  test("I23: every operational post landed in the originating channel or a policy notify channel", () => {
    const posts = chatPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.channel === "C0" || p.channel === "C_ALERT")).toBe(true);
  });
});
