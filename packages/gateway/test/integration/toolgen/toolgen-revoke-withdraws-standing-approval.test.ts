import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchToolgenRpc, type ToolgenRpcCtx } from "../../../src/ipc/toolgen-rpc.ts";
import { reconcileSavedTools } from "../../../src/toolgen/toolgen-boot-reconcile.ts";
import {
  deleteCredentialsForTool,
  toolCredentialKey,
} from "../../../src/toolgen/toolgen-credentials.ts";
import {
  TOOLGEN_SIGNING_PRIVKEY,
  TOOLGEN_SIGNING_PUBKEY,
} from "../../../src/toolgen/toolgen-keypair.ts";
import { ToolgenRegistry } from "../../../src/toolgen/toolgen-registry.ts";
import { saveGeneratedTool, type ToolgenSaveDeps } from "../../../src/toolgen/toolgen-save-gate.ts";
import { getSavedTool, listSavedTools } from "../../../src/toolgen/toolgen-saved-repo.ts";
import { loadSavedToolsIntoRegistry } from "../../../src/toolgen/toolgen-saved-spawn.ts";
import { removeSavedTool, savedToolDir } from "../../../src/toolgen/toolgen-saved-store.ts";
import { removeToolScript } from "../../../src/toolgen/toolgen-script-store.ts";
import type { GeneratedToolArtifact, ToolgenEnvelope } from "../../../src/toolgen/toolgen-types.ts";
import type { NimbusVault } from "../../../src/vault/nimbus-vault.ts";

/**
 * `nimbus tool revoke` is the WITHDRAWAL PATH for this codebase's first standing approval (I40).
 * The save prompt (`packages/cli/src/commands/tool.ts`'s `formatToolSaveApprovalPrompt`) tells the
 * owner in as many words that an approved tool "will run, unattended, in every future gateway
 * session until you `nimbus tool revoke` it" — and that sentence is what obtains the consent, so
 * it has to be true.
 *
 * It was not. Revoke ran three steps, all of which touched only the EPHEMERAL halves:
 * `registry.revoke` (the `#byId` map; a saved tool lives in `#saved`), `removeScript`
 * (`toolgen/ephemeral/<toolId>`, never `saved/`), and `revokeCredentialsForTool`. The
 * `generated_tool` row and the `saved/<toolId>` directory both survived, so the next boot
 * reconciled the tool healthy and loaded it straight back into model visibility.
 *
 * This suite proves the fix over the REAL pieces rather than fakes of them: a real migrated
 * SQLite database on disk, a real `saved/<toolId>` directory written by the real save gate over a
 * real Ed25519 signature, the real `toolgen.revoke` RPC handler, and then a SECOND gateway boot —
 * its own `Database` handle over the same file, its own `ToolgenRegistry` — running the real
 * `reconcileSavedTools` + `loadSavedToolsIntoRegistry` passes. Nothing about "the tool does not
 * come back" is asserted against a call counter.
 *
 * It deliberately spawns NOTHING: no child process, no sandbox helper, no `bun` subprocess. The
 * property under test is about durable state and boot reconciliation, and a suite that needed the
 * git-ignored `nimbus-sandbox-helper` build to answer it would be a suite that quietly stops
 * answering it on a fresh worktree.
 */

/** In-memory `NimbusVault` fake — the OS keychain does not belong to a test. */
class FakeVault implements NimbusVault {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix));
  }
}

const tmpDirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-revoke-"));
  tmpDirs.push(dir);
  return dir;
}

/** A file-backed database, so a SECOND `Database` handle over the same path is a genuine second
 * gateway process's view of the same durable state rather than the same in-memory object. */
function openDb(configDir: string, migrate: boolean): Database {
  const db = new Database(join(configDir, "nimbus.db"));
  if (migrate) runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return db;
}

function artifact(toolId: string): GeneratedToolArtifact {
  return {
    toolId,
    toolName: `generated_${toolId}`,
    description: "list open PRs",
    body: "export async function run() { return 1; }",
    approvedHosts: ["api.example.com"],
    credentialHosts: ["api.example.com"],
    manifest: {
      id: `toolgen.${toolId}`,
      version: "0.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable",
    },
    inputSchema: { type: "object", properties: {} },
  };
}

function envelope(toolId: string): ToolgenEnvelope {
  return {
    artifact: artifact(toolId),
    sessionId: "s1",
    scriptPath: join("unused", "index.ts"),
    approvedAt: 1_700_000_000_000,
  };
}

const CAPABILITY_ON = {
  config: { enabled: true },
  enforced: { capabilitiesDisabled: new Set<string>() },
} as const;

function saveDeps(
  db: Database,
  configDir: string,
  vault: NimbusVault,
  registry: ToolgenRegistry,
): ToolgenSaveDeps {
  return {
    db,
    configDir,
    config: { enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry,
    vault,
    // The owner says yes. The consent BROKER is exercised by `toolgen-rpc.test.ts`; what this
    // suite is about is what happens to the durable state afterwards.
    requestApproval: async () => true,
    now: () => 1_700_000_000_000,
  };
}

function rpcCtx(
  db: Database,
  configDir: string,
  vault: NimbusVault,
  registry: ToolgenRegistry,
): ToolgenRpcCtx {
  const deps = saveDeps(db, configDir, vault, registry);
  return {
    // `toolgen.revoke` reaches only `gateDeps.registry`, `gateDeps.db` and the three injected
    // closures, so the rest of `ToolgenGateDeps` is not constructed here — supplying a fake
    // `draftTool`/`spawn`/`assertConfinement` would be inventing wiring this path never touches.
    gateDeps: { db, registry } as unknown as ToolgenRpcCtx["gateDeps"],
    consent: undefined as unknown as ToolgenRpcCtx["consent"],
    saveConsent: undefined as unknown as ToolgenRpcCtx["saveConsent"],
    saveDeps: deps,
    // The REAL production closures, bound exactly as `platform/assemble.ts` binds them.
    removeScript: (toolId) => removeToolScript(configDir, toolId),
    removeSavedDir: (toolId) => removeSavedTool(configDir, toolId),
    revokeCredentialsForTool: (toolId) => deleteCredentialsForTool(vault, toolId),
  };
}

/** A second gateway boot over the same durable state: fresh handle, fresh registry, the two real
 * boot passes in the order `platform/assemble.ts` runs them. */
async function rebootAndLoad(
  configDir: string,
  vault: NimbusVault,
): Promise<{ registry: ToolgenRegistry; db: Database }> {
  const db = openDb(configDir, false);
  await reconcileSavedTools({
    db,
    configDir,
    vault,
    logger: { warn: () => {}, info: () => {} },
    ...CAPABILITY_ON,
  });
  const registry = new ToolgenRegistry();
  await loadSavedToolsIntoRegistry(
    { db, configDir, vault, runtime: { requiredReadPaths: () => [] }, ...CAPABILITY_ON },
    registry,
  );
  return { registry, db };
}

describe("toolgen.revoke withdraws a standing approval", () => {
  test("a saved tool does NOT come back after a revoke + reboot", async () => {
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    const db = openDb(configDir, true);
    const registry = new ToolgenRegistry();
    registry.register(envelope("tg_saved"), async () => {});

    const saved = await saveGeneratedTool(
      { toolId: "tg_saved" },
      saveDeps(db, configDir, vault, registry),
    );
    expect(saved).toEqual({ status: "saved", toolId: "tg_saved" });

    // Premise check: WITHOUT the revoke, a reboot brings the tool straight back. Without this the
    // assertion below would pass for any reason at all -- a save that silently failed included.
    const before = await rebootAndLoad(configDir, vault);
    expect(before.registry.savedTools().map((t) => t.toolId)).toEqual(["tg_saved"]);

    const out = await dispatchToolgenRpc(
      "toolgen.revoke",
      { toolId: "tg_saved" },
      rpcCtx(db, configDir, vault, registry),
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");

    // All three durable halves are gone: the row, the directory, and the in-memory saved entry.
    expect(getSavedTool(db, "tg_saved")).toBeNull();
    expect(existsSync(savedToolDir(configDir, "tg_saved"))).toBe(false);
    expect(registry.savedTools()).toEqual([]);

    // And the property that actually matters: a SECOND gateway boot -- its own database handle,
    // its own registry, the real reconcile + load passes -- does not resurrect it. Against the
    // pre-fix handler these lines fail: the row and the directory both survived, reconciliation
    // verified them green, and the tool was loaded back into model visibility.
    const after = await rebootAndLoad(configDir, vault);
    expect(after.registry.savedTools()).toEqual([]);
    expect(after.registry.forSession("any-session")).toEqual([]);
    expect(listSavedTools(after.db)).toEqual([]);

    // The DISCLOSURE, asserted last so a regression reds on the substance above first rather than
    // on the field that merely reports it.
    expect(out.value).toEqual({ revoked: true, savedRemoved: true });
  });

  test("revoke also drops the saved tool's per-host Vault credential", async () => {
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    const db = openDb(configDir, true);
    const registry = new ToolgenRegistry();
    registry.register(envelope("tg_cred"), async () => {});
    await saveGeneratedTool({ toolId: "tg_cred" }, saveDeps(db, configDir, vault, registry));

    const key = toolCredentialKey("tg_cred", "api.example.com");
    await vault.set(key, JSON.stringify({ type: "bearer", token: "t" }));

    await dispatchToolgenRpc(
      "toolgen.revoke",
      { toolId: "tg_cred" },
      rpcCtx(db, configDir, vault, registry),
    );

    expect(await vault.get(key)).toBeNull();
    // The signing keypair is untouched -- without it every OTHER saved tool on the machine would
    // be permanently unverifiable. Written before the revoke by `signArtifact` during the save.
    expect(await vault.get(TOOLGEN_SIGNING_PRIVKEY)).not.toBeNull();
    expect(await vault.get(TOOLGEN_SIGNING_PUBKEY)).not.toBeNull();
  });

  test("revoke is idempotent, and works for a tool that is saved-only", async () => {
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    const db = openDb(configDir, true);
    const registry = new ToolgenRegistry();
    registry.register(envelope("tg_once"), async () => {});
    await saveGeneratedTool({ toolId: "tg_once" }, saveDeps(db, configDir, vault, registry));

    // A fresh registry with NO ephemeral entry and NO loaded saved entry: the "saved on disk, but
    // this process never loaded it" case -- exactly the tool an owner is most likely to revoke,
    // since a tool that failed verification at load is absent from the registry entirely.
    const coldRegistry = new ToolgenRegistry();
    const ctx = rpcCtx(db, configDir, vault, coldRegistry);

    const first = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_once" }, ctx);
    if (first.kind !== "hit") throw new Error("unreachable");
    // `savedRemoved` is derived from the ROW, not from registry membership, so it is honest even
    // when the registry never held the tool.
    expect(first.value).toEqual({ revoked: true, savedRemoved: true });

    const second = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_once" }, ctx);
    if (second.kind !== "hit") throw new Error("unreachable");
    expect(second.value).toEqual({ revoked: true, savedRemoved: false });
    expect(existsSync(savedToolDir(configDir, "tg_once"))).toBe(false);
  });

  test("revoking an ephemeral-only tool leaves the saved store alone", async () => {
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    const db = openDb(configDir, true);
    const registry = new ToolgenRegistry();
    registry.register(envelope("tg_keep"), async () => {});
    await saveGeneratedTool({ toolId: "tg_keep" }, saveDeps(db, configDir, vault, registry));

    // A DIFFERENT tool, ephemeral only.
    let closed = false;
    registry.register(envelope("tg_eph"), async () => {
      closed = true;
    });

    const out = await dispatchToolgenRpc(
      "toolgen.revoke",
      { toolId: "tg_eph" },
      rpcCtx(db, configDir, vault, registry),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: false });
    expect(closed).toBe(true);

    // The saved neighbour is untouched -- a prefix/path mistake in the new drops would show here.
    expect(getSavedTool(db, "tg_keep")).not.toBeNull();
    expect(existsSync(savedToolDir(configDir, "tg_keep"))).toBe(true);
  });
});
