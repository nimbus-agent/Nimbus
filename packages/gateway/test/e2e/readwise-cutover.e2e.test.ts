// The Readwise cutover end-to-end (Readwise unbundling, PR 7 Task 7.5; rulings B3/B34, R-E2E): the
// REAL legacy id `readwise`, now that the bundled connector is gone, through a REAL gateway
// subprocess over a REAL socket / named pipe. `migration.e2e.test.ts` proves the same machinery on
// a synthetic legacy id (`fixturewise`) because, until Task 7.2, `readwise` was bundled and the
// engine skips a bundled id by design. Only the real id proves what a real user goes through:
// `connector.sync readwise` (a catalog id), catalog-id configured-ness in `connector.status`, and
// the `readwise.token` legacy Vault key.
//
// Each describe boots ITS OWN gateway over its own temp dirs (one gateway is never shared across
// describes):
//   (a) upgrade in place — bundled-style `readwise` items, `readwise.token` and the resting cursor
//       migrate to the extension; one forced `connector.sync readwise` updates them in place;
//   (b) fresh install — a bare `registry.install com.nimbus.readwise` from the built-in registry binds
//       to `readwise`; its credential lands at `readwise.token`;
//   (c) no token — legacy items but no `readwise.token`: no migration row, no registry request;
//   (d) offline (spec § 9.3) — the built-in registry is unreachable: the migration fails and
//       `connector.status readwise` carries the paused reason.
//
// The extension is SYNTHETIC (ruling R-E2E): id `com.nimbus.readwise`, signed by the TEST publisher
// key in a fixture built-in registry signed by the TEST root key, bound to `readwise` by a fixture
// continuity entry (test key + test root fingerprint). Both reach the gateway as composition options
// through the runner's NIMBUS_E2E_MIGRATION_FIXTURE_JSON (ruling B1), so the baked official entry and
// URL are never used: nothing here reaches github.io or readwise.io. The npm package's own
// Readwise sources are not bundled; that contract is covered in nimbus-mcp-servers.
//
// Unlike `migration.e2e`, the fixture registry is served over loopback HTTP by this test process
// (the gateway itself is not sandboxed, so loopback works on every OS). A local-folder registry makes
// no request and appends no `registry` egress row, which would make (c)'s "no registry fetch"
// vacuous; over HTTP, (a) shows the rows and requests that (c) then shows are absent.
//
// Sandbox seams — exactly those of `extension-sync.e2e.test.ts` and `migration.e2e.test.ts`: the
// sync pages are produced INSIDE the extension, so the manifest declares no network at all (the
// Windows AppContainer cannot reach loopback); the suite self-validates `canConfine` over a
// no-network policy on THIS machine, fails by name on CI when that is unmet, and on Windows points
// the wrapper at the repo-built `nimbus-sandbox-helper.exe` beside `process.execPath`. (c) and (d)
// spawn no extension and run everywhere.
//
// The Vault: on macOS and Linux it is the machine-global keychain / keyring, so a seeded
// `readwise.token` is visible outside this test's temp dirs. Off CI, a machine whose Vault holds a
// real (non-fixture) value there skips every describe unless NIMBUS_E2E_ALLOW_REAL_VAULT=1. Every
// describe first records the prior values of the keys it touches and clears them, and afterwards
// restores exactly the keys it recorded. The publisher id is unique per run and its cached key is
// evicted afterwards (as in `registry-acceptance.e2e`). Windows' DPAPI Vault lives under each
// run's temp `configDir`, so none of this reaches a real Vault there.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1).

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
import { dirname, join, resolve, sep } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import {
  type MigrateIo,
  runConnectorMigrate,
} from "../../../cli/src/commands/connector-migrate.ts";
import { createIpcClient } from "../../../cli/src/lib/rpc-timeouts.ts";
import { evictPublisherKey } from "../../src/extensions/publisher-keys.ts";
import { buildTestRegistry } from "../../src/extensions/registry/__fixtures__/build-test-registry.ts";
import type { PlatformPaths } from "../../src/platform/paths.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";
import { createNimbusVault } from "../../src/vault/factory.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const IS_CI = process.env["CI"] === "true";

const LEGACY = "readwise";
// audit-ignore-next-line D11-vault-key (the legacy key the binding maps to, asserted, not built)
const LEGACY_KEY = "readwise.token";
const EXTENSION_ID = "com.nimbus.readwise";
const CODE_SERVER_ID = "ext_com_nimbus_readwise";
// audit-ignore-next-line D11-vault-key (the key a bound credential must NOT land at)
const EXT_KEY = `ext.${CODE_SERVER_ID}.token`;
/** Global constraint / ruling B4: the stored bytes of Readwise's resting cursor `{"pass":1}`. */
const RESTING_CURSOR = "nimbus-readwise1:eyJwYXNzIjoxfQ";
const OFFICIAL = "nimbus-official";
/** Unique per run: on macOS/Linux the cached publisher key lives in the machine-global keychain. */
const PUBLISHER_ID = `e2e-rw-${randomUUID().slice(0, 8)}`;
const SEEDED_ITEMS = [
  { type: "highlight", externalId: "101", title: "old 101" },
  { type: "highlight", externalId: "102", title: "old 102" },
  { type: "book", externalId: "book/7", title: "old book" },
];
const ITEM_KEYS = SEEDED_ITEMS.map((i) => `${i.type} ${i.externalId}`).sort();

function fakeToken(): string {
  return `${FAKE_TOKEN_PREFIX}${randomUUID()}`;
}
function markerOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

const FAKE_TOKEN_PREFIX = "e2e-readwise-token-";
const ALLOW_REAL_VAULT = "NIMBUS_E2E_ALLOW_REAL_VAULT";

/**
 * On macOS and Linux the Vault is the machine-global keychain / keyring, so the describes below
 * clear and later restore the REAL `readwise.token` (and the `ext.` key). On a developer's machine
 * that holds a non-fixture value there, every describe is skipped — a killed run would lose it, and
 * a running Nimbus would sync with the fake one meanwhile — unless the owner opts in. Never on CI:
 * a CI keychain holds no real token, and a skip there would hide the test. Windows is unaffected:
 * its DPAPI Vault lives under each run's temp `configDir`.
 */
const realVaultHeld = await (async () => {
  if (process.platform === "win32" || IS_CI) return false;
  const probeDir = mkdtempSync(join(tmpdir(), "nimbus-rwcut-probe-"));
  try {
    const vault = await createNimbusVault({
      configDir: join(probeDir, "config"),
      dataDir: join(probeDir, "data"),
      logDir: join(probeDir, "logs"),
      socketPath: join(probeDir, "gw.sock"),
      extensionsDir: join(probeDir, "extensions"),
      tempDir: join(probeDir, "tmp"),
      sandboxDir: join(probeDir, "sandbox"),
    });
    for (const key of [LEGACY_KEY, EXT_KEY]) {
      const value = await vault.get(key);
      if (value !== null && !value.startsWith(FAKE_TOKEN_PREFIX)) return true;
    }
    return false;
  } catch {
    // An unreadable Vault cannot be protected or harmed here; the gateway would fail by name.
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();
const SKIP_REAL_VAULT = realVaultHeld && process.env[ALLOW_REAL_VAULT] !== "1";
if (SKIP_REAL_VAULT) {
  console.warn(
    `readwise-cutover e2e: SKIPPED -- this machine's Vault holds a real ${LEGACY_KEY} (or ` +
      `${EXT_KEY}), which these tests would clear and replace while they run. Set ` +
      `${ALLOW_REAL_VAULT}=1 to run them anyway; the value is restored afterwards.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Sandbox precondition — the same self-validating probe as extension-sync.e2e / migration.e2e
// ---------------------------------------------------------------------------------------------

const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "readwise-cutover-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
})();

/** As in extension-sync.e2e: the wrapper resolves the helper beside `process.execPath`. */
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

describe.skipIf(sandboxAvailable || !IS_CI)(
  "readwise cutover e2e — CI sandbox precondition",
  () => {
    test("fails loudly instead of silently skipping the confined Readwise sync", () => {
      expect(
        "readwise-cutover-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
          "no-network policy, so the Readwise extension cannot be spawned for sync. Install this " +
          "platform's sandbox dependency (scripts/linux/install-sandbox-deps.sh on Linux, " +
          "build:sandbox-helper:win32 on Windows).",
      ).toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The synthetic `com.nimbus.readwise` extension and its fixture built-in registry (built once)
// ---------------------------------------------------------------------------------------------

/**
 * The scaffold's server plus `__nimbus_sync`. It returns the three items a bundled Readwise
 * indexed, under the SAME types and external ids, with titles that carry the cursor it was handed
 * and a digest of its credential env var (never the value). A cursor it was handed is echoed back
 * byte for byte; a first run answers with the resting cursor.
 */
const ENTRY_TS = `import { createHash } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

const marker = createHash("sha256")
  .update(process.env.READWISE_TOKEN ?? "<unset>")
  .digest("hex")
  .slice(0, 16);

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
    const seen = cursor ?? "<none>";
    const now = Date.now();
    const item = (type: string, externalId: string) => ({
      type,
      externalId,
      title: "migrated " + externalId + " " + marker + " from " + seen,
      modifiedAt: now,
      metadata: {},
    });
    const page = {
      status: "ok",
      items: [item("highlight", "101"), item("highlight", "102"), item("book", "book/7")],
      cursor: cursor ?? "${RESTING_CURSOR}",
      hasMore: false,
    };
    return { content: [{ type: "text", text: JSON.stringify(page) }] };
  },
);
await server.connect(new StdioServerTransport());
`;

const MANIFEST_EXTRA = {
  name: "Readwise",
  permissions: { network: [], filesystem: { read: [], write: [] } },
  credentials: { token: { env: "READWISE_TOKEN" } },
  sync: { contract: "1", intervalSeconds: 3600, itemTypes: ["highlight", "book"] },
};

interface Fixture {
  registryDir: string;
  rootKey: string;
  publisherKey: string;
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

function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}

const fixtureTmp = mkdtempSync(join(tmpdir(), "nimbus-rwcut-fixture-"));
let fixturePromise: Promise<Fixture> | undefined;

/** Scaffold, replace the entry, bundle, publish into a signed registry folder. Built once per file. */
function sharedFixture(): Promise<Fixture> {
  fixturePromise ??= (async () => {
    const scaffoldRoot = join(fixtureTmp, "scaffold");
    const project = join(scaffoldRoot, "readwise_ext");
    const bundle = join(fixtureTmp, "bundle", "index.js");
    mkdirSync(scaffoldRoot, { recursive: true });
    const scaffold = await run(["bun", CLI_ENTRY, "scaffold", "mcp", "readwise_ext"], scaffoldRoot);
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
      ["bun", "build", "src/index.ts", "--target=bun", "--outfile", bundle],
      project,
    );
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }
    const registryDir = join(fixtureTmp, "official");
    const built = await buildTestRegistry(registryDir, {
      id: EXTENSION_ID,
      versions: [{ version: "1.0.0" }],
      publisherId: PUBLISHER_ID,
      manifestExtra: MANIFEST_EXTRA,
      entrySource: readFileSync(bundle, "utf8"),
    });
    return { registryDir, rootKey: built.rootKey, publisherKey: built.publisherKey };
  })();
  return fixturePromise;
}

afterAll(() => {
  try {
    rmSync(fixtureTmp, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

/** The fixture continuity entry: the real ids and legacy key, the TEST key and root fingerprint. */
function migrationFixture(f: Fixture, builtinUrl: string): Record<string, unknown> {
  return {
    builtin: { url: builtinUrl, rootKey: f.rootKey },
    continuityTable: [
      {
        legacyServiceId: LEGACY,
        extensionId: EXTENSION_ID,
        publisherKey: f.publisherKey,
        sourceRootFingerprint: publisherKeyFingerprint(f.rootKey),
        credentials: { token: LEGACY_KEY },
        // The sandbox seam: the fixture declares no network (the real entry names readwise.io).
        expectedPermissions: { network: [], read: [], write: [] },
        itemTypes: ["highlight", "book"],
        displayName: "Readwise",
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Loopback registry server — counts every request it is asked
// ---------------------------------------------------------------------------------------------

interface RegistryServer {
  readonly url: string;
  readonly requests: string[];
  stop(): void;
}

function serveRegistry(dir: string): RegistryServer {
  const root = resolve(dir);
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      requests.push(rel);
      const path = resolve(root, ...rel.split("/"));
      if (!path.startsWith(root + sep)) return new Response("not found", { status: 404 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    requests,
    stop: () => {
      void server.stop(true);
    },
  };
}

/** A loopback URL nothing listens on: a server is bound to learn a free port, then stopped. */
async function deadRegistryUrl(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  return `http://127.0.0.1:${String(port)}/`;
}

// ---------------------------------------------------------------------------------------------
// The per-describe gateway harness
// ---------------------------------------------------------------------------------------------

type NotificationHandler = (params: Record<string, unknown>) => void;

/** JSON-RPC over the raw socket, with notification routing (for `consent.request`). */
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
    await new Promise<void>((done, fail) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => done());
      sock.on("error", (e) => {
        fail(e);
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
        const params = (msg["params"] as Record<string, unknown> | undefined) ?? {};
        this.notifyHandlers.get(method)?.(params);
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
    return new Promise<T>((done, fail) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          fail(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        done(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.notifyHandlers.clear();
    this.sock?.destroy();
  }
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  ms = 60_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type RowView = { id: string; state: string; error: string | null; [k: string]: unknown };
type StatusRow = {
  serviceId: string;
  status: string;
  healthState: string;
  lastError: string | null;
  itemCount: number;
  [k: string]: unknown;
};
type ItemRow = { id: string; type: string; external_id: string; title: string };
type EgressRow = { sourceType: string; destination: string; method: string };

/** The keys a describe touches in the Vault; on macOS/Linux that Vault is machine-global. */
const TOUCHED_KEYS = [LEGACY_KEY, EXT_KEY];

type HeldVault = Pick<NimbusVault, "get" | "set" | "delete">;

/**
 * Puts back exactly the keys in `held` (recorded before they were cleared): a key recorded as
 * absent is deleted, a recorded value is written back. A key never recorded is not touched. Each
 * key is tried; a value that could not be restored is reported by key name (never the value) and
 * the first failure is rethrown afterwards.
 */
async function restoreHeldKeys(
  vault: HeldVault,
  held: ReadonlyMap<string, string | null>,
): Promise<void> {
  let firstError: unknown;
  for (const [key, prior] of held) {
    try {
      await vault.delete(key);
      if (prior !== null) await vault.set(key, prior);
    } catch (e) {
      if (prior !== null) {
        console.error(
          `readwise-cutover e2e: could NOT restore the Vault key ${key}; its earlier value is lost`,
        );
      }
      firstError ??= e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

class Gateway {
  readonly tmp: string;
  readonly paths: PlatformPaths;
  client = new TestIpcClient();
  log = "";
  /** The action type of every consent request the harness client answered. */
  readonly consentAsked: string[] = [];
  readonly consentPrompts: string[] = [];
  private proc: ReturnType<typeof Bun.spawn> | undefined;
  private priorVault = new Map<string, string | null>();

  constructor(tag: string) {
    this.tmp = mkdtempSync(join(tmpdir(), `nimbus-rwcut-${tag}-`));
    this.paths = {
      configDir: join(this.tmp, "config"),
      dataDir: join(this.tmp, "data"),
      logDir: join(this.tmp, "logs"),
      socketPath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\nimbus-rwcut-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
          : join(this.tmp, "gw.sock"),
      extensionsDir: join(this.tmp, "extensions"),
      tempDir: join(this.tmp, "tmp"),
      sandboxDir: join(this.tmp, "sandbox"),
    };
    for (const d of [this.paths.configDir, this.paths.dataDir]) mkdirSync(d, { recursive: true });
  }

  /** Records and clears the keys this describe touches, so it starts from a known Vault. */
  async holdVault(): Promise<void> {
    const vault = await createNimbusVault(this.paths);
    for (const key of TOUCHED_KEYS) {
      this.priorVault.set(key, await vault.get(key));
      await vault.delete(key);
    }
  }

  async vaultGet(key: string): Promise<string | null> {
    return (await createNimbusVault(this.paths)).get(key);
  }

  /** Boots the runner (one data dir across boots) and connects the harness client. */
  async boot(fixtureEnv: Record<string, string>, answerConsent: boolean): Promise<void> {
    this.log = "";
    this.proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(this.paths),
        ...fixtureEnv,
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_NOTIFICATIONS: "off",
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.log += decoder.decode(chunk);
    };
    void collect(this.proc.stderr as ReadableStream<Uint8Array>);
    void collect(this.proc.stdout as ReadableStream<Uint8Array>);
    try {
      await until(
        async () => (this.log.includes("[gateway] ready (e2e)") ? true : undefined),
        "gateway bind",
      );
    } catch (e) {
      throw this.withLog(e);
    }
    this.client = new TestIpcClient();
    await this.client.connect(this.paths.socketPath);
    if (answerConsent) {
      this.client.onNotification("consent.request", (params) => {
        this.consentAsked.push(String(params["actionType"] ?? "unknown"));
        this.consentPrompts.push(String(params["prompt"] ?? ""));
        void this.client
          .call("consent.respond", { requestId: params["requestId"], approved: true })
          .catch(() => {});
      });
    }
  }

  async stop(): Promise<void> {
    this.client.close();
    this.proc?.kill();
    await this.proc?.exited.catch(() => {});
    this.proc = undefined;
  }

  /**
   * Stops the gateway, restores ONLY the Vault keys `holdVault` recorded (a setup failure before
   * it touches nothing), evicts the per-run publisher key and removes the temp dirs. A real value
   * that could not be put back fails the run, naming the key.
   */
  async dispose(): Promise<void> {
    await this.stop();
    let restoreError: unknown;
    if (this.priorVault.size > 0) {
      try {
        await restoreHeldKeys(await createNimbusVault(this.paths), this.priorVault);
      } catch (e) {
        restoreError = e;
      }
    }
    try {
      await evictPublisherKey(await createNimbusVault(this.paths), PUBLISHER_ID);
    } catch {
      /* best-effort -- the publisher id is unique to this run */
    }
    try {
      rmSync(this.tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
    if (restoreError !== undefined) throw restoreError;
  }

  withLog(e: unknown): Error {
    return new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${this.log.slice(-8000)}`,
    );
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.client.call<T>(method, params);
    } catch (e) {
      throw this.withLog(e);
    }
  }

  /** Read-only, from the gateway's own SQLite file (the gateway keeps its write connection). */
  query<T>(sql: string, ...params: string[]): T[] {
    const db = new Database(join(this.paths.dataDir, "nimbus.db"), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return db.query(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  items(service: string): ItemRow[] {
    return this.query<ItemRow>(
      "SELECT id, type, external_id, title FROM item WHERE service = ? ORDER BY id",
      service,
    );
  }

  storedCursor(service: string): string | null {
    const row = this.query<{ cursor: string | null }>(
      "SELECT cursor FROM scheduler_state WHERE service_id = ?",
      service,
    )[0];
    return row?.cursor ?? null;
  }

  async egress(): Promise<EgressRow[]> {
    return (await this.call<{ rows: EgressRow[] }>("egress.list", { limit: 10_000 })).rows;
  }

  async syncRuns(destination: string): Promise<number> {
    return (await this.egress()).filter(
      (r) => r.destination === destination && r.method === "sync.run",
    ).length;
  }

  async status(service: string): Promise<StatusRow> {
    return this.call<StatusRow>("connector.status", { serviceId: service });
  }

  async migrations(): Promise<RowView[]> {
    return (await this.call<{ migrations: RowView[] }>("migration.list", {})).migrations;
  }

  async installedIds(): Promise<string[]> {
    const out = await this.call<unknown>("extension.list", {});
    const list = Array.isArray(out) ? out : ((out as { extensions?: unknown[] }).extensions ?? []);
    return list.map((e) => String((e as { id?: unknown }).id ?? ""));
  }
}

const itemKeys = (rows: ItemRow[]): string[] =>
  rows.map((r) => `${r.type} ${r.external_id}`).sort();

/** The bundled-style state an upgrading user has: items and a scheduler row on the resting cursor. */
function legacySeed(nextSyncAt: number): string {
  const now = Date.now();
  return JSON.stringify({
    serviceId: LEGACY,
    items: SEEDED_ITEMS,
    scheduler: {
      cursor: RESTING_CURSOR,
      intervalMs: 600_000,
      lastSyncAt: now - 900_000,
      nextSyncAt,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// (a) Upgrade in place
// ---------------------------------------------------------------------------------------------

describe.skipIf(!sandboxAvailable || SKIP_REAL_VAULT)(
  "(a) an upgrading Readwise user moves to the extension in place",
  () => {
    const gw = new Gateway("upgrade");
    const TOKEN = fakeToken();
    let server: RegistryServer | undefined;
    let restoreHelper: () => void = () => {};
    let migrationId = "";
    let idsBefore: string[] = [];
    const prompts: string[] = [];

    /** The CLI's own command, given a TTY it controls and a terminal that answers "y". */
    function ttyIo(lines: string[]): MigrateIo {
      return {
        stdinIsTty: true,
        stdoutIsTty: true,
        open: async (timeoutMs) => {
          const c = createIpcClient(gw.paths.socketPath, timeoutMs);
          await c.connect();
          return c;
        },
        confirm: async ({ message }) => {
          prompts.push(message);
          return true;
        },
        log: (l) => lines.push(l),
      };
    }

    beforeAll(async () => {
      // FIRST: dispose() restores only what this recorded, so a later failure loses nothing.
      await gw.holdVault();
      const fixture = await sharedFixture();
      server = serveRegistry(fixture.registryDir);
      restoreHelper = installDefaultHelper();
      // The release the user upgrades FROM: one plain boot, so the upgrade boot has no fresh-install
      // queue of bundled syncables (see `pendingRuns` in migration.e2e).
      await gw.boot({}, false);
      await gw.stop();
      // The upgrade. The seeded row is NOT due (next run in an hour), so accept's resume schedules
      // nothing and the one run under test is the forced `connector.sync readwise`.
      await gw.boot(
        {
          NIMBUS_E2E_SEED_VAULT_JSON: JSON.stringify({ [LEGACY_KEY]: TOKEN }),
          NIMBUS_E2E_MIGRATION_FIXTURE_JSON: JSON.stringify(migrationFixture(fixture, server.url)),
          NIMBUS_E2E_SEED_LEGACY_JSON: legacySeed(Date.now() + 3_600_000),
        },
        false,
      );
    }, 300_000);

    afterAll(async () => {
      await gw.dispose();
      server?.stop();
      restoreHelper();
    });

    test("boot evaluation prepares a `readwise` migration from the built-in registry", async () => {
      const row = await until(async () => {
        const r = (await gw.migrations())[0];
        if (r?.state === "failed") throw gw.withLog(`migration failed: ${r.error ?? ""}`);
        return r?.state === "awaiting_approval" ? r : undefined;
      }, "the migration to be prepared");
      migrationId = row.id;
      expect(row).toMatchObject({ legacyServiceId: LEGACY, extensionId: EXTENSION_ID });

      const lines: string[] = [];
      await runConnectorMigrate(["list"], ttyIo(lines));
      expect(lines.join("\n")).toContain(
        `${migrationId}  ${LEGACY} -> ${EXTENSION_ID} 1.0.0  awaiting_approval`,
      );

      // Paused while the owner decides; nothing installed; the bundled items are all there.
      expect((await gw.status(LEGACY)).status).toBe("paused");
      expect(await gw.installedIds()).not.toContain(EXTENSION_ID);
      idsBefore = gw.items(LEGACY).map((r) => r.id);
      expect(itemKeys(gw.items(LEGACY))).toEqual(ITEM_KEYS);

      // The control for (c): the built-in registry was really asked, over loopback, and every
      // request is in the egress ledger under the built-in's name.
      expect(server?.requests).toContain("index.json");
      const registryRows = (await gw.egress()).filter((r) => r.sourceType === "registry");
      expect(registryRows.length).toBeGreaterThan(0);
      expect(registryRows.every((r) => r.destination === OFFICIAL)).toBe(true);
    }, 120_000);

    test("`migrate accept` answered y installs, grants and resumes in ONE prompt", async () => {
      expect(migrationId).not.toBe("");
      const lines: string[] = [];
      await runConnectorMigrate(["accept", migrationId], ttyIo(lines));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("extension.migrate");
      expect(prompts[0]).toContain("Readwise");
      expect(prompts[0]).not.toContain(TOKEN);
      expect(lines.join("\n")).toContain(
        `${LEGACY} now runs as the extension ${EXTENSION_ID} 1.0.0`,
      );
      expect((await gw.migrations()).map((m) => [m.id, m.state])).toEqual([
        [migrationId, "approved"],
      ]);
      expect(await gw.installedIds()).toContain(EXTENSION_ID);
      // Resumed, not run: the seeded row is not due, so nothing has synced yet.
      expect((await gw.status(LEGACY)).status).not.toBe("paused");
      expect(await gw.syncRuns(LEGACY)).toBe(0);
      // The legacy credential was not copied anywhere.
      expect(await gw.vaultGet(LEGACY_KEY)).toBe(TOKEN);
      expect(await gw.vaultGet(EXT_KEY)).toBeNull();
    }, 120_000);

    test("`connector.sync readwise` runs once, appends ONE sync.run row and updates the items in place", async () => {
      await gw.call("connector.sync", { serviceId: LEGACY });
      expect(await gw.syncRuns(LEGACY)).toBe(1);
      // …and it stays one: nothing else runs within the extension's hour-long interval.
      await new Promise((r) => setTimeout(r, 2_000));
      expect(await gw.syncRuns(LEGACY)).toBe(1);
      expect(await gw.syncRuns(CODE_SERVER_ID)).toBe(0);

      const after = gw.items(LEGACY);
      // Same item ids, same types and external ids: zero duplicates, zero deletions.
      expect(after.map((r) => r.id)).toEqual(idsBefore);
      expect(itemKeys(after)).toEqual(ITEM_KEYS);
      // Written by the extension, which got `readwise.token` (no re-entry) and the stored cursor.
      for (const r of after) {
        expect(r.title).toContain("migrated ");
        expect(r.title).toContain(markerOf(TOKEN));
        expect(r.title).toContain(`from ${RESTING_CURSOR}`);
      }
      expect(gw.items(CODE_SERVER_ID)).toEqual([]);
      // The resting cursor is stored byte for byte as the bundled connector left it.
      expect(gw.storedCursor(LEGACY)).toBe(RESTING_CURSOR);

      // The run used `readwise.token` (its digest is in the titles), and the catalog id reports
      // ok / healthy.
      const status = await gw.status(LEGACY);
      expect(status).toMatchObject({ serviceId: LEGACY, status: "ok", itemCount: 3 });
      expect(status.healthState).toBe("healthy");
      expect(gw.log).not.toContain(TOKEN);
    }, 120_000);
  },
);

// ---------------------------------------------------------------------------------------------
// (b) Fresh install
// ---------------------------------------------------------------------------------------------

describe.skipIf(!sandboxAvailable || SKIP_REAL_VAULT)(
  "(b) a fresh Readwise install binds to `readwise`",
  () => {
    const gw = new Gateway("fresh");
    const TOKEN = fakeToken();
    let server: RegistryServer | undefined;
    let restoreHelper: () => void = () => {};

    beforeAll(async () => {
      // FIRST: dispose() restores only what this recorded, so a later failure loses nothing.
      await gw.holdVault();
      const fixture = await sharedFixture();
      server = serveRegistry(fixture.registryDir);
      restoreHelper = installDefaultHelper();
      await gw.boot({}, false);
      await gw.stop();
      await gw.boot(
        {
          NIMBUS_E2E_MIGRATION_FIXTURE_JSON: JSON.stringify(migrationFixture(fixture, server.url)),
        },
        true,
      );
    }, 300_000);

    afterAll(async () => {
      await gw.dispose();
      server?.stop();
      restoreHelper();
    });

    test("a bare `registry.install` from the built-in registry, approved to run, binds to `readwise`", async () => {
      expect(await gw.migrations()).toEqual([]);
      const installed = await gw.call<{ id: string; version: string; sourceRegistry: string }>(
        "registry.install",
        { id: EXTENSION_ID },
      );
      expect(installed).toMatchObject({
        id: EXTENSION_ID,
        version: "1.0.0",
        sourceRegistry: OFFICIAL,
      });
      await gw.call("extension.approveRun", { id: EXTENSION_ID });
      expect(gw.consentAsked).toEqual(["extension.install", "extension.run"]);
      // The registrar registered the sync under the index id, not the extension's own `ext_` id.
      expect((await gw.status(LEGACY)).serviceId).toBe(LEGACY);
      const ownId = await gw.client.call("connector.status", { serviceId: CODE_SERVER_ID }).then(
        () => "resolved",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(ownId).toContain(`Unknown connector: ${CODE_SERVER_ID}`);

      // Registering the sync makes `readwise` due at once, so the scheduler runs it with no
      // credential yet. Wait for THAT run to finish (it records `lastSyncAt`): a forced sync issued
      // while it is still in flight is settled by its completion (force waiters are per service),
      // so the run under test below would read a credential-less run. On Windows it finishes
      // inside `approveRun`; on Linux each Vault read spawns `secret-tool`, and it was still in
      // flight when CI issued the forced sync. Unconfigured, it appends no sync.run row (I29).
      await until(async () => {
        const s = await gw.status(LEGACY);
        return s["lastSyncAt"] !== null ? s : undefined;
      }, "the registration's first (unconfigured) run to finish").catch((e: unknown) => {
        throw gw.withLog(e);
      });
      expect(await gw.syncRuns(LEGACY)).toBe(0);
    }, 120_000);

    test("`extension.credentialSet token` lands at `readwise.token`, never `ext.…`", async () => {
      await gw.call("extension.credentialSet", { id: EXTENSION_ID, name: "token", value: TOKEN });
      expect(await gw.vaultGet(LEGACY_KEY)).toBe(TOKEN);
      expect(await gw.vaultGet(EXT_KEY)).toBeNull();
      for (const p of gw.consentPrompts) expect(p).not.toContain(TOKEN);
    }, 120_000);

    test("a sync indexes under `readwise` with ONE sync.run row, and `connector.status` reads configured", async () => {
      await gw.call("connector.sync", { serviceId: LEGACY });
      expect(await gw.syncRuns(LEGACY)).toBe(1);
      expect(await gw.syncRuns(CODE_SERVER_ID)).toBe(0);
      const rows = gw.items(LEGACY);
      expect(itemKeys(rows)).toEqual(ITEM_KEYS);
      for (const r of rows) {
        expect(r.title).toContain(markerOf(TOKEN));
        expect(r.title).toContain("from <none>");
      }
      expect(gw.items(CODE_SERVER_ID)).toEqual([]);
      expect(gw.storedCursor(LEGACY)).toBe(RESTING_CURSOR);
      const status = await gw.status(LEGACY);
      expect(status).toMatchObject({ serviceId: LEGACY, status: "ok", itemCount: 3 });
      expect(status.healthState).toBe("healthy");
      // No migration was ever involved: the owner installed it.
      expect(await gw.migrations()).toEqual([]);
      expect(gw.log).not.toContain(TOKEN);
    }, 120_000);
  },
);

// ---------------------------------------------------------------------------------------------
// (c) Legacy items, no token
// ---------------------------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_VAULT)(
  "(c) Readwise items without `readwise.token` prepare nothing and fetch nothing",
  () => {
    const gw = new Gateway("notoken");
    let server: RegistryServer | undefined;

    beforeAll(async () => {
      // FIRST: dispose() restores only what this recorded, so a later failure loses nothing.
      await gw.holdVault();
      const fixture = await sharedFixture();
      server = serveRegistry(fixture.registryDir);
      await gw.boot(
        {
          NIMBUS_E2E_MIGRATION_FIXTURE_JSON: JSON.stringify(migrationFixture(fixture, server.url)),
          NIMBUS_E2E_SEED_LEGACY_JSON: legacySeed(Date.now() + 3_600_000),
        },
        false,
      );
    }, 300_000);

    afterAll(async () => {
      await gw.dispose();
      server?.stop();
    });

    test("no migration row, no registry request, no registry egress row; the items are untouched", async () => {
      // `retry` runs the same evaluation as boot and awaits it, so this is settled, not early.
      expect(await gw.call<{ migrations: RowView[] }>("migration.retry", {})).toEqual({
        migrations: [],
      });
      expect(await gw.migrations()).toEqual([]);
      expect(server?.requests).toEqual([]);
      const rows = await gw.egress();
      // Non-vacuous: the ledger is live (the boot marker is a row), it just holds no registry row.
      expect(rows.some((r) => r.method === "egress.boot")).toBe(true);
      expect(rows.filter((r) => r.sourceType === "registry")).toEqual([]);
      expect(itemKeys(gw.items(LEGACY))).toEqual(ITEM_KEYS);
      expect((await gw.status(LEGACY)).status).not.toBe("paused");
      expect(await gw.installedIds()).not.toContain(EXTENSION_ID);
    }, 120_000);
  },
);

// ---------------------------------------------------------------------------------------------
// (d) Offline: the built-in registry is unreachable (spec § 9.3)
// ---------------------------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_VAULT)(
  "(d) an unreachable built-in registry pauses `readwise` with the reason",
  () => {
    const gw = new Gateway("offline");
    const TOKEN = fakeToken();

    beforeAll(async () => {
      // FIRST: dispose() restores only what this recorded, so a later failure loses nothing.
      await gw.holdVault();
      const fixture = await sharedFixture();
      await gw.boot(
        {
          NIMBUS_E2E_SEED_VAULT_JSON: JSON.stringify({ [LEGACY_KEY]: TOKEN }),
          NIMBUS_E2E_MIGRATION_FIXTURE_JSON: JSON.stringify(
            migrationFixture(fixture, await deadRegistryUrl()),
          ),
          NIMBUS_E2E_SEED_LEGACY_JSON: legacySeed(Date.now() + 3_600_000),
        },
        false,
      );
    }, 300_000);

    afterAll(async () => {
      await gw.dispose();
    });

    test("the migration fails, and `connector.status readwise` shows the paused reason", async () => {
      const row = await until(async () => {
        const r = (await gw.migrations())[0];
        return r?.state === "failed" ? r : undefined;
      }, "the migration to fail").catch((e: unknown) => {
        throw gw.withLog(e);
      });
      expect(row).toMatchObject({ legacyServiceId: LEGACY, extensionId: EXTENSION_ID });
      const status = await gw.status(LEGACY);
      expect(status.status).toBe("paused");
      expect(row.error).toContain("ERR_REGISTRY_UNREACHABLE");
      expect(row.error).toContain(OFFICIAL);
      // The row's error, plus the one next step the owner has: the paused reason.
      expect(status.lastError).toBe(`${row.error ?? ""} — run \`nimbus connector migrate retry\``);
      expect(itemKeys(gw.items(LEGACY))).toEqual(ITEM_KEYS);
      expect(await gw.installedIds()).not.toContain(EXTENSION_ID);
      expect(await gw.vaultGet(LEGACY_KEY)).toBe(TOKEN);
      expect(gw.log).not.toContain(TOKEN);
    }, 120_000);
  },
);

// ---------------------------------------------------------------------------------------------
// The Vault restore itself (no gateway, no real Vault): it touches only what was recorded
// ---------------------------------------------------------------------------------------------

describe("restoreHeldKeys (the describes' Vault restore)", () => {
  function memoryVault(initial: Record<string, string>, failSetOn?: string) {
    const store = new Map(Object.entries(initial));
    const vault: HeldVault = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        if (k === failSetOn) throw new Error("locked keychain");
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
    };
    return { store, vault };
  }

  test("restores recorded values, deletes keys recorded absent, never touches unrecorded keys", async () => {
    const { store, vault } = memoryVault({
      [LEGACY_KEY]: "e2e-readwise-token-seeded",
      [EXT_KEY]: "e2e-readwise-token-leftover",
      "other.token": "untouched",
    });
    await restoreHeldKeys(
      vault,
      new Map<string, string | null>([
        [LEGACY_KEY, "real-before"],
        [EXT_KEY, null],
      ]),
    );
    expect(Object.fromEntries(store)).toEqual({
      [LEGACY_KEY]: "real-before",
      "other.token": "untouched",
    });
  });

  test("with nothing recorded (setup failed before holdVault) it touches nothing", async () => {
    const { store, vault } = memoryVault({ [LEGACY_KEY]: "real-token" });
    await restoreHeldKeys(vault, new Map());
    expect(Object.fromEntries(store)).toEqual({ [LEGACY_KEY]: "real-token" });
  });

  test("a value that cannot be put back is reported by key name and fails the run", async () => {
    const { store, vault } = memoryVault({}, LEGACY_KEY);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await expect(
        restoreHeldKeys(
          vault,
          new Map<string, string | null>([
            [LEGACY_KEY, "real-secret-value"],
            [EXT_KEY, "real-ext-value"],
          ]),
        ),
      ).rejects.toThrow("locked keychain");
    } finally {
      console.error = original;
    }
    // The other key was still restored; the report names the key, never the value.
    expect(store.get(EXT_KEY)).toBe("real-ext-value");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(LEGACY_KEY);
    expect(errors[0]).not.toContain("real-secret-value");
  });
});
