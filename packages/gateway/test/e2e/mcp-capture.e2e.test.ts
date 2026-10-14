import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");

const root = mkdtempSync(join(tmpdir(), "nimbus-mcp-capture-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

/** The data dir the CLI resolves under this env (mirrors packages/cli/src/paths.ts). */
function cliDataDir(): string {
  if (process.platform === "win32") return join(dirs.local, "Nimbus", "data");
  if (process.platform === "darwin")
    return join(dirs.home, "Library", "Application Support", "Nimbus");
  return join(dirs.xdgData, "nimbus");
}

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET", "NIMBUS_PROFILE"])
    delete env[k];
  return {
    ...env,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
  };
}

const gw = {
  configDir: join(root, "gw-config"),
  dataDir: join(root, "gw-data"),
  logDir: join(root, "gw-log"),
  extensionsDir: join(root, "gw-ext"),
  tempDir: join(root, "gw-tmp"),
  sandboxDir: join(root, "gw-sandbox"),
  socketPath:
    process.platform === "win32"
      ? `\\\\.\\pipe\\nimbus-capture-${String(process.pid)}-${randomUUID().slice(0, 8)}`
      : join(root, "gw.sock"),
};
for (const d of [
  gw.configDir,
  gw.dataDir,
  gw.logDir,
  gw.extensionsDir,
  gw.tempDir,
  gw.sandboxDir,
]) {
  mkdirSync(d, { recursive: true });
}

let gateway: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let gatewayLog = "";

async function until<T>(probe: () => T | undefined, what: string, ms: number): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = probe();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}\n--- gateway log ---\n${gatewayLog}`);
}

async function bootGateway(enabled: boolean): Promise<void> {
  writeFileSync(
    join(gw.configDir, "nimbus.toml"),
    [
      "[mcp_sink]",
      `enabled = ${String(enabled)}`,
      'kinds = ["note", "decision", "term", "link"]',
      "max_per_hour = 30",
    ].join("\n"),
  );
  gatewayLog = "";
  gateway = Bun.spawn(["bun", RUNNER], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      NIMBUS_E2E_PATHS_JSON: JSON.stringify(gw),
      NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
      NIMBUS_NOTIFICATIONS: "off",
    },
  });
  for (const stream of [gateway.stdout, gateway.stderr]) {
    void (async () => {
      for await (const chunk of stream) gatewayLog += new TextDecoder().decode(chunk);
    })();
  }
  await until(
    () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
    "gateway ready",
    60_000,
  );
  mkdirSync(cliDataDir(), { recursive: true });
  writeFileSync(
    join(cliDataDir(), "gateway.json"),
    JSON.stringify({ pid: gateway.pid, socketPath: gw.socketPath }),
  );
}

async function stopGateway(): Promise<void> {
  gateway?.kill();
  await gateway?.exited;
  gateway = undefined;
}

/** Minimal newline-delimited JSON-RPC client over the gateway IPC socket (as user-mcp.e2e.test.ts). */
class RawIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();

  private failAllPending(reason: string): void {
    for (const [, cb] of this.pending) cb({ error: { message: reason } });
    this.pending.clear();
  }

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolveConn, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolveConn());
      sock.on("error", (e) => {
        reject(e);
        this.failAllPending(`socket error: ${e.message}`);
      });
      sock.on("close", () => this.failAllPending("socket closed"));
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
    return new Promise<T>((resolveCall, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: IPC call timed out`)), 30_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolveCall(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC 2.0. */
class StdioMcp {
  private readonly proc = Bun.spawn(["bun", CLI_ENTRY, "mcp-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(),
  });
  private buf = "";
  private stderrText = "";
  private readonly parseErrors: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor() {
    void (async () => {
      for await (const chunk of this.proc.stderr)
        this.stderrText += new TextDecoder().decode(chunk);
    })();
    void (async () => {
      for await (const chunk of this.proc.stdout) {
        this.buf += new TextDecoder().decode(chunk);
        let nl = this.buf.indexOf("\n");
        while (nl >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line !== "") {
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              const id = msg["id"];
              if (typeof id === "number") this.pending.get(id)?.(msg);
            } catch {
              this.parseErrors.push(line);
            }
          }
          nl = this.buf.indexOf("\n");
        }
      }
    })();
  }

  private send(msg: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    this.proc.stdin.flush();
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((res) => this.pending.set(id, res));
    this.send({ jsonrpc: "2.0", id, method, params });
    const msg = await Promise.race([
      reply,
      Bun.sleep(60_000).then(() => {
        throw new Error(
          `MCP ${method} timed out
--- mcp stderr ---
${this.stderrText}
--- unparseable stdout lines ---
${this.parseErrors.join("\n")}
--- gateway log ---
${gatewayLog}`,
        );
      }),
    ]);
    if (msg["error"] !== undefined) throw new Error(JSON.stringify(msg["error"]));
    return msg["result"] as Record<string, unknown>;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "e2e-editor", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async toolNames(): Promise<string[]> {
    const r = await this.request("tools/list");
    return (r["tools"] as Array<{ name: string }>).map((t) => t.name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    const content = r["content"] as Array<{ text: string }>;
    return { text: content[0]?.text ?? "", isError: r["isError"] === true };
  }

  async close(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: cliEnv(),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

afterAll(async () => {
  await stopGateway();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold the pipe briefly; the OS temp sweep collects it.
  }
});

describe("MCP capture sink — end to end", () => {
  beforeAll(async () => {
    await bootGateway(true);
  }, 180_000);

  test("capture_note → searchable via searchIndex → listed → revoked → gone", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      expect(await mcp.toolNames()).toContain("capture_note");

      const marker = `zebracapture${randomUUID().slice(0, 6)}`;
      const cap = await mcp.callTool("capture_note", {
        title: `Decision ${marker}`,
        body: `We chose WAL. ${marker}`,
      });
      expect(cap.isError).toBe(false);
      const id = /Captured note (cap_[A-Za-z0-9_-]+)/.exec(cap.text)?.[1];
      expect(id).toBeDefined();

      const found = await mcp.callTool("searchIndex", { query: marker });
      expect(found.text).toContain(`nimbus:${String(id)}`);
      expect(found.text).toContain('"agentAuthored": true');

      const listed = await runCli(["captures", "list", "--json"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(String(id));
      expect(listed.stdout).toContain("e2e-editor");

      const revoked = await runCli(["captures", "revoke", String(id)]);
      expect(revoked.code).toBe(0);

      const after = await mcp.callTool("searchIndex", { query: marker });
      expect(after.text).not.toContain(`nimbus:${String(id)}`);
    } finally {
      await mcp.close();
    }
  }, 120_000);

  test("an mcp-declared socket connection is refused the owner captures.* methods, and no owner tool is offered", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      // Positive control: the sink is on and the tool list is real, so the absence below means something.
      expect(names).toContain("capture_note");
      expect(names.some((n) => /revoke|accept|reject/i.test(n))).toBe(false);
    } finally {
      await mcp.close();
    }

    const ipc = new RawIpcClient();
    await ipc.connect(gw.socketPath);
    try {
      await ipc.call("session.declareKind", { kind: "mcp" });
      for (const [method, params] of [
        ["captures.revoke", { id: "cap_x" }],
        ["captures.list", {}],
      ] as const) {
        let failure = "";
        try {
          await ipc.call(method, params);
        } catch (e) {
          failure = String(e);
        }
        expect(failure).toContain("ERR_CAPTURE_FORBIDDEN_CLIENT");
      }
    } finally {
      ipc.close();
    }
  }, 180_000);

  test("propose_decision → absent from `nimbus decisions` → accept → present with the agent disclosure → revoke → gone", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      for (const t of ["propose_decision", "propose_term", "propose_link"])
        expect(names).toContain(t);

      const marker = `zebradecision${randomUUID().slice(0, 6)}`;
      const prop = await mcp.callTool("propose_decision", {
        statement: `Adopt ${marker}`,
        rationale: "e2e",
      });
      expect(prop.isError).toBe(false);
      expect(prop.text).toContain("NOT recorded yet");
      const id = /Proposed decision (cap_[A-Za-z0-9_-]+)/.exec(prop.text)?.[1];
      expect(id).toBeDefined();

      // Absent by construction while proposed.
      const before = await runCli(["decisions"]);
      expect(before.code).toBe(0);
      expect(before.stdout).not.toContain(marker);
      const searchBefore = await mcp.callTool("searchIndex", { query: marker });
      expect(searchBefore.text).not.toContain(String(id));

      const accepted = await runCli(["captures", "accept", String(id)]);
      expect(accepted.code).toBe(0);

      // POSITIVE CONTROL for the absence above: the same query now finds it, with the disclosure.
      const after = await runCli(["decisions"]);
      expect(after.stdout).toContain(marker);
      expect(after.stdout).toContain("captured via MCP, accepted by the owner");

      expect((await runCli(["captures", "revoke", String(id)])).code).toBe(0);
      const gone = await runCli(["decisions"]);
      expect(gone.stdout).not.toContain(marker);
    } finally {
      await mcp.close();
    }
  }, 180_000);

  test("propose_term → reject → listed as rejected, never in the glossary", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const term = `zebraterm${randomUUID().slice(0, 6)}`;
      const prop = await mcp.callTool("propose_term", { term, definition: "an e2e term" });
      const id = /Proposed glossary term (cap_[A-Za-z0-9_-]+)/.exec(prop.text)?.[1];
      expect(id).toBeDefined();
      expect((await runCli(["captures", "reject", String(id)])).code).toBe(0);
      const listed = await runCli(["captures", "list", "--state", "rejected", "--json"]);
      expect(listed.stdout).toContain(String(id));
      const glossary = await runCli(["glossary"]);
      expect(glossary.stdout).not.toContain(term);
    } finally {
      await mcp.close();
    }
  }, 180_000);

  test("sink OFF → capture_note is absent from tools/list", async () => {
    await stopGateway();
    await bootGateway(false);
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      expect(names).not.toContain("capture_note");
      expect(names).toContain("searchIndex");
    } finally {
      await mcp.close();
    }
  }, 180_000);
});
