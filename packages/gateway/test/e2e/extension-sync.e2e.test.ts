// Extension sync end-to-end (Readwise unbundling pilot, PR 3): an installed extension that declares
// a `sync` block, approved to run and given its credential, syncs INTO THE INDEX through a REAL
// gateway subprocess, over a REAL socket / named pipe, with the extension spawned under this OS's
// REAL sandbox. Every other test for the sync host drives the registrar, the syncable or the
// scheduler directly; only this one proves the whole path — install (HITL), approve (HITL; the
// registrar registers the extension's sync), set the credential (HITL), `connector.sync` -> one
// scheduler run -> two `__nimbus_sync` pages -> two items in the index -> exactly ONE `sync.run`
// egress row (I29), and that the credential REACHES THE CONFINED CHILD through its env (I1): the
// fixture never echoes the secret, it returns a SHA-256 prefix of the variable it was spawned with,
// and the test compares that against the prefix of the value it set.
//
// The pages are produced INSIDE the extension, so no loopback fake is needed and the manifest
// declares no network at all: the Linux and Windows sandboxes would otherwise need the network
// helper (or forbid loopback outright) for what is not under test here. The extension's own
// requests to its granted hosts are not ledgered by Nimbus anyway (I43); only the run row is.
//
// The fixture is built the way `extension-runtime.e2e.test.ts` builds its own: the `nimbus scaffold
// mcp` output with its entry replaced, BUNDLED with `bun build --target=bun` into one file (the
// install refuses symlinks, so the scaffold's linked `node_modules` cannot ship inside it).
// It is installed from a local directory: the continuity table is empty in production until PR 7,
// so a registry-sourced install binds no differently here, and the extension indexes under its
// own `ext_` id.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); search runs keyword-only.
//
// ONE ORDERED LIFECYCLE, deliberately not split into independent files: install + approve (in
// beforeAll) -> sync without a credential -> set the credential and sync -> restart -> remove. The
// steps share one OS vault key (the credential set in step 3 is what the post-restart sync spawns
// with) and one extension id, and the restart step exists to prove persisted state survives a
// gateway restart. Each step asserts its own delta (rows/items before vs after); only the restart
// and removal steps assert on accumulated state, and say so where they do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";
import { rmDirWithRetry } from "../helpers/rm-dir-with-retry.ts";

// --- TestIpcClient + until: the same shape as extension-runtime.e2e.test.ts ---

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

// --- end shared section ---

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const IS_CI = process.env["CI"] === "true";

const EXTENSION_ID = "e2e.sync";
const SERVICE_ID = "ext_e2e_sync";
/** A per-run value, so a marker can only match if THIS value reached the child. */
const TOKEN = `e2e-sync-token-${randomUUID()}`;
const TOKEN_MARKER = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);

function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}

const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/**
 * Self-validating, not a blanket platform skip: the precondition is asked of THIS machine's real
 * sandbox (`canConfine` over a no-network policy — the shape the fixture spawns with). Where it
 * holds — every CI leg, on all three OSes — the suite runs; on CI a machine where it does not hold
 * FAILS by name below rather than reading as a pass. Only a dev box without the helper skips.
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
        id: "extension-sync-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
})();

/** As in extension-runtime.e2e: the wrapper resolves the helper beside `process.execPath`. */
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

describe.skipIf(sandboxAvailable || !IS_CI)("extension sync e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined sync", () => {
    expect(
      "extension-sync-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
        "no-network policy, so the extension cannot be spawned for sync. Install this platform's " +
        "sandbox dependency (scripts/linux/install-sandbox-deps.sh on Linux, " +
        "build:sandbox-helper:win32 on Windows).",
    ).toBeNull();
  });
});

/**
 * The fixture's entry: the scaffold's server plus the reserved `__nimbus_sync` tool. Page 1 (no
 * cursor) and page 2 (cursor "p2") each return one item whose title carries a digest of the
 * credential env var — never the value. A cursor past page 2 returns an empty, final page.
 */
const ENTRY_TS = `import { createHash } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

const marker = createHash("sha256")
  .update(process.env.E2E_SYNC_TOKEN ?? "<unset>")
  .digest("hex")
  .slice(0, 16);

function item(n: number) {
  return {
    type: "note",
    externalId: "n" + n,
    title: "e2e-sync-page-" + n + "-" + marker,
    modifiedAt: Date.now(),
    metadata: { page: n },
  };
}

const server = createServer();
server.registerTool(
  "__nimbus_sync",
  {
    description: "sync v1",
    inputSchema: {
      cursor: z.string().nullable(),
      depth: z.string(),
      historyFloorMs: z.number().optional(),
    },
  },
  async ({ cursor }) => {
    const page =
      cursor === null
        ? { status: "ok", items: [item(1)], cursor: "p2", hasMore: true }
        : cursor === "p2"
          ? { status: "ok", items: [item(2)], cursor: "done", hasMore: false }
          : { status: "ok", items: [], cursor: "done", hasMore: false };
    return { content: [{ type: "text", text: JSON.stringify(page) }] };
  },
);
await server.connect(new StdioServerTransport());
`;

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

describe.skipIf(!sandboxAvailable)("an approved extension syncs into the index", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-extsync-e2e-"));
  const scaffoldRoot = join(tmp, "scaffold");
  const project = join(scaffoldRoot, "sync_ext");
  const pkg = join(tmp, "pkg");
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nimbus-extsync-${process.pid}-${randomUUID().slice(0, 8)}`
        : join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  let restoreHelper: () => void = () => {};
  let client = new TestIpcClient();

  async function bootGateway(): Promise<void> {
    gatewayLog = "";
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
    client = new TestIpcClient();
    await client.connect(paths.socketPath);
    client.onNotification("consent.request", (params) => {
      void client.call("consent.respond", { requestId: params["requestId"], approved: true });
    });
  }

  async function stopGateway(): Promise<void> {
    client.clearNotificationHandlers();
    client.close();
    proc?.kill();
    await proc?.exited.catch(() => {});
    proc = undefined;
  }

  type LedgerRow = { id: number; destination: string; method: string };
  async function syncRows(): Promise<LedgerRow[]> {
    const out = await client.call<{ rows: LedgerRow[] }>("egress.list", { limit: 10_000 });
    return out.rows.filter((r) => r.destination === SERVICE_ID && r.method === "sync.run");
  }

  async function itemTitles(): Promise<string[]> {
    const items = await client.call<Array<{ name?: unknown; title?: unknown }>>(
      "index.searchRanked",
      { service: SERVICE_ID, semantic: false, limit: 50 },
    );
    return items.map((i) => String(i.name ?? i.title ?? "")).sort((a, b) => a.localeCompare(b));
  }

  async function forceSync(): Promise<void> {
    try {
      await client.call("connector.sync", { serviceId: SERVICE_ID });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-8000)}`,
      );
    }
  }

  beforeAll(async () => {
    mkdirSync(scaffoldRoot, { recursive: true });
    const scaffold = await run(["bun", CLI_ENTRY, "scaffold", "mcp", "sync_ext"], scaffoldRoot);
    if (scaffold.code !== 0) {
      throw new Error(`scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`);
    }
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
    writeFileSync(join(project, "src", "index.ts"), ENTRY_TS, "utf8");
    const build = await run(
      ["bun", "build", "src/index.ts", "--target=bun", "--outfile", join(pkg, "dist", "index.js")],
      project,
    );
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }
    writeFileSync(
      join(pkg, "nimbus.extension.json"),
      JSON.stringify(
        {
          id: EXTENSION_ID,
          version: "1.0.0",
          entry: "dist/index.js",
          permissions: { network: [], filesystem: { read: [], write: [] } },
          credentials: { token: { env: "E2E_SYNC_TOKEN" } },
          sync: { contract: "1", intervalSeconds: 3600, itemTypes: ["note"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    restoreHelper = installDefaultHelper();
    for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
    await bootGateway();
    // Setup, not a test: a failure here names the install/approve, not a later step.
    await client.call("extension.install", { sourcePath: pkg });
    const approved = await client.call<{ serviceId: string }>("extension.approveRun", {
      id: EXTENSION_ID,
    });
    expect(approved.serviceId).toBe(SERVICE_ID);
  }, 180_000);

  afterAll(async () => {
    await stopGateway();
    restoreHelper();
    // Bun's rmSync ignores maxRetries, so a bare try/catch leaked the dir on a Windows handle race.
    rmDirWithRetry(tmp);
  });

  test("with no credential set, a forced sync indexes nothing and appends no sync.run row", async () => {
    // Observable outcomes only (no items, no egress row), never "a child was spawned": an
    // approved extension with a blank credential may be spawned and find nothing, or be skipped
    // as unconfigured; both leave the same index and ledger.
    const rowsBefore = (await syncRows()).length;
    await forceSync();
    expect(await itemTitles()).toEqual([]);
    expect((await syncRows()).length - rowsBefore).toBe(0);
  }, 60_000);

  test("with the credential set, one sync writes both pages under ONE sync.run row", async () => {
    const rowsBefore = (await syncRows()).length;
    await client.call("extension.credentialSet", { id: EXTENSION_ID, name: "token", value: TOKEN });
    await forceSync();
    // The marker can only be this value's digest if the token reached the CONFINED child's env.
    expect(await itemTitles()).toEqual([
      `e2e-sync-page-1-${TOKEN_MARKER}`,
      `e2e-sync-page-2-${TOKEN_MARKER}`,
    ]);
    expect((await syncRows()).length - rowsBefore).toBe(1);
    expect(gatewayLog).not.toContain(TOKEN);
  }, 120_000);

  test("after a restart the boot pass registers it again (behind the integrity gate)", async () => {
    // The restart's claim is about ACCUMULATED state: what the previous gateway indexed and
    // ledgered must still be there, so these two are compared across the restart, not per step.
    const titlesBefore = await itemTitles();
    const rowsBefore = (await syncRows()).length;
    expect(titlesBefore).toHaveLength(2);
    expect(rowsBefore).toBeGreaterThan(0);

    await stopGateway();
    await bootGateway();
    expect(await itemTitles()).toEqual(titlesBefore);
    expect(await syncRows()).toHaveLength(rowsBefore);

    // An unregistered id rejects `connector.sync` with "Unknown service"; this resolves only if
    // the boot pass registered it. The sync itself is a per-step delta: exactly one new row.
    await forceSync();
    expect((await syncRows()).length - rowsBefore).toBe(1);
    expect(await itemTitles()).toEqual(titlesBefore);
  }, 120_000);

  test("connector remove refuses the extension-backed id; extension remove purges it", async () => {
    const titlesBefore = await itemTitles();
    expect(titlesBefore.length).toBeGreaterThan(0);
    const refusal = await client.call("connector.remove", { serviceId: SERVICE_ID }).then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(refusal).toContain("ERR_CONNECTOR_IS_EXTENSION");
    expect(await itemTitles()).toEqual(titlesBefore);

    await client.call("extension.remove", { id: EXTENSION_ID });
    expect(await itemTitles()).toEqual([]);
    const status = await client.call<unknown[]>("connector.listStatus", { serviceId: SERVICE_ID });
    expect(status).toEqual([]);
  }, 60_000);
});
