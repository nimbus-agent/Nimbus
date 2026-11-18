import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildGeneratedTools } from "./toolgen-agent-tools.ts";
import { artifactDigest, canonicalArtifactBytes } from "./toolgen-artifact.ts";
import { signArtifact } from "./toolgen-keypair.ts";
import { type SavedToolEnvelope, ToolgenRegistry } from "./toolgen-registry.ts";
import { insertSavedTool } from "./toolgen-saved-repo.ts";
import { loadSavedToolsIntoRegistry } from "./toolgen-saved-spawn.ts";
import { savedToolDir, writeSavedTool } from "./toolgen-saved-store.ts";
import { emitToolScript } from "./toolgen-stub.ts";

const wrap = <T>(_service: string, _tool: string, def: T): T => def;

import type { GeneratedToolArtifact } from "./toolgen-types.ts";

function savedEnv(toolId: string): SavedToolEnvelope {
  return {
    toolId,
    needsCredentials: false,
    artifact: {
      toolId,
      toolName: toolId,
      description: "d",
      body: "b",
      approvedHosts: [],
      credentialHosts: [],
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        updateChannel: "stable",
      },
      inputSchema: { type: "object", properties: {} },
    },
  };
}

const describe_ = (e: SavedToolEnvelope): string => `desc:${e.toolId}`;

describe("buildGeneratedTools", () => {
  test("contributes NOTHING when nothing is offered", () => {
    expect(buildGeneratedTools([], async () => null, wrap, describe_)).toEqual({});
  });

  test("I11 — every generated tool passes through the envelope wrapper", () => {
    const wrapped: string[] = [];
    const spy = <T>(service: string, tool: string, def: T): T => {
      wrapped.push(`${service}:${tool}`);
      return def;
    };
    buildGeneratedTools([savedEnv("tg_a")], async () => null, spy, describe_);
    // A generated tool returns a remote API response straight into the model's context. If this
    // ever passes vacuously, an external server can address the agent directly.
    expect(wrapped).toEqual(["toolgen:tg_a"]);
  });

  test("offers exactly the listed tools, under the door's description", () => {
    const tools = buildGeneratedTools(
      [savedEnv("a"), savedEnv("b")],
      async () => null,
      wrap,
      describe_,
    ) as Record<string, { description: string }>;
    expect(Object.keys(tools)).toEqual(["a", "b"]);
    expect(tools["a"]?.description).toBe("desc:a");
  });

  test("execute goes through the injected invoke, never a spawn of its own", async () => {
    const calls: Array<[string, unknown]> = [];
    const base = savedEnv("a");
    const withQ: SavedToolEnvelope = {
      ...base,
      artifact: {
        ...base.artifact,
        inputSchema: { type: "object", properties: { q: { type: "number" } } },
      },
    };
    const tools = buildGeneratedTools(
      [withQ],
      async (id, args) => {
        calls.push([id, args]);
        return { ok: true };
      },
      wrap,
      describe_,
    ) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    expect(await tools["a"]?.execute({ q: 1 })).toEqual({ ok: true });
    expect(calls).toEqual([["a", { q: 1 }]]);
  });

  test("a generated tool advertises its approved parameters, not a passthrough schema", () => {
    const base = savedEnv("t1");
    const withSchema: SavedToolEnvelope = {
      ...base,
      artifact: {
        ...base.artifact,
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string" } },
          required: ["owner"],
        },
      },
    };
    const tools = buildGeneratedTools([withSchema], async () => ({}), wrap, describe_);
    const tool = (
      tools as Record<string, { inputSchema: { safeParse(v: unknown): { success: boolean } } }>
    )["t1"];
    if (tool === undefined) throw new Error("expected tool t1 to be registered");
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ owner: "nimbus" }).success).toBe(true);
  });

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

  function migratedDb(): Database {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    return db;
  }

  function tmpConfigDir(): string {
    return mkdtempSync(join(tmpdir(), "nimbus-toolgen-agent-tools-"));
  }

  function fixtureArtifact(toolId: string): GeneratedToolArtifact {
    return {
      toolId,
      toolName: toolId,
      description: "d",
      body: "return 1;",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        updateChannel: "stable",
      },
      inputSchema: { type: "object", properties: {} },
    };
  }

  /** Signs, writes and rows a saved tool exactly the way the real approval path does — same
   * helper shape as `toolgen-boot-reconcile.test.ts` / `toolgen-saved-spawn.test.ts`. */
  async function createSavedTool(
    db: Database,
    configDir: string,
    vault: NimbusVault,
    toolId: string,
  ): Promise<void> {
    const art = fixtureArtifact(toolId);
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

  // Decision 7, asserted at THIS layer (the brief's own wording: "assert that... since it is the
  // surface the model actually sees"), not one layer down at the registry. A tool whose saved
  // artifact fails verification must never reach `loadSavedToolsIntoRegistry`'s `registerSaved`
  // call at all, so it can never appear in `forSession`'s output for `buildGeneratedTools` to
  // surface -- proven here end-to-end through the REAL load path, not by calling `registerSaved`
  // for a healthy tool and reasoning that a failing one would have skipped that call.
  test("a saved tool that fails verification is ABSENT from the model surface, not present-and-erroring", async () => {
    const db = migratedDb();
    const configDir = tmpConfigDir();
    const vault = new FakeVault();
    await createSavedTool(db, configDir, vault, "broken");
    // Tamper AFTER signing -- the signature no longer verifies over these bytes.
    writeFileSync(join(savedToolDir(configDir, "broken"), "artifact.json"), "not the signed bytes");

    const registry = new ToolgenRegistry();
    await loadSavedToolsIntoRegistry(
      {
        db,
        configDir,
        vault,
        runtime: { requiredReadPaths: () => [] },
        config: { enabled: true },
        enforced: { capabilitiesDisabled: new Set<string>() },
      },
      registry,
    );

    // The registry's own state: `registerSaved` was never reached for "broken".
    expect(registry.savedTools().map((t) => t.toolId)).not.toContain("broken");
    // The surface the model actually sees: `buildGeneratedTools` never gets a chance to surface
    // (or error on) a tool that was never registered in the first place. This would fail if
    // `buildGeneratedTools` started surfacing a registered-but-broken tool, or if
    // `loadSavedToolsIntoRegistry` ever registered one that failed verification.
    expect(
      Object.keys(buildGeneratedTools(registry.savedTools(), async () => null, wrap, describe_)),
    ).not.toContain("broken");
  });
});
