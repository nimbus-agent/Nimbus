/**
 * `invokeSavedTool` (`toolgen-invoke-gate.ts`, Tasks 1-3) against REAL SQLite, REAL Ed25519
 * signing/verification and a REAL confined spawn -- the harness is `toolgen-saved-spawn.test.ts`'s,
 * reused rather than reinvented (its own docstring explains why a second signing/Vault/migration
 * harness is how the two drift).
 *
 * Two things this file proves that no unit test can:
 *
 * 1. The happy path's audit row survives a REAL `appendAuditEntry` against a fully migrated
 *    `audit_log`, including the BLAKE3 hash chain accepting it -- unit tests assert the row against
 *    an injected sink, never the real table.
 *
 * 2. A REAL tampered-artifact signature failure throws `ToolgenError(ERR_TOOLGEN_SIGNATURE_INVALID)`
 *    from `spawnSavedTool`, and `invokeSavedTool` maps THAT real throw to `refused` with that code.
 *    Tamper refusal is already covered at two lower layers -- `toolgen-saved-store.test.ts`'s "a
 *    tampered artifact.json is refused" and `toolgen-saved-spawn.test.ts` -- and Task 1 separately
 *    unit-tests that a `ToolgenError` thrown by a STUBBED `spawn` maps to `refused` rather than
 *    `failed`. What none of those prove is the JOIN between the two: that a real signature failure
 *    actually throws the `ToolgenError` shape the mapping assumes, rather than some other error the
 *    gate would misclassify as `failed`. That is the [[fakes-cant-catch-contract-mismatch]] shape --
 *    a fake on either side alone cannot catch a mismatch between what one side throws and what the
 *    other expects.
 *
 * The tamper happens AFTER the tool is already loaded into the registry (not before, and not by
 * skipping reconcile) -- deliberately, so the registry lookup inside `invokeSavedTool` succeeds and
 * the signature check that actually fires is `spawnSavedTool`'s own THIRD verification point
 * ("immediately before every spawn", I40), not the boot-time one. Tampering before load would make
 * `loadSavedToolsIntoRegistry` skip the tool entirely, and `invokeSavedTool` would then refuse with
 * `ERR_TOOLGEN_NOT_SAVED` from its own registry-lookup check -- a real refusal, but the wrong one,
 * and not the join this test exists to prove.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../../../src/config/nimbus-toml.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { resolveRuntimeById } from "../../../src/exec/exec-runtimes.ts";
import { CURRENT_SCHEMA_VERSION, type LocalIndex } from "../../../src/index/local-index.ts";
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
import {
  invokeSavedTool,
  type ToolgenInvokeDeps,
} from "../../../src/toolgen/toolgen-invoke-gate.ts";
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
import {
  CLI_TOOLGEN_SESSION_ID,
  type CreateGeneratedToolRequest,
  type ToolgenEnvelope,
} from "../../../src/toolgen/toolgen-types.ts";
import type { NimbusVault } from "../../../src/vault/nimbus-vault.ts";

// Same override, same reason as `toolgen-saved-spawn.test.ts`: the sandbox runner probes at
// construction, under `bun test`, before this repo's own `src-native` build is on PATH.
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const CAPABILITY_ON = {
  config: { enabled: true },
  enforced: { capabilitiesDisabled: new Set<string>() },
} as const;

const STUB_HOST = "api.example.com";
const STUB_PAYLOAD = { ok: true, value: 7 };

let server: ReturnType<typeof Bun.serve> | undefined;

function ensureServer(): ReturnType<typeof Bun.serve> {
  if (server === undefined) {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(STUB_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
  }
  return server;
}

const fakeGenerate = async (_prompt: string): Promise<DraftGeneration | null> => ({
  text: JSON.stringify({
    inputSchema: { type: "object", properties: {} },
    body: `const res = await nimbusFetch("https://${STUB_HOST}/", { method: "GET" }); return JSON.parse(res.body);`,
  }),
  isLocal: true,
});

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
    doFetch: async (_url, init) => fetch(`http://127.0.0.1:${srv.port}/`, init),
  });
}

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

/** The production shape of `platform/assemble.ts`'s `toolgenInvokeDeps.spawn`, reproduced against
 * this harness's test doubles rather than the real Vault/broker. */
function buildInvokeSpawn(
  gw: GatewayHandle,
  configDir: string,
): (toolId: string) => Promise<GeneratedToolHandle> {
  return async (toolId) => {
    const pubkeyB64 = await gw.vault.get(TOOLGEN_SIGNING_PUBKEY);
    if (pubkeyB64 === null) {
      throw new Error("test setup: signing pubkey missing from vault");
    }
    const row = getSavedTool(gw.db, toolId);
    if (row === null) {
      throw new Error(`test setup: no generated_tool row for "${toolId}"`);
    }
    const savedSpawnDeps: SavedSpawnDeps = {
      configDir,
      pubkeyB64,
      sessionId: CLI_TOOLGEN_SESSION_ID,
      row: { approvedAt: row.approvedAt },
      runtime: { requiredReadPaths: () => resolveRuntimeById("bun").requiredReadPaths() },
      readVerifiedSavedTool,
      savedToolDir,
      rewriteSavedToolScript,
      spawn: (envelope) =>
        spawnConfined(envelope, gw.broker, dirname(envelope.scriptPath), () =>
          gw.registry.markTerminated(envelope.artifact.toolId),
        ),
    };
    return spawnSavedTool(toolId, savedSpawnDeps);
  };
}

function buildInvokeDeps(gw: GatewayHandle, configDir: string): ToolgenInvokeDeps {
  return {
    ...CAPABILITY_ON,
    registry: gw.registry,
    spawn: buildInvokeSpawn(gw, configDir),
    audit: (entry) => appendAuditEntry(gw.db, entry),
    now: () => Date.now(),
  };
}

interface SavedFixture {
  readonly configDir: string;
  readonly dbPath: string;
  readonly vaultStore: Map<string, string>;
  readonly toolId: string;
}

/** Create+save in "gateway A", full shutdown, matching `toolgen-saved-spawn.test.ts`'s identical
 * helper -- see this file's own docstring for the reuse rationale. */
async function createAndSaveInGatewayA(dirTag: string): Promise<SavedFixture> {
  const configDir = mkdtempSync(join(tmpdir(), `nimbus-toolgen-run-e2e-${dirTag}-`));
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
    await handle?.close();
    await gw.registry.revokeAll();
    gw.db.close();
  }
}

/** Verifies the whole `audit_log` chain from genesis, over the raw test DB -- the same "thin
 * `LocalIndex` view (only `rawDb` is read)" cast `share-create-denied.integration.test.ts` uses. */
function chainOk(db: Database): boolean {
  return verifyAuditChain({ rawDb: db } as unknown as LocalIndex, { fromId: 0 }).ok;
}

describe("invokeSavedTool against a real gateway B: happy path", () => {
  test("save in gateway A, invoke in gateway B: real result AND exactly one real tool.invoke audit row", async () => {
    const fixture = await createAndSaveInGatewayA("happy");
    let gwB: GatewayHandle | undefined;
    try {
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

      // `audit_log` already carries gateway A's own `tool.generate`/`tool.save` rows (the same db
      // FILE is reopened, exactly as a real restart would reopen it) -- so what this test proves
      // is that no `tool.invoke` row exists YET, not that the table is empty.
      const before = gwB.db
        .query("SELECT COUNT(*) as n FROM audit_log WHERE action_type = 'tool.invoke'")
        .get() as { n: number };
      expect(before.n).toBe(0);

      const outcome = await invokeSavedTool(
        { toolId: fixture.toolId, input: {}, sessionId: CLI_TOOLGEN_SESSION_ID },
        buildInvokeDeps(gwB, fixture.configDir),
      );
      expect(outcome.status).toBe("executed");
      if (outcome.status === "executed") {
        expect(outcome.result).toEqual(STUB_PAYLOAD);
      }
      // `invokeSavedTool` closes its own handle internally in a `finally` -- nothing here holds
      // a live process to close.

      // Real INSERT against the real, migrated audit_log -- proving the row survives
      // `appendAuditEntry`, not an injected sink. Scoped to `tool.invoke`: the table also holds
      // gateway A's own `tool.generate`/`tool.save` rows from the fixture setup above.
      const rows = gwB.db
        .query(
          "SELECT action_type, hitl_status, session_id, action_json FROM audit_log WHERE action_type = 'tool.invoke'",
        )
        .all() as Array<{
        action_type: string;
        hitl_status: string;
        session_id: string | null;
        action_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action_type).toBe("tool.invoke");
      expect(rows[0]?.hitl_status).toBe("not_required");
      expect(rows[0]?.session_id).toBe(CLI_TOOLGEN_SESSION_ID);
      const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
      expect(parsed["outcome"]).toBe("executed");
      expect(parsed["toolId"]).toBe(fixture.toolId);

      // The BLAKE3 chain accepts the appended row -- not merely that an INSERT succeeded.
      expect(chainOk(gwB.db)).toBe(true);
    } finally {
      gwB?.db.close();
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("invokeSavedTool against a real gateway B: tampered artifact", () => {
  test("a REAL post-load signature failure is refused with ERR_TOOLGEN_SIGNATURE_INVALID, not misclassified as failed", async () => {
    const fixture = await createAndSaveInGatewayA("tampered");
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
      // Loaded clean BEFORE the tamper -- the registry lookup inside `invokeSavedTool` must
      // succeed, so the refusal that fires is `spawnSavedTool`'s own real, third verification
      // point, not `invokeSavedTool`'s earlier `ERR_TOOLGEN_NOT_SAVED` registry-miss check.
      expect(gwB.registry.savedTools().map((t) => t.toolId)).toContain(fixture.toolId);

      const artifactPath = join(savedToolDir(fixture.configDir, fixture.toolId), "artifact.json");
      const original = readFileSync(artifactPath, "utf8");
      writeFileSync(artifactPath, `${original} `);

      const outcome = await invokeSavedTool(
        { toolId: fixture.toolId, input: {}, sessionId: CLI_TOOLGEN_SESSION_ID },
        buildInvokeDeps(gwB, fixture.configDir),
      );
      // The code, not merely the status: a gate that started refusing for an unrelated reason
      // would still pass an assertion that checked `status === "refused"` alone.
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.code).toBe("ERR_TOOLGEN_SIGNATURE_INVALID");
      }

      // The refusal's own audit row -- distinguishing THIS join from `failed`, which is what a
      // misclassified real signature error would have written instead. Scoped to `tool.invoke`:
      // the table also holds gateway A's own `tool.generate`/`tool.save` rows.
      const rows = gwB.db
        .query("SELECT action_type, action_json FROM audit_log WHERE action_type = 'tool.invoke'")
        .all() as Array<{
        action_type: string;
        action_json: string;
      }>;
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
      expect(parsed["outcome"]).toBe("refused");
      expect(parsed["code"]).toBe("ERR_TOOLGEN_SIGNATURE_INVALID");
    } finally {
      gwB?.db.close();
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }, 30_000);
});
