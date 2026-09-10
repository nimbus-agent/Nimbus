import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { artifactDigest, canonicalArtifactBytes } from "./toolgen-artifact.ts";
import { reconcileSavedTools } from "./toolgen-boot-reconcile.ts";
import { signArtifact } from "./toolgen-keypair.ts";
import { ToolgenRegistry } from "./toolgen-registry.ts";
import { insertSavedTool } from "./toolgen-saved-repo.ts";
import {
  loadSavedToolsIntoRegistry,
  type SavedSpawnDeps,
  spawnSavedTool,
} from "./toolgen-saved-spawn.ts";
import {
  readVerifiedSavedTool,
  rewriteSavedToolScript,
  savedToolDir,
  writeSavedTool,
} from "./toolgen-saved-store.ts";
import { emitToolScript } from "./toolgen-stub.ts";
import { ERR_TOOLGEN_MANIFEST_SHAPE_INVALID, type GeneratedToolArtifact } from "./toolgen-types.ts";

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

function fakeLogger(): { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } {
  return { warn: () => {}, info: () => {} };
}

function migratedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-toolgen-saved-spawn-"));
}

const RUNTIME_READ_PATHS = ["/opt/bun/bin"];

function defaultManifest(toolId: string): ExtensionManifest {
  return {
    id: `toolgen.${toolId}`,
    version: "0.0.0",
    permissions: { network: [], filesystem: { read: [], write: [] } },
    updateChannel: "stable",
  };
}

function artifact(
  toolId: string,
  overrides: Partial<GeneratedToolArtifact> = {},
): GeneratedToolArtifact {
  return {
    toolId,
    toolName: `generated_${toolId}`,
    description: "list open PRs",
    body: "return { ok: true, marker: 'APPROVED_BODY_MARKER' };",
    approvedHosts: ["api.example.com"],
    credentialHosts: [],
    manifest: defaultManifest(toolId),
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

/**
 * Signs, writes and rows a saved tool exactly the way `saveGeneratedTool` (the real approval path)
 * does — sign, write the three files, THEN insert the row — mirroring
 * `toolgen-boot-reconcile.test.ts`'s identically-named helper.
 */
async function createSavedTool(
  db: Database,
  configDir: string,
  vault: NimbusVault,
  toolId: string,
  overrides: Partial<GeneratedToolArtifact> = {},
  approvedAt = 1,
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
    approvedAt,
    savedAt: approvedAt,
    lastLoadedAt: null,
    disabledReason: null,
  });
}

interface FakeHandle {
  describe(): Promise<never>;
  call(): Promise<never>;
  close(): Promise<void>;
}

/** Records every envelope `spawn` was asked to launch, without ever touching `Bun.spawn`. */
function fakeSpawn(): {
  spawn: SavedSpawnDeps["spawn"];
  calls: Parameters<SavedSpawnDeps["spawn"]>[0][];
} {
  const calls: Parameters<SavedSpawnDeps["spawn"]>[0][] = [];
  return {
    calls,
    spawn: async (envelope) => {
      calls.push(envelope);
      const handle: FakeHandle = {
        describe: () => Promise.reject(new Error("not used in this test")),
        call: () => Promise.reject(new Error("not used in this test")),
        close: async () => {},
      };
      return handle;
    },
  };
}

async function buildSpawnDeps(
  configDir: string,
  vault: NimbusVault,
  overrides: Partial<SavedSpawnDeps> = {},
): Promise<{ deps: SavedSpawnDeps; calls: Parameters<SavedSpawnDeps["spawn"]>[0][] }> {
  const pubkeyB64 = (await vault.get("toolgen.signing.pubkey")) ?? "";
  const { spawn, calls } = fakeSpawn();
  return {
    calls,
    deps: {
      configDir,
      pubkeyB64,
      sessionId: "caller-session",
      row: { approvedAt: 12345 },
      runtime: { requiredReadPaths: () => RUNTIME_READ_PATHS },
      readVerifiedSavedTool,
      savedToolDir,
      rewriteSavedToolScript,
      spawn,
      ...overrides,
    },
  };
}

describe("spawnSavedTool", () => {
  test("spawns a healthy saved tool, handing the CONCRETE manifest (with permissions) to spawn", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const { deps, calls } = await buildSpawnDeps(configDir, vault);

    await spawnSavedTool("t1", deps);

    expect(calls).toHaveLength(1);
    const envelope = calls[0];
    if (envelope === undefined) throw new Error("expected one spawn call");
    // The PORTABLE manifest (what's signed) has no `permissions` at all -- if this were handed to
    // `buildToolSpawnSpec` unchanged, `wrapServerSpec` would be configured from `undefined`.
    expect(envelope.artifact.manifest.permissions).toBeDefined();
    expect(envelope.artifact.manifest.permissions.network).toEqual([]);
  });

  test("the spawned envelope carries the CALLER's session, never a smuggled sentinel", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const { deps, calls } = await buildSpawnDeps(configDir, vault, { sessionId: "session-xyz" });

    await spawnSavedTool("t1", deps);

    expect(calls[0]?.sessionId).toBe("session-xyz");
    expect(calls[0]?.sessionId).not.toBe("saved");
  });

  test("approvedAt comes from the generated_tool ROW, never a fabricated now()", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1", {}, 999_888_777);
    const { deps, calls } = await buildSpawnDeps(configDir, vault, {
      row: { approvedAt: 999_888_777 },
    });

    const before = Date.now();
    await spawnSavedTool("t1", deps);

    // Pins the exact row value, not merely "some plausible number" -- a `?? now()` fallback would
    // also produce a plausible-looking number here (the current time), so the assertion has to name
    // the row's OWN value and prove it did NOT drift to "now".
    expect(calls[0]?.approvedAt).toBe(999_888_777);
    expect(calls[0]?.approvedAt).toBeLessThan(before);
  });

  test("spawn re-verifies: a tool tampered with AFTER a green boot reconcile still refuses at spawn", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");

    // Green at boot -- proves the tool was healthy a moment ago.
    const bootResult = await reconcileSavedTools({
      db,
      configDir,
      vault,
      logger: fakeLogger(),
    });
    expect(bootResult).toEqual({ verified: 1, disabled: 0, sweptOrphans: 0 });

    // Tampered AFTER boot verified it -- this is the case the boot pass, by design, cannot catch:
    // it already ran and will not run again until the next restart.
    writeFileSync(join(savedToolDir(configDir, "t1"), "artifact.json"), "not the signed bytes");

    const { deps, calls } = await buildSpawnDeps(configDir, vault);
    await expect(spawnSavedTool("t1", deps)).rejects.toMatchObject({
      code: "ERR_TOOLGEN_SIGNATURE_INVALID",
    });
    // Nothing spawned -- the refusal happened before `deps.spawn` was ever reached.
    expect(calls).toHaveLength(0);
  });

  test("spawn rebuilds index.ts from the VERIFIED body, so a tampered index.ts never executes", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    writeFileSync(join(savedToolDir(configDir, "t1"), "index.ts"), "throw new Error('malicious')");

    const { deps } = await buildSpawnDeps(configDir, vault);
    const handle = await spawnSavedTool("t1", deps);
    void handle; // the fake handle carries no scriptPath -- read it back independently below

    const scriptPath = join(savedToolDir(configDir, "t1"), "index.ts");
    const written = await readFile(scriptPath, "utf8");
    expect(written).not.toContain("malicious");
    // Proves the OVERWRITE happened with the approved body, not merely that the malicious text is
    // gone -- a script that overwrote with something else entirely would also pass the line above.
    expect(written).toContain("APPROVED_BODY_MARKER");
  });

  test("spawn asserts the reconstructed manifest against the signed shape", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    // A signed artifact whose manifest illegitimately claims a network grant -- `buildGeneratedTool`
    // could never produce this in production (network is `[]` by construction there), but a signed
    // artifact carrying one is exactly the shape `assertConcreteManifestMatches` exists to catch: a
    // reconstruction that trusted the signed manifest's permissions wholesale, instead of rebuilding
    // them from code and merely checking the read set, would spawn a networked sandbox.
    const tamperedManifest: ExtensionManifest = {
      ...defaultManifest("t1"),
      permissions: { network: ["evil.example.com"], filesystem: { read: [], write: [] } },
    };
    await createSavedTool(db, configDir, vault, "t1", { manifest: tamperedManifest });

    const { deps, calls } = await buildSpawnDeps(configDir, vault);
    await expect(spawnSavedTool("t1", deps)).rejects.toMatchObject({
      code: ERR_TOOLGEN_MANIFEST_SHAPE_INVALID,
    });
    expect(calls).toHaveLength(0);
  });

  test("an unknown toolId refuses with ERR_TOOLGEN_SIGNATURE_INVALID, the same as a missing artifact", async () => {
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    const { deps } = await buildSpawnDeps(configDir, vault);

    await expect(spawnSavedTool("never-saved", deps)).rejects.toMatchObject({
      code: "ERR_TOOLGEN_SIGNATURE_INVALID",
    });
  });
});

describe("loadSavedToolsIntoRegistry", () => {
  function loadDeps(db: Database, configDir: string, vault: NimbusVault) {
    return { db, configDir, vault, runtime: { requiredReadPaths: () => RUNTIME_READ_PATHS } };
  }

  test("a healthy saved tool becomes visible to every session via forSession", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const registry = new ToolgenRegistry();

    await loadSavedToolsIntoRegistry(loadDeps(db, configDir, vault), registry);

    expect(registry.forSession("some-session").map((e) => e.artifact.toolId)).toContain("t1");
    // Loading is VISIBILITY only -- it must never spend the session creation budget.
    expect(registry.countForSession("some-session")).toBe(0);
  });

  test("needsCredentials reflects a non-empty credentialHosts", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "with_creds", {
      credentialHosts: ["api.example.com"],
    });
    await createSavedTool(db, configDir, vault, "no_creds", { credentialHosts: [] });
    const registry = new ToolgenRegistry();

    await loadSavedToolsIntoRegistry(loadDeps(db, configDir, vault), registry);

    const withCreds = registry.savedTools().find((t) => t.toolId === "with_creds");
    const noCreds = registry.savedTools().find((t) => t.toolId === "no_creds");
    expect(withCreds?.needsCredentials).toBe(true);
    expect(noCreds?.needsCredentials).toBe(false);
  });

  test("a tool failing verification is ABSENT, not present-and-erroring", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    writeFileSync(join(savedToolDir(configDir, "t1"), "artifact.json"), "tampered");
    const registry = new ToolgenRegistry();

    await loadSavedToolsIntoRegistry(loadDeps(db, configDir, vault), registry);

    expect(registry.savedTools()).toEqual([]);
    expect(registry.forSession("any")).toEqual([]);
  });

  test("an absent Vault pubkey loads nothing, rather than throwing", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault(); // never signed anything -- no pubkey exists
    insertSavedTool(db, {
      toolId: "orphan-row",
      toolName: "generated_orphan-row",
      description: "d",
      artifactJson: "{}",
      artifactDigest: "d",
      signature: "s",
      pubkey: "p",
      approvedAt: 1,
      savedAt: 1,
      lastLoadedAt: null,
      disabledReason: null,
    });
    const registry = new ToolgenRegistry();

    await expect(
      loadSavedToolsIntoRegistry(loadDeps(db, configDir, vault), registry),
    ).resolves.toBeUndefined();
    expect(registry.savedTools()).toEqual([]);
  });

  test("spawns no child process while loading", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "t1");
    const registry = new ToolgenRegistry();

    const originalSpawn = Bun.spawn;
    let spawnCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: monkeypatching a global for a test-only spy
    (Bun as any).spawn = (...args: unknown[]) => {
      spawnCalls++;
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real implementation
      return (originalSpawn as any)(...args);
    };
    try {
      await loadSavedToolsIntoRegistry(loadDeps(db, configDir, vault), registry);
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawnCalls).toBe(0);
  });
});
