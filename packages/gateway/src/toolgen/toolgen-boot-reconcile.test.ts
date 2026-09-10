import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  artifactDigest,
  canonicalArtifactBytes,
  digestOfCanonicalBytes,
} from "./toolgen-artifact.ts";
import { reconcileSavedTools, reconcileSavedToolsOrWarn } from "./toolgen-boot-reconcile.ts";
import {
  ensureToolgenKeypair,
  signArtifact,
  TOOLGEN_SIGNING_PRIVKEY,
  TOOLGEN_SIGNING_PUBKEY,
} from "./toolgen-keypair.ts";
import { getSavedTool, insertSavedTool, setSavedToolDisabled } from "./toolgen-saved-repo.ts";
import { savedToolDir, writeSavedTool } from "./toolgen-saved-store.ts";
import { emitToolScript } from "./toolgen-stub.ts";
import type { GeneratedToolArtifact } from "./toolgen-types.ts";

/** Minimal in-memory `NimbusVault` fake — no real Vault/OS keychain involved. */
class FakeVault implements NimbusVault {
  private readonly store = new Map<string, string>();

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
    return [...this.store.keys()].filter((k) => !prefix || k.startsWith(prefix));
  }
}

function fakeLogger(): {
  logger: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  warnCalls: unknown[][];
  infoCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  return {
    logger: {
      warn: (...a: unknown[]) => void warnCalls.push(a),
      info: (...a: unknown[]) => void infoCalls.push(a),
    },
    warnCalls,
    infoCalls,
  };
}

function migratedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-toolgen-boot-reconcile-"));
}

function artifact(
  toolId: string,
  overrides: Partial<GeneratedToolArtifact> = {},
): GeneratedToolArtifact {
  return {
    toolId,
    toolName: `generated_${toolId}`,
    description: "list open PRs",
    body: "export async function run() { return 1; }",
    approvedHosts: ["api.example.com"],
    credentialHosts: [],
    manifest: {
      id: `toolgen.${toolId}`,
      version: "0.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable",
    },
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

/**
 * Signs, writes and rows a saved tool exactly the way `saveGeneratedTool` (the real approval path)
 * does — sign, write the three files, THEN insert the row — without pulling in the full save-gate
 * HITL deps (registry/config/enforced/requestApproval), which this test has no need to drive.
 */
async function createSavedTool(
  db: Database,
  configDir: string,
  vault: NimbusVault,
  toolId: string,
  overrides: Partial<GeneratedToolArtifact> = {},
): Promise<void> {
  const art = artifact(toolId, overrides);
  const canonicalJson = canonicalArtifactBytes(art);
  const digest = artifactDigest(art);
  const { sigB64, pubkeyB64 } = await signArtifact(vault, canonicalJson);
  const script = emitToolScript(art);
  await writeSavedTool(configDir, toolId, { canonicalJson, sigB64, script });
  insertSavedTool(db, {
    toolId,
    toolName: art.toolName,
    description: art.description,
    artifactJson: canonicalJson,
    artifactDigest: digest,
    signature: sigB64,
    pubkey: pubkeyB64,
    approvedAt: 1,
    savedAt: 1,
    lastLoadedAt: null,
    disabledReason: null,
  });
}

function deps(db: Database, configDir: string, vault: NimbusVault) {
  const { logger } = fakeLogger();
  return { db, configDir, vault, logger };
}

describe("reconcileSavedTools — row pass", () => {
  test("a healthy saved tool verifies and stays enabled", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 1, disabled: 0, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
  });

  test("a tampered artifact is disabled with signature_mismatch", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    // Corrupt the exact bytes that were signed — the signature no longer verifies over them.
    writeFileSync(join(savedToolDir(configDir, "t1"), "artifact.json"), "not the signed bytes");

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_mismatch");
  });

  test("a rotated Vault keypair reports pubkey_rotated, NOT signature_mismatch", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    // The artifact and signature on disk are untouched and internally consistent — only the
    // VAULT's current key changes, exactly like an owner resetting their OS keychain.
    await vault.delete(TOOLGEN_SIGNING_PRIVKEY);
    await vault.delete(TOOLGEN_SIGNING_PUBKEY);
    await ensureToolgenKeypair(vault);

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("pubkey_rotated");
  });

  test("distinguishes pubkey_rotated from signature_mismatch — a genuinely tampered artifact under a rotated key still reports signature_mismatch", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    await vault.delete(TOOLGEN_SIGNING_PRIVKEY);
    await vault.delete(TOOLGEN_SIGNING_PUBKEY);
    await ensureToolgenKeypair(vault);
    // On TOP of the rotation, also tamper the row's OWN stored pubkey so it now matches the
    // Vault's current one -- this is the one case the `pubkey_rotated` heuristic cannot cover, and
    // it is correct that it reports `signature_mismatch`: the two keys no longer differ, so from
    // this function's point of view nothing explains the failed verify except tamper.
    const currentPub = await vault.get(TOOLGEN_SIGNING_PUBKEY);
    db.exec(`UPDATE generated_tool SET pubkey = '${currentPub}' WHERE tool_id = 't1'`);

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r.disabled).toBe(1);
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_mismatch");
  });

  test("a missing artifact.json disables with artifact_missing", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    await rm(join(savedToolDir(configDir, "t1"), "artifact.json"));

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("artifact_missing");
  });

  test("the row's cached digest is REPAIRED when disk disagrees but verifies", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    db.exec("UPDATE generated_tool SET artifact_digest = 'stale' WHERE tool_id = 't1'");

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 1, disabled: 0, sweptOrphans: 0 });
    const row = getSavedTool(db, "t1");
    expect(row?.artifactDigest).not.toBe("stale");
    expect(row?.disabledReason).toBeNull();
  });

  test("a previously-disabled tool is RE-ENABLED once its artifact verifies again", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    setSavedToolDisabled(db, "t1", "signature_mismatch");

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 1, disabled: 0, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
  });

  test("an absent Vault pubkey marks every row pubkey_unavailable, not signature_mismatch", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    await vault.delete(TOOLGEN_SIGNING_PRIVKEY);
    await vault.delete(TOOLGEN_SIGNING_PUBKEY);

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("pubkey_unavailable");
  });

  test("does NOT mint a fresh keypair to perform its check — an absent Vault pubkey stays absent", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    await vault.delete(TOOLGEN_SIGNING_PRIVKEY);
    await vault.delete(TOOLGEN_SIGNING_PUBKEY);

    await reconcileSavedTools(deps(db, configDir, vault));

    expect(await vault.get(TOOLGEN_SIGNING_PUBKEY)).toBeNull();
    expect(await vault.get(TOOLGEN_SIGNING_PRIVKEY)).toBeNull();
  });

  test("a missing artifact.sig disables with signature_missing, distinct from a mismatch", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    await rm(join(savedToolDir(configDir, "t1"), "artifact.sig"));

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_missing");
  });

  test("a validly-signed but unparseable artifact disables with schema_invalid — not tamper, wrong shape", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    // Missing `body` entirely -- verifies fine (it is exactly what was signed) but does not parse
    // into `SavedArtifactFields`, the "verifies but wrong shape" case `readVerifiedSavedTool`
    // documents as distinct from tamper.
    const malformedJson = JSON.stringify({
      toolId: "t1",
      toolName: "generated_t1",
      description: "list open PRs",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      inputSchema: { type: "object", properties: {} },
      manifest: {
        id: "toolgen.t1",
        version: "0.0.0",
        updateChannel: "stable",
        network: [],
        filesystemWrite: [],
      },
    });
    const { sigB64, pubkeyB64 } = await signArtifact(vault, malformedJson);
    await writeSavedTool(configDir, "t1", { canonicalJson: malformedJson, sigB64, script: "//" });
    insertSavedTool(db, {
      toolId: "t1",
      toolName: "generated_t1",
      description: "list open PRs",
      artifactJson: malformedJson,
      artifactDigest: digestOfCanonicalBytes(malformedJson),
      signature: sigB64,
      pubkey: pubkeyB64,
      approvedAt: 1,
      savedAt: 1,
      lastLoadedAt: null,
      disabledReason: null,
    });

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 0, disabled: 1, sweptOrphans: 0 });
    expect(getSavedTool(db, "t1")?.disabledReason).toBe("schema_invalid");
  });
});

describe("reconcileSavedTools — orphan sweep", () => {
  test("ORPHAN: a validly-signed saved/ directory with NO row is SWEPT, not adopted", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    // A genuinely, validly signed artifact -- proves the sweep is driven by the missing ROW, never
    // by a failed verification. A softened version of this test (an invalid signature) would pass
    // for the wrong reason.
    const art = artifact("orphan");
    const canonicalJson = canonicalArtifactBytes(art);
    const { sigB64 } = await signArtifact(vault, canonicalJson);
    const script = emitToolScript(art);
    await writeSavedTool(configDir, "orphan", { canonicalJson, sigB64, script });
    expect(existsSync(savedToolDir(configDir, "orphan"))).toBe(true);

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r.sweptOrphans).toBe(1);
    expect(existsSync(savedToolDir(configDir, "orphan"))).toBe(false);
    expect(getSavedTool(db, "orphan")).toBeNull();
  });

  test("a directory WITH a row is never swept, even when its row is disabled", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    writeFileSync(join(savedToolDir(configDir, "t1"), "artifact.json"), "tampered");

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r.sweptOrphans).toBe(0);
    expect(existsSync(savedToolDir(configDir, "t1"))).toBe(true);
    expect(getSavedTool(db, "t1")).not.toBeNull();
  });

  test("a healthy row and an orphan coexist — only the orphan is swept", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const orphanArtifact = artifact("orphan2");
    const orphanCanonical = canonicalArtifactBytes(orphanArtifact);
    const { sigB64: orphanSig } = await signArtifact(vault, orphanCanonical);
    await writeSavedTool(configDir, "orphan2", {
      canonicalJson: orphanCanonical,
      sigB64: orphanSig,
      script: emitToolScript(orphanArtifact),
    });

    const r = await reconcileSavedTools(deps(db, configDir, vault));
    expect(r).toEqual({ verified: 1, disabled: 0, sweptOrphans: 1 });
    expect(existsSync(savedToolDir(configDir, "t1"))).toBe(true);
    expect(existsSync(savedToolDir(configDir, "orphan2"))).toBe(false);
  });
});

describe("reconcileSavedTools spawns nothing", () => {
  test("no child process is spawned via Bun.spawn during a reconcile pass", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    // A validly-signed orphan too, so BOTH passes (row verify + orphan sweep) run over real work.
    const orphanArtifact = artifact("orphan");
    const orphanCanonical = canonicalArtifactBytes(orphanArtifact);
    const { sigB64: orphanSig } = await signArtifact(vault, orphanCanonical);
    await writeSavedTool(configDir, "orphan", {
      canonicalJson: orphanCanonical,
      sigB64: orphanSig,
      script: emitToolScript(orphanArtifact),
    });

    // Monkeypatch the REAL, global spawn channel every generated-tool spawn in this codebase
    // actually uses (`toolgen-client.ts` calls `Bun.spawn` directly) -- not a deps-injected fake
    // nobody in production would call, which would prove nothing but that our own mock was never
    // invoked. If reconciliation ever grew a spawn call through ANY path, this would catch it.
    const originalSpawn = Bun.spawn;
    let spawnCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: monkeypatching a global for a test-only spy
    (Bun as any).spawn = (...args: unknown[]) => {
      spawnCalls++;
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real implementation
      return (originalSpawn as any)(...args);
    };
    try {
      await reconcileSavedTools(deps(db, configDir, vault));
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawnCalls).toBe(0);
  });
});

describe("reconcileSavedToolsOrWarn", () => {
  test("a throwing db does not propagate — it warns instead", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    db.close(); // any subsequent query against a closed db throws

    const { logger, warnCalls } = fakeLogger();
    await expect(
      reconcileSavedToolsOrWarn({ db, configDir, vault, logger }),
    ).resolves.toBeUndefined();

    expect(warnCalls).toHaveLength(1);
    const [meta, message] = warnCalls[0] as [{ err: unknown }, string];
    expect(meta.err).toBeDefined();
    expect(message).toMatch(/toolgen/i);
    expect(message).toMatch(/reconcile/i);
  });

  test("a clean pass logs nothing when there is nothing to warn or sweep", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const { logger, warnCalls, infoCalls } = fakeLogger();

    await reconcileSavedToolsOrWarn({ db, configDir, vault, logger });

    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(0);
  });
});
