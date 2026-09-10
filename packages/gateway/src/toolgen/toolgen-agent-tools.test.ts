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

import type { GeneratedToolArtifact, ToolgenEnvelope } from "./toolgen-types.ts";

/**
 * `ToolgenRegistry.forSession` filters by exact session-id match, so a registry holding only "s1"
 * would ALSO return `[]` for `forSession(undefined)` even if `buildGeneratedTools`'s own
 * `sessionId === undefined` guard were deleted -- asserting on the output alone can't tell "refused
 * before ever asking the registry" from "asked, and happened to get nothing back". This subclass
 * counts calls so the undefined-session test below can pin down the guard itself, not the
 * registry's incidentally-correct filtering.
 */
class CountingRegistry extends ToolgenRegistry {
  forSessionCalls = 0;
  override forSession(sessionId: string): Array<ToolgenEnvelope | SavedToolEnvelope> {
    this.forSessionCalls += 1;
    return super.forSession(sessionId);
  }
}

function env(toolId: string, sessionId: string): ToolgenEnvelope {
  return {
    sessionId,
    scriptPath: "/tmp",
    approvedAt: 1,
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

describe("buildGeneratedTools", () => {
  test("contributes NOTHING when the session holds no generated tool", () => {
    expect(buildGeneratedTools("s1", new ToolgenRegistry(), async () => null, wrap)).toEqual({});
  });

  test("contributes NOTHING for an undefined session, without ever consulting the registry", () => {
    const r = new CountingRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    expect(buildGeneratedTools(undefined, r, async () => null, wrap)).toEqual({});
    expect(r.forSessionCalls).toBe(0);
  });

  test("exposes only the CURRENT session's tools", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.register(env("tg_b", "s2"), async () => {});
    expect(Object.keys(buildGeneratedTools("s1", r, async () => null, wrap))).toEqual(["tg_a"]);
  });

  test("a terminated tool disappears from the surface", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.markTerminated("tg_a");
    expect(buildGeneratedTools("s1", r, async () => null, wrap)).toEqual({});
  });

  test("I11 — every generated tool passes through the envelope wrapper", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    const wrapped: string[] = [];
    const spy = <T>(service: string, tool: string, def: T): T => {
      wrapped.push(`${service}:${tool}`);
      return def;
    };
    buildGeneratedTools("s1", r, async () => null, spy);
    // A generated tool returns a remote API response straight into the model's context. If this
    // ever passes vacuously, an external server can address the agent directly.
    expect(wrapped).toEqual(["toolgen:tg_a"]);
  });

  test("a generated tool advertises its approved parameters, not a passthrough schema", () => {
    const schema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const registry = {
      forSession: () => [{ artifact: { toolId: "t1", description: "d", inputSchema: schema } }],
    };
    const tools = buildGeneratedTools(
      "s1",
      registry as never,
      async () => ({}),
      (_s, _t, def) => def,
    );
    const tool = (
      tools as Record<string, { inputSchema: { safeParse(v: unknown): { success: boolean } } }>
    )["t1"];
    if (tool === undefined) throw new Error("expected tool t1 to be registered");
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ owner: "nimbus" }).success).toBe(true);
  });

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

  // The interface note this task's plan carries: "buildGeneratedTools needs no change if
  // forSession unions -- but assert that, since it is the surface the model sees." This is that
  // assertion: no code in this file changed for a saved tool to reach the model, because
  // `buildGeneratedTools` only ever destructures `.artifact` off whatever `forSession` returns.
  test("a SAVED tool is offered to a session that never created it, exactly like an ephemeral one", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnv("saved_a"));
    expect(
      Object.keys(buildGeneratedTools("some-other-session", r, async () => null, wrap)),
    ).toEqual(["saved_a"]);
  });

  test("ephemeral and saved tools coexist on the model surface without one shadowing the other", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.registerSaved(savedEnv("saved_b"));
    expect(Object.keys(buildGeneratedTools("s1", r, async () => null, wrap)).sort()).toEqual([
      "saved_b",
      "tg_a",
    ]);
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
      Object.keys(buildGeneratedTools("any-session", registry, async () => null, wrap)),
    ).not.toContain("broken");
  });
});
