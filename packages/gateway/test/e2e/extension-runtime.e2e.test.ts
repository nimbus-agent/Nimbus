// Extension runtime end-to-end: an installed extension with an owner-approved run grant runs as a
// sandboxed MCP stdio server (the `__nimbus-extension` self-role) behind a REAL gateway subprocess,
// over a REAL socket / named pipe, under this OS's REAL sandbox. Every other test for the runtime
// drives the mesh or the handlers directly; only this one proves the whole path — install
// (`extension.install`, HITL), approve (`extension.approveRun`, HITL), list and call
// (`connector.userMcpTools` / `connector.userMcpCall`, each call HITL), and that the spawned child
// is CONFINED (a probe outside every grant is DENIED, after a positive control), that a changed
// sibling module is refused at the next spawn, and that disable/remove really end the child.
//
// The fixture is the `nimbus scaffold mcp` output plus a `probe` tool, BUNDLED with `bun build
// --target=bun` into one `dist/index.js` that loads `./chunk.js` at run time: the install refuses a
// symlink or junction anywhere in the tree, so the junctioned `node_modules` user-mcp.e2e uses
// cannot ship inside an extension, and a bundle needs no `node_modules` at all. `dist/chunk.js` is
// a separately imported sibling, so editing it changes the tree digest without touching the entry.
//
// The `echo` tool reports its own `process.pid`, so "the child is gone" is checked against the OS,
// not against the gateway's own bookkeeping. No network: the manifest declares none.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { sandboxCwdFor } from "../../src/platform/sandbox/sandbox-cwd.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";

// --- TestIpcClient + until copied verbatim from user-mcp.e2e.test.ts ---

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

const EXTENSION_ID = "e2e.echo";
const SERVICE_ID = "ext_e2e_echo";

/** The nearest `node_modules/<pkg>` at or above `from` (see user-mcp.e2e.test.ts). */
function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}

/** The helper CI (and `bun run build:sandbox-helper:win32`) builds in this checkout. */
const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/** Whether this platform's sandbox can confine a no-network policy here (see user-mcp.e2e). */
const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "extension-runtime-e2e-probe",
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
 * The extension is spawned through `wrapServerSpec`'s `__nimbus-sandbox` re-exec, whose env (I1)
 * never carries `NIMBUS_SANDBOX_HELPER_PATH`, so the wrapper resolves the helper next to
 * `process.execPath`. As in user-mcp.e2e, the checkout's helper is copied there for this file's
 * lifetime only, and removed afterwards only if this file put it there.
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
describe.skipIf(sandboxAvailable || !IS_CI)(
  "extension runtime e2e — CI sandbox precondition",
  () => {
    test("fails loudly instead of silently skipping the confined spawn", () => {
      expect(
        "extension-runtime-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
          "no-network policy, so the extension cannot be spawned. Install this platform's sandbox " +
          "dependency (scripts/linux/install-sandbox-deps.sh on Linux, build:sandbox-helper:win32 " +
          "on Windows).",
      ).toBeNull();
    });
  },
);

/**
 * The extension's entry source: the scaffold's server plus a `probe` tool, importing one sibling
 * module (`./chunk.js`) that the bundle leaves a separate run-time import. The probe reports the outcome rather than
 * throwing, so a DENIED arrives as a normal tool result.
 */
const ENTRY_TS = `import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

// A non-literal specifier, so the bundler leaves the sibling a separate module loaded at run time.
const { CHUNK_MARKER } = (await import(new URL("./chunk.js", import.meta.url).href)) as {
  CHUNK_MARKER: string;
};

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
  "chunk",
  { description: "Report the sibling module's marker", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: CHUNK_MARKER }] }),
);
await server.connect(new StdioServerTransport());
`;

const CHUNK_JS = 'export const CHUNK_MARKER = "chunk-v1";\n';

/** The scaffold's echo handler, and the same handler also reporting the server's own pid. */
const SCAFFOLD_ECHO = 'async ({ text }) => ({ content: [{ type: "text", text }] }),';
const PID_ECHO =
  'async ({ text }) => ({ content: [{ type: "text", text }, { type: "text", text: "PID " + process.pid }, { type: "text", text: "ENTRY " + import.meta.path }] }),';

type CallOutcome = { status: "ok"; result: unknown } | { status: "rejected"; reason: string };

/** The text parts of an MCP `CallToolResult`, in order. */
function resultTexts(outcome: CallOutcome): string[] {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  const r = outcome.result;
  if (typeof r === "object" && r !== null && "content" in r && Array.isArray(r.content)) {
    const parts: unknown[] = r.content;
    return parts.flatMap((p) =>
      typeof p === "object" && p !== null && "text" in p && typeof p.text === "string"
        ? [p.text]
        : [],
    );
  }
  return [JSON.stringify(r)];
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls for up to `ms`, since a child's teardown can finish just after the RPC reply. */
async function eventually(check: () => boolean, ms = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Settles a call that is expected to fail, returning its message (never `expect().rejects`). */
async function failureOf(p: Promise<unknown>): Promise<string> {
  const settled = await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(settled).toBeInstanceOf(Error);
  const message = (settled as Error).message;
  expect(message).not.toContain("resolved:");
  return message;
}

/** `realpathSync`, or the path unchanged when it cannot be resolved (missing, or empty). */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

describe.skipIf(!sandboxAvailable)("an approved extension over a real gateway", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-extrt-e2e-"));
  const scaffoldRoot = join(tmp, "scaffold");
  const project = join(scaffoldRoot, "echo_ext");
  /** The extension package the owner installs (copied by the install into extensionsDir). */
  const pkg = join(tmp, "pkg");
  const sentinel = join(tmp, "outside", "secret.txt");
  /** Granted to the extension by its manifest: the IN-SANDBOX positive control for the probe. */
  const grantedDir = join(tmp, "granted");
  const allowed = join(grantedDir, "allowed.txt");
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nimbus-extrt-${process.pid}-${randomUUID().slice(0, 8)}`
        : join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  // Computed the way the runtime computes it: the sandbox policy id is `ext.<serviceId>`.
  const leaf = sandboxCwdFor(paths.sandboxDir, `ext.${SERVICE_ID}`);
  let installedChunk = "";
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  let restoreHelper: () => void = () => {};
  const client = new TestIpcClient();

  /** Every consent prompt the gateway raised, in order; and whether the next one is approved. */
  const prompts: string[] = [];
  let approve = true;

  type LedgerRow = { id: number; destination: string; hitlStatus: string; method: string };
  async function ledgerRows(): Promise<LedgerRow[]> {
    const out = await client.call<{ rows: LedgerRow[] }>("egress.list", { limit: 10_000 });
    return out.rows.filter((r) => r.destination === SERVICE_ID);
  }

  type ExtensionListing = { id: string; runState: string; enabled: number };
  async function runState(): Promise<string | undefined> {
    const out = await client.call<{ extensions: ExtensionListing[] }>("extension.list", {});
    return out.extensions.find((e) => e.id === EXTENSION_ID)?.runState;
  }

  async function listTools(): Promise<string[]> {
    const out = await client.call<{ serviceId: string; tools: Array<{ name: string }> }>(
      "connector.userMcpTools",
      { serviceId: SERVICE_ID },
    );
    expect(out.serviceId).toBe(SERVICE_ID);
    const names = out.tools.map((t) => t.name);
    if (names.length === 0) {
      // A server that failed to start lists nothing; the reason is only in the gateway's output.
      throw new Error(`no tools listed\n--- gateway output (tail) ---\n${gatewayLog.slice(-8000)}`);
    }
    return names;
  }

  /** One approved call, asserting it appended exactly one ledger row of its own. */
  async function executedCall(tool: string, input: Record<string, unknown>): Promise<string[]> {
    const before = await ledgerRows();
    const out = await client.call<CallOutcome>("connector.userMcpCall", {
      serviceId: SERVICE_ID,
      tool,
      input,
    });
    const texts = resultTexts(out);
    const added = (await ledgerRows()).filter(
      (r) => r.method === `${SERVICE_ID}.${tool}` && !before.some((b) => b.id === r.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ destination: SERVICE_ID, hitlStatus: "approved" });
    return texts;
  }

  async function echoPid(): Promise<number> {
    const texts = await executedCall("echo", { text: "pid please" });
    const pidLine = texts.find((t) => t.startsWith("PID "));
    const pid = Number(pidLine?.slice(4));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    return pid;
  }

  beforeAll(async () => {
    // 1. Scaffold through the real CLI, and make its echo report the server's own pid.
    mkdirSync(scaffoldRoot, { recursive: true });
    const scaffold = await run(["bun", CLI_ENTRY, "scaffold", "mcp", "echo_ext"], scaffoldRoot);
    if (scaffold.code !== 0) {
      throw new Error(`scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`);
    }
    const serverTs = join(project, "src", "server.ts");
    const scaffolded = readFileSync(serverTs, "utf8");
    if (!scaffolded.includes(SCAFFOLD_ECHO)) {
      throw new Error(`the scaffold's echo handler changed shape:\n${scaffolded}`);
    }
    writeFileSync(serverTs, scaffolded.replace(SCAFFOLD_ECHO, PID_ECHO), "utf8");

    // 2. Link the two dependencies for the BUILD only (the bundle carries them; the installed
    //    package has no node_modules, so the install's symlink refusal never sees these).
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

    // 3. Bundle the entry; the sibling module stays a separate file loaded at run time.
    writeFileSync(join(project, "src", "index.ts"), ENTRY_TS, "utf8");
    const build = await run(
      ["bun", "build", "src/index.ts", "--target=bun", "--outfile", join(pkg, "dist", "index.js")],
      project,
    );
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }
    const bundled = readFileSync(join(pkg, "dist", "index.js"), "utf8");
    // The edit below only means something if the entry really imports the sibling at run time.
    expect(bundled).toContain("./chunk.js");
    writeFileSync(join(pkg, "dist", "chunk.js"), CHUNK_JS, "utf8");

    // 4. The grants: one read of a temp dir; no network, no write.
    mkdirSync(grantedDir, { recursive: true });
    writeFileSync(allowed, "ALLOWED-CONTENT", "utf8");
    mkdirSync(join(tmp, "outside"), { recursive: true });
    writeFileSync(sentinel, "TOP-SECRET", "utf8");
    writeFileSync(
      join(pkg, "nimbus.extension.json"),
      JSON.stringify(
        {
          id: EXTENSION_ID,
          version: "1.0.0",
          entry: "dist/index.js",
          permissions: { network: [], filesystem: { read: [grantedDir], write: [] } },
        },
        null,
        2,
      ),
      "utf8",
    );

    // 5. Boot the gateway. `[extensions] runtime` defaults to on; no config needed.
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

  test("extension.install installs the package behind the owner's approval", async () => {
    const before = prompts.length;
    await client.call("extension.install", { sourcePath: pkg });
    expect(prompts.length).toBeGreaterThan(before);
    installedChunk = join(paths.extensionsDir, EXTENSION_ID, "dist", "chunk.js");
    expect(readFileSync(installedChunk, "utf8")).toBe(CHUNK_JS);
    expect(await runState()).toBe("no_grant");
  }, 60_000);

  test("extension.approveRun grants it a service id; it is ready, not yet running", async () => {
    const out = await client.call<{ serviceId: string }>("extension.approveRun", {
      id: EXTENSION_ID,
    });
    expect(out.serviceId).toBe(SERVICE_ID);
    expect(await runState()).toBe("ready");
  }, 60_000);

  test("connector.userMcpTools spawns it and lists its tools; it is now running", async () => {
    const names = await listTools();
    expect(names).toContain("echo");
    expect(names).toContain("probe");
    expect(await runState()).toBe("running");
  }, 60_000);

  test("an approved echo call answers, and its prompt named the tool", async () => {
    const before = prompts.length;
    const texts = await executedCall("echo", { text: "hello" });
    expect(texts[0]).toBe("hello");
    expect(prompts.slice(before).some((p) => p.includes(`${SERVICE_ID}.echo`))).toBe(true);
  }, 60_000);

  test("the sibling module is really imported at run time", async () => {
    expect(await executedCall("chunk", {})).toEqual(["chunk-v1"]);
  }, 60_000);

  test("a denied consent leaves the call rejected", async () => {
    approve = false;
    try {
      const out = await client.call<CallOutcome>("connector.userMcpCall", {
        serviceId: SERVICE_ID,
        tool: "echo",
        input: { text: "again" },
      });
      expect(out.status).toBe("rejected");
    } finally {
      approve = true;
    }
  }, 60_000);

  // Without this, DENIED below would also appear if the probe could read NOTHING in the sandbox.
  test("in-sandbox positive control: the probe reads its granted directory", async () => {
    const texts = await executedCall("probe", { path: allowed });
    expect(texts[0]?.startsWith("READ")).toBe(true);
    expect(texts[0]).toContain("ALLOWED-CONTENT");
  }, 60_000);

  test("the code runs from a run-<uuid> stage in its own leaf, never from the install tree", async () => {
    const texts = await executedCall("echo", { text: "where" });
    const entry = texts.find((t) => t.startsWith("ENTRY "))?.slice("ENTRY ".length) ?? "";
    // Bun realpaths `import.meta.path`; `leaf` comes from an unresolved `tmpdir()` (macOS
    // `/var` -> `/private/var`), so both sides are resolved before they are compared.
    const rel = relative(realpathOrSelf(leaf), realpathOrSelf(entry));
    const parts = rel.split(sep);
    expect(parts[0] ?? "").toMatch(/^run-[0-9a-f-]{36}$/);
    expect(parts.slice(1)).toEqual(["dist", "index.js"]);
  }, 60_000);

  test("the install tree is NOT granted: its manifest is denied in the sandbox", async () => {
    const installedManifest = join(paths.extensionsDir, EXTENSION_ID, "nimbus.extension.json");
    // Positive control: it exists and the test process can read it.
    expect(readFileSync(installedManifest, "utf8")).toContain(EXTENSION_ID);
    const texts = await executedCall("probe", { path: installedManifest });
    expect(texts[0]?.startsWith("DENIED")).toBe(true);
    expect(texts[0]).toMatch(/EACCES|EPERM|ENOENT/);
  }, 60_000);

  test("the extension is CONFINED: a read outside its grants is denied", async () => {
    const texts = await executedCall("probe", { path: sentinel });
    expect(texts[0]).not.toContain("TOP-SECRET");
    expect(texts[0]?.startsWith("DENIED")).toBe(true);
    // Linux bwrap hides the directory (ENOENT); macOS and Windows refuse it (EPERM/EACCES).
    expect(texts[0]).toMatch(/EACCES|EPERM|ENOENT/);
  }, 60_000);

  test("changed code: disable ends the child, and the next spawn refuses the changed tree", async () => {
    const pid = await echoPid();
    expect(pidAlive(pid)).toBe(true);
    // Edit the sibling while the client is live: a connected client never re-spawns, so the
    // refusal can only show at the NEXT spawn — forced by disable + enable, not by revoke.
    writeFileSync(installedChunk, 'export const CHUNK_MARKER = "chunk-v2";\n', "utf8");

    expect(await client.call<{ ok: boolean }>("extension.disable", { id: EXTENSION_ID })).toEqual({
      ok: true,
    });
    expect(await runState()).toBe("disabled");
    expect(await eventually(() => !pidAlive(pid))).toBe(true);

    expect(await client.call<{ ok: boolean }>("extension.enable", { id: EXTENSION_ID })).toEqual({
      ok: true,
    });
    const message = await failureOf(
      client.call("connector.userMcpTools", { serviceId: SERVICE_ID }),
    );
    expect(message).toContain('"code":-32602');
    expect(message).toContain("ERR_EXTENSION_RUN_TREE_CHANGED");
  }, 60_000);

  test("revokeRun withdraws it: the service id is no longer registered", async () => {
    await client.call("extension.revokeRun", { id: EXTENSION_ID });
    const message = await failureOf(
      client.call("connector.userMcpTools", { serviceId: SERVICE_ID }),
    );
    expect(message).toContain("ERR_USER_MCP_NOT_REGISTERED");
    expect(await runState()).toBe("no_grant");
  }, 60_000);

  test("remove of a re-approved, running extension ends the child and deletes its leaf", async () => {
    // Put the approved bytes back, so the re-approval is over the code that was installed.
    writeFileSync(installedChunk, CHUNK_JS, "utf8");
    const out = await client.call<{ serviceId: string }>("extension.approveRun", {
      id: EXTENSION_ID,
    });
    expect(out.serviceId).toBe(SERVICE_ID);
    await listTools();
    expect(await runState()).toBe("running");
    const pid = await echoPid();
    expect(pidAlive(pid)).toBe(true);
    expect(existsSync(leaf)).toBe(true);

    expect(await client.call<{ ok: boolean }>("extension.remove", { id: EXTENSION_ID })).toEqual({
      ok: true,
    });
    expect(await eventually(() => !pidAlive(pid))).toBe(true);
    expect(await eventually(() => !existsSync(leaf))).toBe(true);
    expect(await runState()).toBeUndefined();
  }, 60_000);
});
