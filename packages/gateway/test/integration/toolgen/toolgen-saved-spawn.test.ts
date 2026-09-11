import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../../../src/config/nimbus-toml.ts";
import { resolveRuntimeById } from "../../../src/exec/exec-runtimes.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import {
  createSandboxRunner,
  type SandboxRunner,
} from "../../../src/platform/sandbox/sandbox-runner.ts";
import { reconcileSavedTools } from "../../../src/toolgen/toolgen-boot-reconcile.ts";
import { ToolgenBroker } from "../../../src/toolgen/toolgen-broker.ts";
import {
  buildToolSpawnSpec,
  type GeneratedToolHandle,
  ioFromSpawnedChild,
  wireExitCallback,
  wireToolProtocol,
} from "../../../src/toolgen/toolgen-client.ts";
import { assertToolConfinement } from "../../../src/toolgen/toolgen-confinement.ts";
import {
  createDraftToolClosure,
  type DraftGeneration,
} from "../../../src/toolgen/toolgen-draft.ts";
import { createGeneratedTool, type ToolgenGateDeps } from "../../../src/toolgen/toolgen-gate.ts";
import { TOOLGEN_SIGNING_PUBKEY } from "../../../src/toolgen/toolgen-keypair.ts";
import { ToolgenRegistry } from "../../../src/toolgen/toolgen-registry.ts";
import { saveGeneratedTool, type ToolgenSaveDeps } from "../../../src/toolgen/toolgen-save-gate.ts";
import { getSavedTool } from "../../../src/toolgen/toolgen-saved-repo.ts";
import {
  loadSavedToolsIntoRegistry,
  type SavedSpawnDeps,
  spawnSavedTool,
} from "../../../src/toolgen/toolgen-saved-spawn.ts";
import {
  readVerifiedSavedTool,
  rewriteSavedToolScript,
  savedToolDir,
} from "../../../src/toolgen/toolgen-saved-store.ts";
import { toolScriptDir, writeToolScript } from "../../../src/toolgen/toolgen-script-store.ts";
import type {
  CreateGeneratedToolRequest,
  ToolgenEnvelope,
} from "../../../src/toolgen/toolgen-types.ts";
import type { NimbusVault } from "../../../src/vault/nimbus-vault.ts";

/**
 * The end-to-end proof that PR 3's persistence design actually works: a tool is created and saved
 * by ONE gateway process, then a SECOND, wholly independent gateway process -- its own `Database`
 * connection, its own `ToolgenRegistry`, its own `ToolgenBroker`, its own `SandboxRunner` -- boots
 * against the same `configDir`/database file, reconciles, loads the saved tool, spawns it and gets
 * a real answer back. Nothing from the first process is reused: the only things gateway B shares
 * with gateway A are the three things a REAL gateway restart shares -- the `saved/<toolId>` files on
 * disk, the `generated_tool` database row, and the Vault (represented here by a backing `Map` two
 * separate `NimbusVault` closures read/write, standing in for the OS keychain, which does not
 * belong to any one gateway process either).
 *
 * This is the test an earlier, rejected design would have failed on an OS the way no unit test with
 * injected fakes ever could: that design would have signed the CONCRETE manifest -- including
 * `filesystem.read`'s machine-derived, ephemeral-script-dir-and-bun-install-path entries -- so a
 * tool saved on one machine (or even the same machine after a Bun upgrade moved the interpreter)
 * would fail `assertConcreteManifestMatches` at load time with a real access-denial-shaped refusal,
 * not a fake one. The shipped design instead drops `filesystem.read` from what is signed
 * (`toolgen-portable-manifest.ts`) and rebuilds it fresh from code on every load/spawn, which is
 * exactly the property `REGRESSION: a changed runtime read path` below exercises directly.
 *
 * Deviations from real production wiring, stated precisely (same discipline as
 * `toolgen-draft-e2e.test.ts`, which this file's harness is closely modelled on):
 *
 * - `resolveHost`/`doFetch` redirect the one approved host to a local stub `Bun.serve` server
 *   instead of the real internet -- the same seam `toolgen-broker.test.ts` and the draft e2e suite
 *   use. Every other check in `ToolgenBroker.handleFetch` (scheme, approved-host match, address
 *   validation, credential attachment, the egress ledger append) runs for real.
 * - `requestApproval`/`bindCredentials`/`revokeCredentials` are test-authored stand-ins for the
 *   owner-approval broker and the Vault-backed credential writer -- this suite never asks for a
 *   credentialed host, so there is nothing for the credential ones to do either way.
 * - The Windows sandbox-helper path override below is copied from `toolgen-network-denied.test.ts`
 *   for the identical reason: under `bun test`, `process.execPath` is the installed
 *   `~/.bun/bin/bun.exe`, not this repo's own `src-native` build, and the sandbox runner probes at
 *   construction, so the override must be set before the FIRST `createSandboxRunner()` call.
 *
 * **Known environment gap (do not "fix" by skipping):** on a fresh worktree with no
 * `nimbus-sandbox-helper.exe` built (a git-ignored artifact), every test in this file that actually
 * spawns a child (all but the network-grant check) fails the same way the three pre-existing
 * toolgen integration tests in this repository do on a fresh checkout -- not a platform skip, a
 * missing local build prerequisite. Building `packages/gateway/src-native/sandbox-helper-win32`
 * (Windows) or the Linux/macOS sandbox helper equivalent makes it runnable. This file does not
 * `skipIf` any platform: a skip here would prove nothing about whether a saved tool can actually be
 * spawned by a process that never created it, which is the one thing no unit test can substitute
 * for.
 */

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

/**
 * The capability ENABLED, as both boot passes now require. `[tool_generation] enabled` and the
 * org-policy lock-off reach the DURABLE half (`toolgen-capability.ts`), so a real gateway boot
 * supplies these and a test that models one must too — they are REQUIRED rather than defaulted
 * precisely so a caller cannot get an enabled pass by forgetting them.
 */
const CAPABILITY_ON = {
  config: { enabled: true },
  enforced: { capabilitiesDisabled: new Set<string>() },
} as const;

const STUB_HOST = "api.example.com";
const STUB_PAYLOAD = { ok: true, value: 7 };

let server: ReturnType<typeof Bun.serve> | undefined;
let hits = 0;
let dialed = "";

function ensureServer(): ReturnType<typeof Bun.serve> {
  if (server === undefined) {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response(JSON.stringify(STUB_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }
  return server;
}

/** A `nimbusFetch` call to the one approved host -- what a real drafting model is supposed to
 * produce: a JSON envelope naming a body that calls the helper, never a raw `fetch()`. */
const fakeGenerate = async (_prompt: string): Promise<DraftGeneration | null> => ({
  text: JSON.stringify({
    inputSchema: { type: "object", properties: {} },
    body: `const res = await nimbusFetch("https://${STUB_HOST}/", { method: "GET" }); return JSON.parse(res.body);`,
  }),
  isLocal: true,
});

/**
 * A minimal `NimbusVault` backed by a SHARED `Map`, standing in for the OS keychain: two calls to
 * this function with the SAME `store` produce two distinct `NimbusVault` objects that nonetheless
 * see each other's writes -- exactly the property a real Vault has across two gateway processes on
 * one machine, and exactly what lets "gateway A" sign with a keypair "gateway B" can later verify
 * with, without either object being shared.
 */
function makeSharedVault(store: Map<string, string>): NimbusVault {
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

function fakeLogger(): { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } {
  return { warn: () => {}, info: () => {} };
}

/**
 * Reimplements `spawnGeneratedTool`'s body rather than calling it directly, for the reason
 * `toolgen-draft-e2e.test.ts` and `toolgen-network-denied.test.ts` both do the same:
 * `extensionProcessEnv` deliberately does not forward `NIMBUS_SANDBOX_HELPER_PATH` (I1's
 * baseline-key scoping), so the spawned `__nimbus-sandbox` wrapper would miss this repo's
 * `src-native` build under `bun test`. Every function called here is the exact production
 * primitive `spawnGeneratedTool` itself calls.
 */
async function spawnConfined(
  envelope: ToolgenEnvelope,
  broker: ToolgenBroker,
  cwd: string,
  onExit: () => void,
): Promise<GeneratedToolHandle> {
  const spec = buildToolSpawnSpec(envelope, cwd);
  const env = { ...spec.env };
  if (process.env["NIMBUS_SANDBOX_HELPER_PATH"] !== undefined) {
    env["NIMBUS_SANDBOX_HELPER_PATH"] = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
  const child = Bun.spawn<"pipe", "pipe", "inherit">([spec.command, ...spec.args], {
    env,
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const io = ioFromSpawnedChild(child);
  wireExitCallback(io, onExit);
  return wireToolProtocol(io, envelope, broker);
}

/**
 * Wired like `platform/assemble.ts` wires the real broker (`findArtifact`, covering BOTH the
 * ephemeral and the saved collection -- see `toolgen-registry.ts`'s docstring on why `get()` alone
 * is not enough for a request from a spawned SAVED tool), except for the network hop itself, which
 * redirects to the local stub server instead of the real internet.
 */
function buildBroker(db: Database, registry: ToolgenRegistry): ToolgenBroker {
  const srv = ensureServer();
  return new ToolgenBroker({
    db,
    now: () => Date.now(),
    maxRequestsPerTool: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.maxRequestsPerTool,
    requestTimeoutMs: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.requestTimeoutMs,
    resolveHost: async (host) => (host === STUB_HOST ? ["93.184.216.34"] : []),
    readCredential: async () => null,
    approvedHostsFor: (toolId) => registry.findArtifact(toolId)?.approvedHosts ?? [],
    credentialHostsFor: (toolId) => registry.findArtifact(toolId)?.credentialHosts ?? [],
    doFetch: async (url, init) => {
      dialed = url;
      return fetch(`http://127.0.0.1:${srv.port}/`, init);
    },
  });
}

/** One independently-constructed gateway process's toolgen-relevant state -- never reused across
 * "boots" in this file. */
interface GatewayHandle {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly registry: ToolgenRegistry;
  readonly broker: ToolgenBroker;
  readonly sandboxRunner: SandboxRunner;
}

async function bootGateway(
  dbPath: string,
  vaultStore: Map<string, string>,
): Promise<GatewayHandle> {
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const vault = makeSharedVault(vaultStore);
  const registry = new ToolgenRegistry();
  const broker = buildBroker(db, registry);
  const sandboxRunner = await createSandboxRunner();
  return { db, vault, registry, broker, sandboxRunner };
}

function buildCreateGateDeps(
  gw: GatewayHandle,
  configDir: string,
  draftTool: ToolgenGateDeps["draftTool"],
  onSpawned: (handle: GeneratedToolHandle) => void,
): ToolgenGateDeps {
  return {
    db: gw.db,
    config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry: gw.registry,
    draftTool,
    assertConfinement: (manifest) =>
      assertToolConfinement({ runner: gw.sandboxRunner, manifest, cwd: configDir }),
    scriptDir: (toolId) => toolScriptDir(configDir, toolId),
    writeScript: (toolId, source) => writeToolScript(configDir, toolId, source),
    spawn: async (envelope) => {
      const handle = await spawnConfined(envelope, gw.broker, dirname(envelope.scriptPath), () =>
        gw.registry.markTerminated(envelope.artifact.toolId),
      );
      onSpawned(handle);
      return handle;
    },
    requestApproval: async () => true,
    bindCredentials: async () => [],
    revokeCredentials: async () => {},
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

function buildSaveDeps(gw: GatewayHandle, configDir: string): ToolgenSaveDeps {
  return {
    db: gw.db,
    configDir,
    config: { enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry: gw.registry,
    vault: gw.vault,
    requestApproval: async () => true,
    now: () => Date.now(),
  };
}

function buildSavedSpawnDeps(
  gw: GatewayHandle,
  configDir: string,
  pubkeyB64: string,
  row: { approvedAt: number },
  requiredReadPaths: () => readonly string[],
  onSpawned: (handle: GeneratedToolHandle) => void,
): SavedSpawnDeps {
  return {
    configDir,
    pubkeyB64,
    // A CALLER session distinct from gateway A's -- proves the saved tool is not smuggling gateway
    // A's session id along with it (see `SavedSpawnDeps.sessionId`'s own docstring).
    sessionId: "session-b-caller",
    row,
    runtime: { requiredReadPaths },
    readVerifiedSavedTool,
    savedToolDir,
    rewriteSavedToolScript,
    spawn: async (envelope) => {
      const handle = await spawnConfined(envelope, gw.broker, dirname(envelope.scriptPath), () => {
        // Saved-tool spawns are never registered into the registry's ephemeral collection in this
        // suite (matching today's only production caller shape -- there is none yet), so this is a
        // harmless no-op rather than a real termination flag.
        gw.registry.markTerminated(envelope.artifact.toolId);
      });
      onSpawned(handle);
      return handle;
    },
  };
}

interface SavedFixture {
  readonly configDir: string;
  readonly dbPath: string;
  readonly vaultStore: Map<string, string>;
  readonly toolId: string;
}

/**
 * A COMPLETE gateway-A lifecycle: boot, create (drafts, approves and spawns a real ephemeral tool
 * that calls the stub host), save (a SECOND, standing owner approval that persists it), then a full
 * shutdown -- the ephemeral child closed, the registry drained, the database connection closed.
 * Every "gateway B" built afterward in this file constructs its OWN `Database`/`ToolgenRegistry`/
 * `ToolgenBroker`/`SandboxRunner` against the returned `dbPath`/`configDir`/`vaultStore` -- nothing
 * from gateway A survives this function returning except what a real restart would also leave
 * behind: the files on disk, the database row, and the Vault-equivalent backing store.
 */
async function createAndSaveInGatewayA(dirTag: string): Promise<SavedFixture> {
  const configDir = mkdtempSync(join(tmpdir(), `nimbus-toolgen-saved-e2e-${dirTag}-`));
  const dbPath = join(configDir, "nimbus.db");
  const vaultStore = new Map<string, string>();
  const gw = await bootGateway(dbPath, vaultStore);
  let handle: GeneratedToolHandle | undefined;
  try {
    const draftTool = createDraftToolClosure({
      generate: fakeGenerate,
      hasDraftRoute: async () => true,
      findEndpoints: async () => [],
    });
    const req: CreateGeneratedToolRequest = {
      sessionId: "session-a",
      description: "fetch a JSON payload from the example API",
      hosts: [STUB_HOST],
    };
    const createOutcome = await createGeneratedTool(
      req,
      buildCreateGateDeps(gw, configDir, draftTool, (h) => {
        handle = h;
      }),
    );
    if (createOutcome.status !== "registered") {
      throw new Error(`expected "registered", got ${JSON.stringify(createOutcome)}`);
    }
    const { toolId } = createOutcome;

    const saveOutcome = await saveGeneratedTool({ toolId }, buildSaveDeps(gw, configDir));
    if (saveOutcome.status !== "saved") {
      throw new Error(`expected "saved", got ${JSON.stringify(saveOutcome)}`);
    }

    return { configDir, dbPath, vaultStore, toolId };
  } finally {
    // Full shutdown of gateway A. A later "gateway B" in this file must be provably independent of
    // whatever is left un-closed here.
    await handle?.close();
    await gw.registry.revokeAll();
    gw.db.close();
  }
}

describe("a saved tool spawns and answers in a gateway that never saw its create", () => {
  test("create+save in gateway A, then boot+reconcile+load+spawn in gateway B", async () => {
    hits = 0;
    dialed = "";
    const fixture = await createAndSaveInGatewayA("happy");
    let gwB: GatewayHandle | undefined;
    let handleB: GeneratedToolHandle | undefined;

    try {
      // ---- Gateway B: boots fresh against the same disk state, never touching gateway A's
      // in-memory objects. ----
      gwB = await bootGateway(fixture.dbPath, fixture.vaultStore);

      const reconcileResult = await reconcileSavedTools({
        db: gwB.db,
        configDir: fixture.configDir,
        vault: gwB.vault,
        logger: fakeLogger(),
        ...CAPABILITY_ON,
      });
      expect(reconcileResult).toEqual({
        verified: 1,
        disabled: 0,
        sweptOrphans: 0,
        skipped: false,
      });

      // A BRAND NEW `ToolgenRegistry` populated purely from the signed files on disk and the
      // `generated_tool` row -- `createGeneratedTool`/`saveGeneratedTool` never touched this object.
      await loadSavedToolsIntoRegistry(
        {
          db: gwB.db,
          configDir: fixture.configDir,
          vault: gwB.vault,
          runtime: resolveRuntimeById("bun"),
          ...CAPABILITY_ON,
        },
        gwB.registry,
      );
      expect(gwB.registry.savedTools().map((t) => t.toolId)).toContain(fixture.toolId);

      const row = getSavedTool(gwB.db, fixture.toolId);
      expect(row).not.toBeNull();
      const pubkeyB64 = await gwB.vault.get(TOOLGEN_SIGNING_PUBKEY);
      expect(pubkeyB64).not.toBeNull();
      if (row === null || pubkeyB64 === null) throw new Error("unreachable");

      dialed = "";
      handleB = await spawnSavedTool(
        fixture.toolId,
        buildSavedSpawnDeps(
          gwB,
          fixture.configDir,
          pubkeyB64,
          { approvedAt: row.approvedAt },
          () => resolveRuntimeById("bun").requiredReadPaths(),
          () => {},
        ),
      );

      // The call travels: test -> gateway B's sandboxed child -> `nimbusFetch` -> stdio ->
      // `wireToolProtocol` -> gateway B's OWN `ToolgenBroker` -> the stub server -> back the same
      // way. Nothing in this chain is gateway A's.
      const result = await handleB.call({});
      expect(result).toEqual(STUB_PAYLOAD);
      expect(hits).toBe(1);
      expect(dialed).toBe(`https://${STUB_HOST}/`);
    } finally {
      await handleB?.close();
      gwB?.db.close();
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("REGRESSION: a changed runtime read path does not break a saved tool", () => {
  test("spawning still succeeds when requiredReadPaths() differs from what created the tool", async () => {
    hits = 0;
    dialed = "";
    const fixture = await createAndSaveInGatewayA("read-path-drift");
    // Simulates a Bun upgrade between the save and this later boot: a NEW directory the runtime now
    // says it needs, which the create step (always `resolveRuntimeById("bun")` internally, not
    // injectable there) could never have used. `assertConcreteManifestMatches` would refuse this
    // under the REJECTED design (signing the concrete manifest's `filesystem.read`, which would
    // freeze it at whatever gateway A's create step happened to compute) because the freshly
    // rebuilt manifest's read set would then be compared against that frozen, now-stale one and
    // differ by exactly this directory. Under the SHIPPED design `filesystem.read` was never part
    // of what got signed (`toolgen-portable-manifest.ts`'s `toPortableManifest`), so this has no
    // way to break anything -- which is exactly what this test proves by actually spawning and
    // getting a real answer back.
    const extraDir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-bun-upgrade-"));
    const changedReadPaths = (): readonly string[] => [
      ...resolveRuntimeById("bun").requiredReadPaths(),
      extraDir,
    ];

    let gwB: GatewayHandle | undefined;
    let handleB: GeneratedToolHandle | undefined;
    try {
      gwB = await bootGateway(fixture.dbPath, fixture.vaultStore);
      await reconcileSavedTools({
        db: gwB.db,
        configDir: fixture.configDir,
        vault: gwB.vault,
        logger: fakeLogger(),
        ...CAPABILITY_ON,
      });

      await loadSavedToolsIntoRegistry(
        {
          db: gwB.db,
          configDir: fixture.configDir,
          vault: gwB.vault,
          runtime: { requiredReadPaths: changedReadPaths },
          ...CAPABILITY_ON,
        },
        gwB.registry,
      );
      const envelope = gwB.registry.savedTools().find((t) => t.toolId === fixture.toolId);
      expect(envelope).toBeDefined();
      // The DIFFERENCE actually reached the rebuilt manifest -- otherwise this test could pass for
      // the wrong reason (a `changedReadPaths` that was never actually consulted).
      expect(envelope?.artifact.manifest.permissions.filesystem.read).toContain(extraDir);

      const row = getSavedTool(gwB.db, fixture.toolId);
      const pubkeyB64 = await gwB.vault.get(TOOLGEN_SIGNING_PUBKEY);
      if (row === null || pubkeyB64 === null) throw new Error("unreachable");

      handleB = await spawnSavedTool(
        fixture.toolId,
        buildSavedSpawnDeps(
          gwB,
          fixture.configDir,
          pubkeyB64,
          { approvedAt: row.approvedAt },
          changedReadPaths,
          () => {},
        ),
      );

      const result = await handleB.call({});
      expect(result).toEqual(STUB_PAYLOAD);
      expect(hits).toBe(1);
    } finally {
      await handleB?.close();
      gwB?.db.close();
      rmSync(extraDir, { recursive: true, force: true });
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the saved script never carries a network grant", () => {
  test("the reconstructed manifest's permissions.network is empty after a full save/load round trip", async () => {
    const fixture = await createAndSaveInGatewayA("network-grant");
    let gwB: GatewayHandle | undefined;
    try {
      gwB = await bootGateway(fixture.dbPath, fixture.vaultStore);
      await reconcileSavedTools({
        db: gwB.db,
        configDir: fixture.configDir,
        vault: gwB.vault,
        logger: fakeLogger(),
        ...CAPABILITY_ON,
      });
      await loadSavedToolsIntoRegistry(
        {
          db: gwB.db,
          configDir: fixture.configDir,
          vault: gwB.vault,
          runtime: resolveRuntimeById("bun"),
          ...CAPABILITY_ON,
        },
        gwB.registry,
      );

      const envelope = gwB.registry.savedTools().find((t) => t.toolId === fixture.toolId);
      expect(envelope).toBeDefined();
      // Rebuilt fresh from code in gateway B (`buildGeneratedManifest`), never read back from disk
      // as `permissions` -- I39's "empty by construction" guarantee surviving a full
      // save/reconcile/load round trip, not merely holding at create time.
      expect(envelope?.artifact.manifest.permissions.network).toEqual([]);
      expect(envelope?.artifact.manifest.permissions.filesystem.write).toEqual([]);
    } finally {
      gwB?.db.close();
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }, 30_000);
});
