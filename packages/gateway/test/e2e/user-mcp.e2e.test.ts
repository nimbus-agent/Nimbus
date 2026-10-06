// User MCP servers end-to-end: the whole owner path against a REAL gateway subprocess and a REAL
// compiled MCP server — scaffold (`nimbus scaffold mcp`), compile (`bun build --compile`),
// register (`connector.addMcp`), list (`connector.userMcpTools`), call (`connector.userMcpCall`,
// I42 consent over the wire), and remove (`connector.remove`, which deletes the sandbox leaf).
//
// Every other test for this feature drives the handlers or the mesh directly, so all of them would
// still pass with the outer IPC routing unwired, or with the user MCP spawned UNCONFINED. The
// assertion this file exists for is the confinement one: a `probe` tool that reads a sentinel file
// OUTSIDE every grant must come back DENIED, after a positive control proves the file is readable
// at all — without that control, "denied" would pass for any reason (a typo'd path included).
//
// The scaffold is produced by SPAWNING the CLI (the gateway may not import CLI source), and its
// two dependencies are junctioned to the repo's installed copies exactly as the CLI's own scaffold
// test does. No network: the user MCP is registered with no `netHosts`.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";

// --- TestIpcClient + until copied verbatim from local-auth.e2e.test.ts ---

type NotificationHandler = (params: Record<string, unknown>) => void;

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();

  private failAllPending(reason: string): void {
    for (const [, cb] of this.pending) cb({ error: { message: reason } });
    this.pending.clear();
  }

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
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

  clearNotificationHandlers(): void {
    this.notifyHandlers.clear();
  }

  close(): void {
    this.sock?.destroy();
  }
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

// --- end copied section ---

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const IS_CI = process.env["CI"] === "true";

/** The helper CI (and `bun run build:sandbox-helper:win32`) builds in this checkout. */
const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/**
 * Whether this platform's sandbox can confine a no-network policy here. On Windows the probe is
 * pointed at the checkout's own helper for its construction only, then the env is put back: the
 * variable is process-global and `platform/sandbox/win32.test.ts` asserts on its default.
 */
const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "user-mcp-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
})();

/**
 * The user MCP is spawned through `wrapServerSpec`'s `__nimbus-sandbox` re-exec, whose env is built
 * by `extensionProcessEnv` (I1) and so never carries `NIMBUS_SANDBOX_HELPER_PATH`: the re-exec'd
 * wrapper resolves the helper next to `process.execPath` — the same `bun.exe` the test, the gateway
 * and the wrapper all run under. Exactly as `tool-run.e2e.test.ts` does, the checkout's helper is
 * copied there for this file's lifetime only (that directory is shared, real state) and removed
 * afterwards — and only if this file put it there.
 */
function installDefaultHelper(): () => void {
  if (process.platform !== "win32") return () => {};
  const defaultHelper = join(dirname(process.execPath), "nimbus-sandbox-helper.exe");
  if (existsSync(defaultHelper) || !existsSync(WIN_BUILT_HELPER)) return () => {};
  copyFileSync(WIN_BUILT_HELPER, defaultHelper);
  return () => {
    try {
      rmSync(defaultHelper, { force: true });
    } catch {
      /* best-effort -- a locked file here must not mask the test's real outcome */
    }
  };
}

/** A skip and a pass read the same in a CI summary; on CI an unconfinable sandbox fails by name. */
describe.skipIf(sandboxAvailable || !IS_CI)("user MCP e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined spawn", () => {
    expect(
      "user-mcp-e2e: CI precondition unmet -- the platform sandbox cannot confine a no-network " +
        "policy, so the user MCP cannot be spawned. Install this platform's sandbox dependency " +
        "(scripts/linux/install-sandbox-deps.sh on Linux, build:sandbox-helper:win32 on Windows).",
    ).toBeNull();
  });
});

/**
 * Wraps the scaffold's own `createServer()` with one more tool and connects it over stdio. The
 * probe reports the outcome rather than throwing, so the gateway relays a DENIED as a normal tool
 * result and the assertion can tell "the sandbox refused the read" apart from "the call failed".
 */
const PROBE_TS = `import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

const server = createServer();
server.registerTool(
  "probe",
  { description: "Try to read a file", inputSchema: { path: z.string() } },
  async ({ path }) => {
    try {
      return { content: [{ type: "text", text: \`READ \${readFileSync(path, "utf8")}\` }] };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: \`DENIED \${why}\` }] };
    }
  },
);
await server.connect(new StdioServerTransport());
`;

type CallOutcome = { status: "ok"; result: unknown } | { status: "rejected"; reason: string };

/** The text parts of an MCP `CallToolResult`, joined — the same rendering `nimbus connector call` uses. */
function resultText(outcome: CallOutcome): string {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  const r = outcome.result;
  if (typeof r === "object" && r !== null && "content" in r && Array.isArray(r.content)) {
    const parts: unknown[] = r.content;
    return parts
      .flatMap((p) =>
        typeof p === "object" && p !== null && "text" in p && typeof p.text === "string"
          ? [p.text]
          : [],
      )
      .join("\n");
  }
  return JSON.stringify(r);
}

async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe.skipIf(!sandboxAvailable)("a scaffolded user MCP over a real gateway", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-usermcp-e2e-"));
  const project = join(tmp, "echo_srv");
  const binary = join(project, "dist", process.platform === "win32" ? "echo_srv.exe" : "echo_srv");
  const sentinel = join(tmp, "outside", "secret.txt");
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nimbus-usermcp-${process.pid}-${randomUUID().slice(0, 8)}`
        : join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  const leaf = join(paths.sandboxDir, "user_mcp_echo_srv");
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  let restoreHelper: () => void = () => {};
  const client = new TestIpcClient();

  /** Every consent prompt the gateway raised, in order; and whether the next one is approved. */
  const prompts: string[] = [];
  let approve = true;

  beforeAll(async () => {
    // 1. Scaffold through the real CLI.
    const scaffold = await run(["bun", CLI_ENTRY, "scaffold", "mcp", "echo_srv"], tmp);
    if (scaffold.code !== 0) {
      throw new Error(`scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`);
    }
    expect(existsSync(join(project, "src", "server.ts"))).toBe(true);

    // 2. Link the two dependencies to their REAL installed paths (the installed packages are
    //    themselves bun-store symlinks; a relative link re-resolved inside a junction dangles, and a
    //    junction to the `@modelcontextprotocol` SCOPE dir does not resolve the package).
    mkdirSync(join(project, "node_modules", "@modelcontextprotocol"), { recursive: true });
    symlinkSync(
      realpathSync(join(REPO, "packages", "cli", "node_modules", "@modelcontextprotocol", "sdk")),
      join(project, "node_modules", "@modelcontextprotocol", "sdk"),
      "junction",
    );
    symlinkSync(
      realpathSync(join(REPO, "node_modules", "zod")),
      join(project, "node_modules", "zod"),
      "junction",
    );

    // 3. Add the probe tool and compile. No `--target`: embeds the running bun, downloads nothing.
    writeFileSync(join(project, "src", "probe.ts"), PROBE_TS, "utf8");
    const build = await run(
      ["bun", "build", "--compile", "src/probe.ts", "--outfile", join("dist", "echo_srv")],
      project,
    );
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }
    expect(existsSync(binary)).toBe(true);

    // 4. The sentinel, outside every grant (not under the project, not under the gateway's dirs).
    mkdirSync(join(tmp, "outside"), { recursive: true });
    writeFileSync(sentinel, "TOP-SECRET", "utf8");

    // 5. Boot the gateway.
    restoreHelper = installDefaultHelper();
    for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
    proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
    };
    void collect(proc.stderr as ReadableStream<Uint8Array>);
    void collect(proc.stdout as ReadableStream<Uint8Array>);
    try {
      await until(
        () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
        "gateway bind",
        60_000,
      );
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
      );
    }
    await client.connect(paths.socketPath);
    client.onNotification("consent.request", (params) => {
      prompts.push(String(params["prompt"] ?? ""));
      void client.call("consent.respond", { requestId: params["requestId"], approved: approve });
    });
  }, 180_000);

  afterAll(async () => {
    client.clearNotificationHandlers();
    client.close();
    proc?.kill();
    await proc?.exited.catch(() => {});
    restoreHelper();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("positive control: the sentinel is readable from the test process", () => {
    expect(readFileSync(sentinel, "utf8")).toBe("TOP-SECRET");
  });

  test("connector.addMcp registers the compiled binary", async () => {
    const out = await client.call<{ ok?: boolean; serviceId?: string }>("connector.addMcp", {
      serviceId: "mcp_echo_srv",
      argv: [binary],
    });
    expect(out).toMatchObject({ ok: true, serviceId: "mcp_echo_srv" });
  }, 60_000);

  test("connector.userMcpTools lists the scaffold's echo and the added probe", async () => {
    const out = await client.call<{ serviceId: string; tools: Array<{ name: string }> }>(
      "connector.userMcpTools",
      { serviceId: "mcp_echo_srv" },
    );
    expect(out.serviceId).toBe("mcp_echo_srv");
    const names = out.tools.map((t) => t.name);
    if (names.length === 0) {
      // The MCP client swallows a server that failed to start and lists nothing; the reason is
      // only in the gateway's own output.
      throw new Error(`no tools listed\n--- gateway output (tail) ---\n${gatewayLog.slice(-8000)}`);
    }
    expect(names).toContain("echo");
    expect(names).toContain("probe");
  }, 60_000);

  test("an approved echo call answers, and the I42 prompt named the tool", async () => {
    const before = prompts.length;
    const out = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: "mcp_echo_srv",
      tool: "echo",
      input: { text: "hello" },
    });
    expect(out.status).toBe("ok");
    expect(resultText(out)).toBe("hello");
    expect(prompts.slice(before).some((p) => p.includes("mcp_echo_srv.echo"))).toBe(true);
  }, 60_000);

  test("the user MCP is CONFINED: a read outside its grants is denied", async () => {
    const out = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: "mcp_echo_srv",
      tool: "probe",
      input: { path: sentinel },
    });
    const text = resultText(out);
    expect(text).not.toContain("TOP-SECRET");
    expect(text.startsWith("DENIED")).toBe(true);
  }, 60_000);

  test("a denied consent leaves the call rejected", async () => {
    approve = false;
    try {
      const out = await client.call<CallOutcome>("connector.userMcpCall", {
        serviceId: "mcp_echo_srv",
        tool: "echo",
        input: { text: "again" },
      });
      expect(out.status).toBe("rejected");
    } finally {
      approve = true;
    }
  }, 60_000);

  test("connector.remove deletes the sandbox leaf (or logs why it could not)", async () => {
    // The leaf existed: the calls above ran inside it.
    expect(existsSync(leaf)).toBe(true);
    const out = await client.call<{ ok?: boolean }>("connector.remove", {
      serviceId: "mcp_echo_srv",
    });
    expect(out.ok).toBe(true);
    const logFiles = existsSync(paths.logDir)
      ? readdirSync(paths.logDir).map((f) => readFileSync(join(paths.logDir, f), "utf8"))
      : [];
    const logged = [gatewayLog, ...logFiles].some((s) =>
      s.includes("user MCP sandbox directory not removed"),
    );
    expect(!existsSync(leaf) || logged).toBe(true);
  }, 60_000);
});
