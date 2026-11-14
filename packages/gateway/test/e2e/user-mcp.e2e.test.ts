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

/**
 * The nearest `node_modules/<pkg>` at or above `from`, the way Node resolution walks up. Not a
 * fixed directory: the isolated layout puts the CLI's dependencies under `packages/cli/node_modules`,
 * the hoisted one (the Windows PR leg, so `node_modules` can be cached) puts them at the repo root.
 */
function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}
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
server.registerTool(
  "fail",
  { description: "Report an in-band tool error", inputSchema: {} },
  async () => ({ isError: true, content: [{ type: "text", text: "FAIL-MARKER no such thing" }] }),
);
// Agent door AD5a: a tool whose LISTED description the owner can change on the live server, so the
// definition hash can be seen to change without rebuilding the binary. \`retitle\` updates the
// registered tool in place, as a server that edits its own listing would.
const mutable = server.registerTool(
  "mutable",
  { description: "mutable v1", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: \`MUTABLE \${text}\` }] }),
);
server.registerTool(
  "retitle",
  { description: "Change the listed description of the mutable tool", inputSchema: { description: z.string() } },
  async ({ description }) => {
    mutable.update({ description });
    return { content: [{ type: "text", text: "RETITLED" }] };
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
  /** Granted to the server: the IN-SANDBOX positive control for the probe. */
  const grantedDir = join(tmp, "granted");
  const allowed = join(grantedDir, "allowed.txt");
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
  /** A second client that declares kind `mcp`: the act door's proposing agent. */
  const agent = new TestIpcClient();

  type LedgerRow = { id: number; destination: string; hitlStatus: string; method: string };
  /** The egress-ledger rows naming `destination`, read over the real `egress.list` IPC method. */
  async function ledgerRowsFor(destination: string): Promise<LedgerRow[]> {
    const out = await client.call<{ rows: LedgerRow[] }>("egress.list", { limit: 10_000 });
    return out.rows.filter((r) => r.destination === destination);
  }

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
      realpathSync(installedPackageDir("@modelcontextprotocol/sdk", join(REPO, "packages", "cli"))),
      join(project, "node_modules", "@modelcontextprotocol", "sdk"),
      "junction",
    );
    symlinkSync(
      realpathSync(installedPackageDir("zod", join(REPO, "packages", "cli"))),
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
    mkdirSync(grantedDir, { recursive: true });
    writeFileSync(allowed, "ALLOWED-CONTENT", "utf8");

    // 5. Boot the gateway.
    restoreHelper = installDefaultHelper();
    for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
    // The act door is off twice by default (`[mcp_sink] enabled`, and `action` not in `kinds`).
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      '[mcp_sink]\nenabled = true\nkinds = ["note", "action"]\naction_ttl_hours = 1\n',
      "utf8",
    );
    proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        // Never raise a real OS toast (or probe for one) from a test-booted gateway.
        NIMBUS_NOTIFICATIONS: "off",
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
    // An open named-pipe handle on Windows can hold the event loop and race the rmSync below.
    agent.close();
    for (const c of opened) c.close();
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
      readPaths: [grantedDir],
      // `--model`: only widens who may be offered the tools; the act door requires it.
      modelAccess: true,
    });
    expect(out).toMatchObject({ ok: true, serviceId: "mcp_echo_srv" });
  }, 60_000);

  test("a second client connects and declares kind mcp", async () => {
    await agent.connect(paths.socketPath);
    // The gateway answers with the kind it RECORDED for this connection; an unrecognised or
    // already-declared kind would come back as something other than `mcp`.
    const declared = await agent.call<{ kind: string }>("session.declareKind", { kind: "mcp" });
    expect(declared).toEqual({ kind: "mcp" });
  }, 30_000);

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
    const ledgerBefore = await ledgerRowsFor("mcp_echo_srv");
    const out = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: "mcp_echo_srv",
      tool: "echo",
      input: { text: "hello" },
    });
    expect(out.status).toBe("ok");
    expect(resultText(out)).toBe("hello");
    expect(prompts.slice(before).some((p) => p.includes("mcp_echo_srv.echo"))).toBe(true);
    // I29: the userMcpCall executor carries a REAL egress sink, not NULL_EGRESS_SINK — exactly one
    // new ledger row for THIS call, read back over the real `egress.list` IPC method, names the
    // service id. Filtered by method because the same destination also gets `sync.run` rows from
    // the user MCP's scheduler heartbeat (`createUserMcpSyncable`), which race with this call.
    const ledgerAfter = await ledgerRowsFor("mcp_echo_srv");
    const added = ledgerAfter.filter(
      (r) => r.method === "mcp_echo_srv.echo" && !ledgerBefore.some((b) => b.id === r.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ destination: "mcp_echo_srv", hitlStatus: "approved" });
  }, 60_000);

  // Without this, DENIED below would also appear if the probe could read NOTHING inside the
  // sandbox (path mangling, a hidden mount) — the denial must be the grant boundary, not that.
  test("in-sandbox positive control: the probe reads a file it IS granted", async () => {
    const out = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: "mcp_echo_srv",
      tool: "probe",
      input: { path: allowed },
    });
    const text = resultText(out);
    expect(text.startsWith("READ")).toBe(true);
    expect(text).toContain("ALLOWED-CONTENT");
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
    // Linux bwrap hides the directory (ENOENT); macOS and Windows refuse it (EPERM/EACCES).
    expect(text).toMatch(/EACCES|EPERM|ENOENT/);
  }, 60_000);

  // `nimbus connector call` documents exit 1 for a tool that returned an error. An MCP tool reports
  // that IN-BAND (`isError: true`), and the gateway's MCP client throws on it by default, so the
  // RPC fails carrying the tool's own text rather than answering `ok` — the CLI maps that to 1.
  test("a tool's in-band isError result fails the call with the tool's text", async () => {
    const err = await client
      .call<CallOutcome>("connector.userMcpCall", {
        serviceId: "mcp_echo_srv",
        tool: "fail",
        input: {},
      })
      .then(
        (v) => new Error(`resolved: ${JSON.stringify(v)}`),
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("resolved:");
    expect((err as Error).message).toContain("FAIL-MARKER");
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

  test("act door: propose -> capture.state proposed -> owner accept -> the user MCP got the exact input -> executed", async () => {
    const sub = await agent.call<{ id: string; state: string; expiresAt: number }>(
      "capture.submit",
      {
        kind: "action",
        payload: {
          actionType: "mcp_echo_srv.echo",
          input: { text: "from-the-agent" },
          summary: "say hi",
        },
        clientLabel: "e2e-agent",
      },
    );
    expect(sub.state).toBe("proposed");
    expect(await agent.call("capture.state", { id: sub.id })).toMatchObject({
      kind: "action",
      state: "proposed",
    });

    const before = prompts.length;
    const ledgerBefore = await ledgerRowsFor("mcp_echo_srv");
    approve = true;
    const out = await client.call<{ state: string }>("captures.accept", { id: sub.id });
    expect(out.state).toBe("executed");
    const shown = prompts.slice(before).join("\n");
    // Phase 28 AD1: the executor's own prompt, the verbatim input, then the UNVERIFIED proposer block.
    expect(shown).toContain("Requested by: an outside agent (unverified)");
    expect(shown).toContain('"text": "from-the-agent"');
    expect(shown).toContain('UNVERIFIED label "e2e-agent"');
    const added = (await ledgerRowsFor("mcp_echo_srv")).filter(
      (r) => r.method === "mcp_echo_srv.echo" && !ledgerBefore.some((b) => b.id === r.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ hitlStatus: "approved" });
    expect(await agent.call("capture.state", { id: sub.id })).toMatchObject({ state: "executed" });
    // What the executor actually dispatched: the agent's input verbatim, under the gateway-chosen
    // `<serviceId>_<tool>` key (the I42 pairing), in the gate's own approved audit row.
    const audit = await client.call<
      Array<{ actionType: string; hitlStatus: string; actionJson: string }>
    >("audit.list", { limit: 20 });
    const dispatched = audit.find(
      (r) => r.actionType === "mcp_echo_srv.echo" && r.actionJson.includes("from-the-agent"),
    );
    expect(dispatched?.hitlStatus).toBe("approved");
    const raw: unknown = JSON.parse(dispatched?.actionJson ?? "{}");
    const row = raw as { action: { proposer?: { captureId?: string } } };
    // Phase 28 AD1/AD4: the dispatch runs as an `origin: "agent"` action; the row names the door and the
    // proposer: the capture and the client's own (UNVERIFIED) label, never the agent's summary.
    expect(row.action.proposer?.captureId).toMatch(/^cap_[0-9a-f]{32}$/);
    expect(raw).toEqual({
      action: {
        type: "mcp_echo_srv.echo",
        proposer: {
          door: "agent",
          captureId: row.action.proposer?.captureId,
          label: "e2e-agent",
          labelSource: "declared",
        },
        origin: "agent",
        payload: { mcpToolId: "mcp_echo_srv_echo", input: { text: "from-the-agent" } },
      },
      // SA1: the test's owner client reports no answer source, so the row records `unknown`.
      answerSource: "unknown",
    });
  }, 60_000);

  // --- Agent door AD2: the owner's queue and the one-step approval, over the real wire ---

  /** Owner connections opened by the tests below; closed in `afterAll`. */
  const opened: TestIpcClient[] = [];

  /**
   * A connection that declares `kind` and answers every `consent.request` with `answerSource`
   * (`undefined` = an answer that reports no source, like the older owner client above).
   */
  async function openConnection(
    kind: "cli" | "mcp",
    answerSource: "human" | undefined,
  ): Promise<{ c: TestIpcClient; prompts: string[] }> {
    const c = new TestIpcClient();
    opened.push(c);
    await c.connect(paths.socketPath);
    expect(await c.call<{ kind: string }>("session.declareKind", { kind })).toEqual({ kind });
    const seen: string[] = [];
    c.onNotification("consent.request", (params) => {
      seen.push(String(params["prompt"] ?? ""));
      void c.call("consent.respond", {
        requestId: params["requestId"],
        approved: true,
        ...(answerSource === undefined ? {} : { answerSource }),
      });
    });
    return { c, prompts: seen };
  }

  async function propose(text: string, label: string): Promise<string> {
    const sub = await agent.call<{ id: string }>("capture.submit", {
      kind: "action",
      payload: { actionType: "mcp_echo_srv.echo", input: { text }, summary: "say it" },
      clientLabel: label,
    });
    return sub.id;
  }

  /** Settled with `.then` (see the "cannot accept its own proposal" test): the code in the refusal. */
  async function refusal(p: Promise<unknown>): Promise<string> {
    const e = await p.then(
      (v) => new Error(`resolved: ${JSON.stringify(v)}`),
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).not.toContain("resolved:");
    return (e as Error).message;
  }

  test("approvals: list, get and approve from a declared cli connection that answers as a human", async () => {
    const id = await propose("via-approvals", "e2e-queue-agent");
    const owner = await openConnection("cli", "human");
    const before = prompts.length;

    const list = await owner.c.call<{ proposals: Array<Record<string, unknown>> }>(
      "approvals.list",
      {},
    );
    const mine = list.proposals.find((p) => p["id"] === id);
    expect(mine).toMatchObject({
      actionType: "mcp_echo_srv.echo",
      label: "e2e-queue-agent",
      labelSource: "declared",
      wave: null,
      typedConfirm: false,
    });

    const got = await owner.c.call<{ inputLines: string[]; note: string }>("approvals.get", { id });
    expect(got.inputLines.join("\n")).toContain('"text": "via-approvals"');
    expect(got.note).toContain("appear when you approve");

    const out = await owner.c.call<{ id: string; state: string }>("approvals.approve", { id });
    expect(out).toMatchObject({ id, state: "executed" });
    // The prompt went to THIS connection, not to the older owner client.
    expect(owner.prompts).toHaveLength(1);
    expect(owner.prompts[0]).toContain("Requested by: an outside agent (unverified)");
    expect(owner.prompts[0]).toContain('"text": "via-approvals"');
    expect(prompts.length).toBe(before);

    const audit = await client.call<Array<{ actionType: string; actionJson: string }>>(
      "audit.list",
      { limit: 30 },
    );
    const row = audit.find(
      (r) => r.actionType === "mcp_echo_srv.echo" && r.actionJson.includes("via-approvals"),
    );
    expect(row).toBeDefined();
    expect((JSON.parse(row?.actionJson ?? "{}") as { answerSource?: string }).answerSource).toBe(
      "human",
    );
    expect(await agent.call("capture.state", { id })).toMatchObject({ state: "executed" });
  }, 60_000);

  test("approvals: an answer that reports no source is turned into a decline, and nothing runs", async () => {
    const id = await propose("must-not-run", "e2e-queue-agent");
    const owner = await openConnection("cli", undefined);
    const out = await owner.c.call<{ state: string; reason?: string }>("approvals.approve", {
      id,
    });
    expect(out.state).toBe("rejected");
    expect(out.reason).toContain("did not come from a person");
    expect(await agent.call("capture.state", { id })).toMatchObject({ state: "rejected" });
    const audit = await client.call<
      Array<{ actionType: string; hitlStatus: string; actionJson: string }>
    >("audit.list", { limit: 30 });
    const echo = audit.filter(
      (r) => r.actionType === "mcp_echo_srv.echo" && r.actionJson.includes("must-not-run"),
    );
    // The executor recorded the gateway's decline, never an approval.
    expect(echo.length).toBeGreaterThan(0);
    expect(echo.every((r) => r.hitlStatus === "rejected")).toBe(true);
  }, 60_000);

  test("approvals: the older owner client (undeclared) and a second mcp connection are refused; capture.state is the submitter's only", async () => {
    const id = await propose("private", "e2e-queue-agent");
    expect(await refusal(client.call("approvals.list", {}))).toMatch(
      /ERR_CAPTURE_FORBIDDEN_CLIENT/,
    );
    expect(await refusal(client.call("approvals.approve", { id }))).toMatch(
      /ERR_CAPTURE_FORBIDDEN_CLIENT/,
    );
    const other = await openConnection("mcp", undefined);
    expect(await refusal(other.c.call("approvals.list", {}))).toMatch(
      /ERR_CAPTURE_FORBIDDEN_CLIENT/,
    );
    // A third connection cannot read another connection's capture: the same answer as an absent id.
    expect(await refusal(other.c.call("capture.state", { id }))).toMatch(/ERR_CAPTURE_NOT_FOUND/);
    expect(await other.c.call<{ captures: unknown[] }>("capture.mine", {})).toEqual({
      captures: [],
    });
    expect(await agent.call("capture.state", { id })).toMatchObject({ state: "proposed" });
    // The owner (cli) can decline it.
    const owner = await openConnection("cli", "human");
    expect(await owner.c.call<{ id: string; state: string }>("approvals.decline", { id })).toEqual({
      id,
      state: "rejected",
    });
  }, 60_000);

  test("nimbus approvals <id> with no terminal exits 1 and sends nothing to the gateway", async () => {
    const id = await propose("no-tty", "e2e-queue-agent");
    // Point the CLI at THIS gateway through a throwaway data dir that holds only its state file.
    const home = mkdtempSync(join(tmpdir(), "nimbus-approvals-cli-"));
    try {
      const dirs = {
        APPDATA: join(home, "r"),
        LOCALAPPDATA: join(home, "l"),
        HOME: join(home, "h"),
        USERPROFILE: join(home, "h"),
        XDG_CONFIG_HOME: join(home, "c"),
        XDG_DATA_HOME: join(home, "d"),
        XDG_RUNTIME_DIR: join(home, "u"),
        TMPDIR: join(home, "t"),
        TEMP: join(home, "t"),
        TMP: join(home, "t"),
      };
      for (const d of new Set(Object.values(dirs))) mkdirSync(d, { recursive: true });
      const dataDir =
        process.platform === "win32"
          ? join(dirs.LOCALAPPDATA, "Nimbus", "data")
          : process.platform === "darwin"
            ? join(dirs.HOME, "Library", "Application Support", "Nimbus")
            : join(dirs.XDG_DATA_HOME, "nimbus");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "gateway.json"),
        JSON.stringify({ pid: proc?.pid ?? 0, socketPath: paths.socketPath }),
        "utf8",
      );
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...dirs };
      for (const k of [
        "NIMBUS_DEMO",
        "NIMBUS_CONFIG_DIR",
        "NIMBUS_GATEWAY_SOCKET",
        "NIMBUS_PROFILE",
      ])
        delete env[k];
      const p = Bun.spawn(["bun", CLI_ENTRY, "approvals", id], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain("requires an interactive terminal");
      // No approve reached the gateway: the proposal still waits.
      expect(await agent.call("capture.state", { id })).toMatchObject({ state: "proposed" });
      const owner = await openConnection("cli", "human");
      await owner.c.call("approvals.decline", { id });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("act door: the agent cannot accept its own proposal", async () => {
    const sub = await agent.call<{ id: string }>("capture.submit", {
      kind: "action",
      payload: { actionType: "mcp_echo_srv.echo", input: { text: "x" }, summary: "s" },
    });
    // Settled with `.then` (as the isError test above does), not `expect(p).rejects`: on Bun
    // 1.3.14/Windows the `.rejects` form never settled here (3 of 3 runs timed out at 30 s), while
    // the gateway had already answered with the refusal.
    const refused = await agent.call("captures.accept", { id: sub.id }).then(
      (v) => new Error(`resolved: ${JSON.stringify(v)}`),
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toContain("resolved:");
    expect((refused as Error).message).toMatch(/ERR_CAPTURE_FORBIDDEN_CLIENT/);
    await client.call("captures.reject", { id: sub.id });
  }, 30_000);

  test("act door: a first-party write whose connector is not configured is refused at submit", async () => {
    await expect(
      agent.call("capture.submit", {
        kind: "action",
        payload: {
          actionType: "slack.message.post",
          input: { channel: "C1", text: "x" },
          summary: "s",
        },
      }),
    ).rejects.toThrow(/ERR_CAPTURE_CONNECTOR_UNCONFIGURED/);
  }, 30_000);

  test("act door: a denied type is refused at submit", async () => {
    await expect(
      agent.call("capture.submit", {
        kind: "action",
        payload: { actionType: "github.pr.merge", input: {}, summary: "s" },
      }),
    ).rejects.toThrow(/ERR_CAPTURE_ACTION_NOT_PROPOSABLE/);
  }, 30_000);

  // --- Agent door AD5a: the owner approves a user MCP tool for agents by name; a person approves each call ---

  interface ListOnlyReply {
    listOnly: boolean;
    approved: number;
    writes: Array<{ toolId: string; sha12: string }>;
    tools?: Array<{ toolId: string; sha12: string; state: string }>;
  }
  interface AgentStatusReply {
    agent: {
      checked: boolean;
      services: Array<{
        service: string;
        userMcp?: boolean;
        approved: number;
        suspended: Array<{ toolId: string; approvedSha12: string; nowSha12: string | null }>;
      }>;
    };
  }
  const SERVICE = "mcp_echo_srv";
  /** The first 12 hex of the approved definition hash, as the enable printed it. */
  const approvedSha12: Record<string, string> = {};

  test("AD5a: a list-only enable from a declared cli connection shows each tool with a hash prefix and asks nothing", async () => {
    const owner = await openConnection("cli", "human");
    const out = await owner.c.call<ListOnlyReply>("connector.writesEnable", {
      service: SERVICE,
      door: "agent",
    });
    expect(out.listOnly).toBe(true);
    expect(out.approved).toBe(0);
    const names = (out.tools ?? []).map((t) => t.toolId);
    for (const n of ["echo", "probe", "fail", "mutable", "retitle"]) expect(names).toContain(n);
    for (const t of out.tools ?? []) {
      expect(t.sha12).toMatch(/^[0-9a-f]{12}$/);
      expect(t.state).toBe("will_be_approved");
    }
    expect(owner.prompts).toEqual([]);
    // The older, undeclared owner client cannot enable (no declared cli or ui kind).
    expect(
      await refusal(client.call("connector.writesEnable", { service: SERVICE, door: "agent" })),
    ).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
    // An mcp connection (the agent itself) cannot either.
    expect(
      await refusal(
        agent.call("connector.writesEnable", {
          service: SERVICE,
          door: "agent",
          approve: ["echo"],
        }),
      ),
    ).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
  }, 60_000);

  test("AD5a: an answer that is not a person's approves nothing", async () => {
    const owner = await openConnection("cli", undefined);
    const err = await refusal(
      owner.c.call("connector.writesEnable", {
        service: SERVICE,
        door: "agent",
        approve: ["echo"],
      }),
    );
    expect(err).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    const list = await owner.c.call<ListOnlyReply>("connector.writesEnable", {
      service: SERVICE,
      door: "agent",
    });
    expect((list.tools ?? []).every((t) => t.state === "will_be_approved")).toBe(true);
  }, 60_000);

  test("AD5a: the owner approves echo and mutable by exact name as a person", async () => {
    const owner = await openConnection("cli", "human");
    const out = await owner.c.call<ListOnlyReply>("connector.writesEnable", {
      service: SERVICE,
      door: "agent",
      approve: ["echo", "mutable"],
    });
    expect(out).toMatchObject({ listOnly: false, approved: 2 });
    for (const w of out.writes) approvedSha12[w.toolId] = w.sha12;
    expect(owner.prompts).toHaveLength(1);
    expect(owner.prompts[0]).toContain(SERVICE);
    expect(owner.prompts[0]).toContain(approvedSha12["echo"] as string);
    const status = await owner.c.call<AgentStatusReply>("connector.writesStatus", {});
    const mine = status.agent.services.find((s) => s.service === SERVICE);
    expect(mine).toMatchObject({ userMcp: true, approved: 2, suspended: [] });
  }, 60_000);

  test("AD5a: an agent proposes the approved echo, a person approves it, the prompt shows the server, and the audit row carries the definition hash after the proposer", async () => {
    const sub = await agent.call<{ id: string; state: string; legacy?: boolean }>(
      "capture.submit",
      {
        kind: "action",
        payload: {
          actionType: `${SERVICE}.echo`,
          input: { text: "ad5a-approved" },
          summary: "say it",
        },
        clientLabel: "e2e-ad5a",
      },
    );
    expect(sub.state).toBe("proposed");
    expect(sub).not.toHaveProperty("legacy");
    // The raw accept of an approved proposal is refused whoever asks.
    expect(await refusal(client.call("captures.accept", { id: sub.id }))).toContain(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    const owner = await openConnection("cli", "human");
    const out = await owner.c.call<{ id: string; state: string }>("approvals.approve", {
      id: sub.id,
    });
    expect(out.state).toBe("executed");
    expect(owner.prompts).toHaveLength(1);
    const shown = owner.prompts[0] as string;
    expect(shown).toContain(`User MCP server: ${SERVICE} (third-party code you registered on`);
    // The prompt prints each path escaped (a backslash is doubled), never raw.
    expect(shown).toContain(`read: ${JSON.stringify(grantedDir).slice(1, -1)}`);
    expect(shown).toContain("Tool description (the server's own text, UNVERIFIED):");
    expect(shown).toContain('"text": "ad5a-approved"');
    expect(shown).toContain("Requested by: an outside agent (unverified)");
    const audit = await client.call<
      Array<{ actionType: string; hitlStatus: string; actionJson: string }>
    >("audit.list", { limit: 60 });
    const row = audit.find(
      (r) => r.actionType === `${SERVICE}.echo` && r.actionJson.includes("ad5a-approved"),
    );
    expect(row?.hitlStatus).toBe("approved");
    const parsed = JSON.parse(row?.actionJson ?? "{}") as {
      action: Record<string, unknown> & { userMcp?: { definitionSha256: string } };
    };
    const keys = Object.keys(parsed.action);
    expect(keys.indexOf("userMcp")).toBeGreaterThan(keys.indexOf("proposer"));
    expect(Object.keys(parsed.action.userMcp ?? {})).toEqual(["definitionSha256"]);
    expect(parsed.action.userMcp?.definitionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      parsed.action.userMcp?.definitionSha256.startsWith(approvedSha12["echo"] as string),
    ).toBe(true);
  }, 60_000);

  test("AD5a: a tool the live server re-lists with a changed description is refused as suspended, and a queued proposal fails at approval", async () => {
    const queued = await agent.call<{ id: string }>("capture.submit", {
      kind: "action",
      payload: {
        actionType: `${SERVICE}.mutable`,
        input: { text: "queued-before-change" },
        summary: "s",
      },
      clientLabel: "e2e-ad5a",
    });
    // The owner (the older client, which auto-approves) calls the server's own `retitle` tool: the
    // LIVE server now lists another description for `mutable`.
    const retitled = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: SERVICE,
      tool: "retitle",
      input: { description: "mutable v2 (changed)" },
    });
    expect(resultText(retitled)).toContain("RETITLED");

    // A second listing of the live server asks the server again: the new description is seen.
    expect(
      await refusal(
        agent.call("capture.submit", {
          kind: "action",
          payload: { actionType: `${SERVICE}.mutable`, input: { text: "x" }, summary: "s" },
          clientLabel: "e2e-ad5a",
        }),
      ),
    ).toContain("ERR_AGENT_TOOL_SUSPENDED");

    const owner = await openConnection("cli", "human");
    expect(await refusal(owner.c.call("approvals.approve", { id: queued.id }))).toContain(
      "ERR_AGENT_TOOL_SUSPENDED",
    );
    expect(owner.prompts).toEqual([]);

    const status = await owner.c.call<AgentStatusReply>("connector.writesStatus", {});
    const mine = status.agent.services.find((s) => s.service === SERVICE);
    expect(mine?.approved).toBe(1);
    expect(mine?.suspended.map((t) => t.toolId)).toEqual(["mutable"]);
    expect(mine?.suspended[0]?.approvedSha12).toBe(approvedSha12["mutable"] as string);
    expect(mine?.suspended[0]?.nowSha12).not.toBeNull();

    // Exactly one suspension audit row, however many checks saw the change.
    const audit = await client.call<Array<{ actionType: string }>>("audit.list", { limit: 200 });
    expect(audit.filter((r) => r.actionType === "connector.writes.agent.suspend")).toHaveLength(1);

    // Only a re-approval by name clears it.
    const again = await owner.c.call<ListOnlyReply>("connector.writesEnable", {
      service: SERVICE,
      door: "agent",
      approve: ["mutable"],
    });
    expect(again.approved).toBe(1);
    const ok = await agent.call<{ id: string; state: string }>("capture.submit", {
      kind: "action",
      payload: { actionType: `${SERVICE}.mutable`, input: { text: "after" }, summary: "s" },
      clientLabel: "e2e-ad5a",
    });
    expect(ok.state).toBe("proposed");
    await owner.c.call("approvals.decline", { id: ok.id });
  }, 120_000);

  test("AD5a: describe_actions returns the approved tool's sanitised description and nothing for the others", async () => {
    const out = await agent.call<{
      actions: Array<{ actionType: string; state: string; description?: string }>;
    }>("capture.describe", {
      actionTypes: [`${SERVICE}.echo`, `${SERVICE}.probe`],
    });
    const echo = out.actions.find((a) => a.actionType === `${SERVICE}.echo`);
    expect(echo?.state).toBe("approved");
    expect(echo?.description).toContain(`owner-registered user MCP server ${SERVICE}`);
    const probe = out.actions.find((a) => a.actionType === `${SERVICE}.probe`);
    expect(probe?.state).not.toBe("approved");
    expect(probe).not.toHaveProperty("description");
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

  test("AD5a: the removal deleted the agent approvals, and the same id registered again starts with none", async () => {
    const owner = await openConnection("cli", "human");
    const gone = await owner.c.call<AgentStatusReply>("connector.writesStatus", {});
    expect(gone.agent.services.find((s) => s.service === SERVICE)).toBeUndefined();

    const back = await client.call<{ ok?: boolean }>("connector.addMcp", {
      serviceId: SERVICE,
      argv: [binary],
      readPaths: [grantedDir],
      modelAccess: false,
    });
    expect(back.ok).toBe(true);
    const out = await owner.c.call<ListOnlyReply>("connector.writesEnable", {
      service: SERVICE,
      door: "agent",
    });
    expect((out.tools ?? []).map((t) => t.state)).not.toContain("already_approved");
    expect((out.tools ?? []).every((t) => t.state === "will_be_approved")).toBe(true);
    // Registered without --model and approved for nothing: the proposal is refused as before.
    expect(
      await refusal(
        agent.call("capture.submit", {
          kind: "action",
          payload: { actionType: `${SERVICE}.echo`, input: { text: "x" }, summary: "s" },
          clientLabel: "e2e-ad5a",
        }),
      ),
    ).toContain("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  }, 120_000);
});
