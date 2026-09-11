import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  ToolgenConsentBroker,
  ToolgenSaveConsentBroker,
} from "../toolgen/toolgen-consent-broker.ts";
import { deleteCredentialsForTool, writeToolCredential } from "../toolgen/toolgen-credentials.ts";
import type { ToolgenGateDeps } from "../toolgen/toolgen-gate.ts";
import { type SavedToolEnvelope, ToolgenRegistry } from "../toolgen/toolgen-registry.ts";
import type { ToolgenSaveDeps } from "../toolgen/toolgen-save-gate.ts";
import { getSavedTool, insertSavedTool } from "../toolgen/toolgen-saved-repo.ts";
import { removeSavedTool, savedToolDir } from "../toolgen/toolgen-saved-store.ts";
import {
  ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN,
  ERR_TOOLGEN_TOOL_ID_INVALID,
  ERR_TOOLGEN_TOOL_ID_RESERVED,
  type ToolgenEnvelope,
  ToolgenError,
} from "../toolgen/toolgen-types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import { dispatchToolgenRpc, type ToolgenRpcCtx } from "./toolgen-rpc.ts";

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

describe("toolgen is LAN-forbidden as a WHOLE namespace", () => {
  test.each([
    ["toolgen.create"],
    ["toolgen.approvalRespond"],
    ["toolgen.list"],
    ["toolgen.revoke"],
    ["toolgen.save"],
    ["toolgen.saveApprovalRespond"],
    ["toolgen.credentialSet"],
  ])("%s is refused over LAN", (method) => {
    expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });
});

const brokers: ToolgenConsentBroker[] = [];
const saveBrokers: ToolgenSaveConsentBroker[] = [];
// Pending approvals hold live TTL timers; without this, a test that leaves one pending hangs
// `bun test` teardown on Windows (the same trap `exec-rpc.test.ts` guards against).
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
  for (const b of saveBrokers.splice(0)) b.clear();
});

function makeEnvelope(toolId: string, sessionId: string): ToolgenEnvelope {
  return {
    sessionId,
    scriptPath: "/tmp/tg/index.ts",
    approvedAt: 1,
    artifact: {
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
    },
  };
}

/** A HEALTHY saved (persisted) tool, as the registry's `#saved` collection holds it. */
function makeSavedEnvelope(
  toolId: string,
  opts: { credentialHosts?: string[] } = {},
): SavedToolEnvelope {
  const credentialHosts = opts.credentialHosts ?? [];
  return {
    toolId,
    needsCredentials: credentialHosts.length > 0,
    artifact: {
      toolId,
      toolName: `generated_${toolId}`,
      description: "a saved tool",
      body: "return 1;",
      approvedHosts: ["api.example.com"],
      credentialHosts,
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

/**
 * A `generated_tool` DB row -- the health-report half of `toolgen.list`'s saved listing.
 * `artifactJson` is a valid, parseable canonical artifact by default (so a test that leaves the
 * row HEALTHY still exercises `toSavedListEntry`'s fallback parse path meaningfully), but callers
 * asserting on a `disabledReason` never register the matching `SavedToolEnvelope`, mirroring a
 * tool that failed verification and was skipped by `loadSavedToolsIntoRegistry`.
 */
function insertGeneratedToolRow(
  db: Database,
  toolId: string,
  over: Partial<Parameters<typeof insertSavedTool>[1]> = {},
): void {
  insertSavedTool(db, {
    toolId,
    toolName: `generated_${toolId}`,
    description: "a saved tool",
    artifactJson: JSON.stringify({
      toolId,
      toolName: `generated_${toolId}`,
      description: "a saved tool",
      body: "return 1;",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      inputSchema: { type: "object", properties: {} },
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        updateChannel: "stable",
        network: [],
        filesystemWrite: [],
      },
    }),
    artifactDigest: "deadbeef",
    signature: "sig",
    pubkey: "pub",
    approvedAt: 1,
    savedAt: 1,
    lastLoadedAt: null,
    disabledReason: null,
    ...over,
  });
}

interface TestCtx extends ToolgenRpcCtx {
  broadcasts: Array<Record<string, unknown>>;
  /** Mirrors `broadcasts` above, but for the SEPARATE save broker -- see `saveConsent`'s docstring
   * on `ToolgenRpcCtx` for why the two must never be conflated. */
  saveBroadcasts: Array<Record<string, unknown>>;
  removeScriptCalls: string[];
  /** Backs the default `revokeCredentialsForTool` -- a REAL Vault, not a call-count stub, so the
   * "the credential is actually gone" tests exercise `deleteCredentialsForTool` for real rather
   * than trusting a mock that only records it was asked. */
  vault: NimbusVault;
  revokeCredentialsForToolCalls: string[];
  /** The temp dir `saveDeps.configDir` points at, so a test can assert `saved/<toolId>` is really
   * gone from disk after a revoke rather than trusting a call counter. */
  configDir: string;
  removeSavedDirCalls: string[];
}

function makeCtx(
  over: Partial<ToolgenGateDeps> = {},
  saveOver: Partial<ToolgenSaveDeps> = {},
): TestCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const consent = new ToolgenConsentBroker();
  brokers.push(consent);
  const broadcasts: Array<Record<string, unknown>> = [];
  consent.setBroadcast((_m, params) => {
    broadcasts.push(params as Record<string, unknown>);
  });
  const saveConsent = new ToolgenSaveConsentBroker();
  saveBrokers.push(saveConsent);
  const saveBroadcasts: Array<Record<string, unknown>> = [];
  saveConsent.setBroadcast((_m, params) => {
    saveBroadcasts.push(params as Record<string, unknown>);
  });
  const registry = new ToolgenRegistry();
  const removeScriptCalls: string[] = [];
  const vault = new FakeVault();
  const revokeCredentialsForToolCalls: string[] = [];
  const removeSavedDirCalls: string[] = [];
  const configDir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-rpc-"));
  return {
    consent,
    saveConsent,
    broadcasts,
    saveBroadcasts,
    removeScriptCalls,
    vault,
    revokeCredentialsForToolCalls,
    configDir,
    removeSavedDirCalls,
    removeScript: async (toolId: string) => {
      removeScriptCalls.push(toolId);
    },
    // The REAL `removeSavedTool`, against the REAL temp `configDir` -- not a call-count stub. A
    // stub here would let "revoke drops the saved directory" pass while the directory survived,
    // which is exactly the class of defect this wiring exists to close.
    removeSavedDir: async (toolId: string) => {
      removeSavedDirCalls.push(toolId);
      await removeSavedTool(configDir, toolId);
    },
    revokeCredentialsForTool: async (toolId: string) => {
      revokeCredentialsForToolCalls.push(toolId);
      await deleteCredentialsForTool(vault, toolId);
    },
    gateDeps: {
      db,
      config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: true },
      enforced: { capabilitiesDisabled: new Set<string>() },
      registry,
      draftTool: async () => ({
        body: "return 1;",
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "description_only" },
        attempts: 1,
        locality: "local",
      }),
      assertConfinement: async () => {},
      scriptDir: () => "/tmp/tg",
      writeScript: async () => "/tmp/tg/index.ts",
      spawn: async () => ({
        describe: async () => ({
          name: "t",
          description: "d",
          inputSchema: { type: "object", properties: {} },
        }),
        call: async () => null,
        close: async () => {},
      }),
      // Route through the broker so the RPC pair is exercised end to end, not stubbed out.
      requestApproval: (input, ttlMs) => consent.request(input, ttlMs),
      bindCredentials: async () => [],
      revokeCredentials: async () => {},
      now: () => 1_700_000_000_000,
      newId: () => "tg_a",
      ...over,
    },
    saveDeps: {
      db,
      configDir,
      config: { enabled: true },
      enforced: { capabilitiesDisabled: new Set<string>() },
      registry,
      vault,
      // Route through the SAVE broker, never `consent` -- this is the property fix round 1's
      // review item exists to protect: if this line ever reads `consent.request` instead, every
      // test in this file still passes (each injects its own stub), which is exactly why a
      // dedicated test below asserts the WIRE METHOD NAME a save prompt actually broadcasts under.
      requestApproval: (input, ttlMs) => saveConsent.request(input, ttlMs),
      now: () => 1_700_000_000_000,
      ...saveOver,
    },
  };
}

describe("toolgen RPC", () => {
  test("an unknown toolgen.* method MISSES rather than throwing", async () => {
    const out = await dispatchToolgenRpc("toolgen.nope", {}, makeCtx());
    expect(out.kind).toBe("miss");
  });

  test("toolgen.create reaches the gate and returns its outcome", async () => {
    const ctx = makeCtx({ config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: false } });
    const out = await dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: ["api.example.com"] },
      ctx,
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("refused");
  });

  test("toolgen.create without sessionId is an invalid-params error, not a silent default", async () => {
    await expect(
      dispatchToolgenRpc(
        "toolgen.create",
        { description: "d", hosts: ["api.example.com"] },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  test("toolgen.create without description is an invalid-params error", async () => {
    await expect(
      dispatchToolgenRpc(
        "toolgen.create",
        { sessionId: "s1", hosts: ["a.example.com"] },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  test("a non-array hosts value is treated as an empty list, refused by the gate itself", async () => {
    const out = await dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: "api.example.com" },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ status: "refused", code: "ERR_TOOLGEN_HOST_NOT_ALLOWED" });
  });

  test("toolgen.approvalRespond resolves the pending approval the broker broadcast", async () => {
    const ctx = makeCtx();
    const run = dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: ["api.example.com"] },
      ctx,
    );
    // Let the gate reach the consent step and broadcast.
    await Bun.sleep(1);
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    expect(typeof requestId).toBe("string");

    const resp = await dispatchToolgenRpc(
      "toolgen.approvalRespond",
      { requestId, approved: false },
      ctx,
    );
    if (resp.kind !== "hit") throw new Error("unreachable");
    expect((resp.value as { matched: boolean }).matched).toBe(true);

    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("toolgen.approvalRespond reports no match for an unknown requestId", async () => {
    const out = await dispatchToolgenRpc(
      "toolgen.approvalRespond",
      { requestId: "nope", approved: true },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { matched: boolean }).matched).toBe(false);
  });

  test("approved defaults to FALSE when the field is absent or non-boolean", async () => {
    // Fail-closed: a malformed respond payload must never read as approval.
    const ctx = makeCtx();
    const run = dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: ["api.example.com"] },
      ctx,
    );
    await Bun.sleep(1);
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    await dispatchToolgenRpc("toolgen.approvalRespond", { requestId, approved: "yes" }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("toolgen.list returns only the CURRENT session's live tools", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("tg_a", "s1"), async () => {});
    ctx.gateDeps.registry.register(makeEnvelope("tg_b", "s2"), async () => {});
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<{ toolId: string }> }).tools;
    expect(tools.map((t) => t.toolId)).toEqual(["tg_a"]);
  });

  test("toolgen.list omits the body/manifest/scriptPath", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("tg_a", "s1"), async () => {});
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools[0]).not.toHaveProperty("body");
    expect(tools[0]).not.toHaveProperty("manifest");
    expect(tools[0]).not.toHaveProperty("scriptPath");
  });

  test("toolgen.list without sessionId is an invalid-params error", async () => {
    await expect(dispatchToolgenRpc("toolgen.list", {}, makeCtx())).rejects.toThrow();
  });

  test("an ephemeral entry reports saved:false, needsCredentials:false, disabledReason:null", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("tg_a", "s1"), async () => {});
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools[0]).toMatchObject({
      saved: false,
      needsCredentials: false,
      disabledReason: null,
    });
  });

  test("toolgen.list includes saved tools regardless of the caller's sessionId", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("tg_saved"));
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_saved");
    // A caller whose session neither created nor saved this tool still sees it -- a saved tool is
    // visible from EVERY session (spec § 7.2), unlike the ephemeral half of the listing.
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "some-other-session" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    const entry = tools.find((t) => t["toolId"] === "tg_saved");
    expect(entry).toMatchObject({ saved: true, disabledReason: null });
  });

  test("toolgen.list surfaces a DISABLED saved tool's reason even though it failed verification and is absent from the registry", async () => {
    const ctx = makeCtx();
    // Deliberately NOT `registerSaved` -- mirrors a tool that failed verification at boot and was
    // therefore skipped by `loadSavedToolsIntoRegistry` (absent from the registry entirely), yet
    // its `generated_tool` row still exists and still carries a `disabledReason`.
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_broken", { disabledReason: "signature_mismatch" });
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    const entry = tools.find((t) => t["toolId"] === "tg_broken");
    expect(entry).toMatchObject({ saved: true, disabledReason: "signature_mismatch" });
  });

  test("toolgen.list reports needsCredentials for a healthy saved tool with a credentialed host", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.registerSaved(
      makeSavedEnvelope("tg_cred", { credentialHosts: ["api.example.com"] }),
    );
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_cred");
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    const entry = tools.find((t) => t["toolId"] === "tg_cred");
    expect(entry).toMatchObject({ saved: true, needsCredentials: true });
  });

  // Task 10 carried-forward item 5: `ToolgenRegistry.forSession` can return an ephemeral AND a
  // saved entry sharing a `toolId`, and `toolgen.list`'s union now surfaces both rather than one
  // silently shadowing the other. Fixed round 1: the mechanism is NOT "create then save in the
  // same session" -- `saveGeneratedTool` never calls `registry.registerSaved()`; the only
  // production caller is `loadSavedToolsIntoRegistry` (`toolgen-saved-spawn.ts`), run once at
  // boot, so a same-session save does not enter the in-memory saved collection at all, and by the
  // next boot the ephemeral map is gone anyway. The only production route to this state is a
  // freshly minted `randomUUID()` (`toolgen-gate.ts`'s `newId`) for a BRAND-NEW ephemeral tool
  // colliding with an id a PREVIOUS boot persisted and THIS boot loaded -- a probability
  // indistinguishable from zero, and unrelated to any create/save sequencing. This test is a
  // regression guard on `toolgen.list`'s union behaviour (should a future change make the save
  // gate register synchronously, this documents what the listing would then show), not a
  // realistic scenario. See the Task 10 report for why this is not this task's to fix.
  test("a toolId live as BOTH an ephemeral tool and an already-saved tool produces two list entries (known collision, not resolved here)", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("dup", "s1"), async () => {});
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("dup"));
    insertGeneratedToolRow(ctx.gateDeps.db, "dup");
    const out = await dispatchToolgenRpc("toolgen.list", { sessionId: "s1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    const tools = (out.value as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.filter((t) => t["toolId"] === "dup")).toHaveLength(2);
  });

  test("toolgen.revoke drops THREE things: the live registry entry, the on-disk script, and the Vault credential", async () => {
    const ctx = makeCtx();
    let closed = false;
    ctx.gateDeps.registry.register(makeEnvelope("tg_a", "s1"), async () => {
      closed = true;
    });
    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_a" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: false });
    expect(closed).toBe(true);
    expect(ctx.gateDeps.registry.get("tg_a")).toBeUndefined();
    // The failure worth catching: a drain that clears the registry but leaves the script behind
    // looks identical to success unless this call is independently asserted.
    expect(ctx.removeScriptCalls).toEqual(["tg_a"]);
    expect(ctx.revokeCredentialsForToolCalls).toEqual(["tg_a"]);
  });

  // This is the defect Task 5 exists to close. `toolgen.revoke` used to drop only the live child
  // and the on-disk script -- the Vault binding outlived both, keyed to a toolId nothing would
  // ever call again. Reverting the `revokeCredentialsForTool` call in `toolgen-rpc.ts`'s handler
  // reproduces the failure this test proves is fixed.
  test("toolgen.revoke deletes the Vault credential, not just the child and the script", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("t1", "s1"), async () => {});
    await writeToolCredential(ctx.vault, "t1", "api.example.com", {
      type: "bearer",
      token: "s3cret",
    });
    expect(await ctx.vault.get("toolgen.t1.api_pexample_pcom")).not.toBeNull();

    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "t1" }, ctx);

    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: false });
    expect(await ctx.vault.get("toolgen.t1.api_pexample_pcom")).toBeNull();
  });

  // The prefix-based delete (not a host-list delete resolved from the registry envelope) is what
  // makes this pass: a credential for a host no longer in the tool's CURRENT envelope is still
  // deleted, because it shares the tool's `toolgen.<toolId>.` prefix regardless of what the
  // envelope says today.
  test("toolgen.revoke also deletes a credential for a host outside the tool's current envelope", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("t1", "s1"), async () => {});
    await writeToolCredential(ctx.vault, "t1", "stale.example.com", {
      type: "bearer",
      token: "old",
    });

    await dispatchToolgenRpc("toolgen.revoke", { toolId: "t1" }, ctx);

    expect(await ctx.vault.get("toolgen.t1.stale_pexample_pcom")).toBeNull();
  });

  test("toolgen.revoke on an unknown toolId still calls removeScript (idempotent, no probe-first)", async () => {
    const ctx = makeCtx();
    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_ghost" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: false });
    expect(ctx.removeScriptCalls).toEqual(["tg_ghost"]);
    expect(ctx.revokeCredentialsForToolCalls).toEqual(["tg_ghost"]);
    // The saved drop is attempted unconditionally too -- probing first would make a saved tool
    // that failed verification (and is therefore absent from the registry) unrevokable.
    expect(ctx.removeSavedDirCalls).toEqual(["tg_ghost"]);
  });

  // The withdrawal path for this codebase's FIRST standing approval. The save prompt tells the
  // owner the tool runs unattended in every future session "until you `nimbus tool revoke` it";
  // before this, revoke touched only the ephemeral halves and the tool came back at the next boot.
  // End-to-end proof over a real database, a real `saved/` directory and a real second boot lives
  // in `test/integration/toolgen/toolgen-revoke-withdraws-standing-approval.test.ts`.
  test("toolgen.revoke drops the generated_tool ROW and evicts the registry's saved entry", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("tg_saved"));
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_saved");

    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_saved" }, ctx);

    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: true });
    expect(getSavedTool(ctx.gateDeps.db, "tg_saved")).toBeNull();
    expect(ctx.gateDeps.registry.savedTools()).toEqual([]);
    // Model visibility is gone THIS session, not merely after a restart.
    expect(ctx.gateDeps.registry.forSession("s1")).toEqual([]);
    expect(ctx.removeSavedDirCalls).toEqual(["tg_saved"]);
  });

  test("toolgen.revoke deletes the saved DIRECTORY from disk, not just the row", async () => {
    const ctx = makeCtx();
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_dir");
    // A real directory, removed by the real `removeSavedTool` the ctx is wired to -- a call
    // counter alone would pass while the files survived.
    await Bun.write(join(savedToolDir(ctx.configDir, "tg_dir"), "artifact.json"), "{}");
    expect(
      await Bun.file(join(savedToolDir(ctx.configDir, "tg_dir"), "artifact.json")).exists(),
    ).toBe(true);

    await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_dir" }, ctx);

    expect(
      await Bun.file(join(savedToolDir(ctx.configDir, "tg_dir"), "artifact.json")).exists(),
    ).toBe(false);
  });

  test("toolgen.revoke reports savedRemoved for a row the registry never loaded", async () => {
    // The tool most likely to be revoked: saved on disk, but skipped at load because it failed
    // verification, so it is absent from `#saved` entirely. Deriving the disclosure from registry
    // membership alone would report `false` here and read as "there was nothing to revoke".
    const ctx = makeCtx();
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_broken", { disabledReason: "signature_mismatch" });

    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_broken" }, ctx);

    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true, savedRemoved: true });
    expect(getSavedTool(ctx.gateDeps.db, "tg_broken")).toBeNull();
  });

  test("toolgen.revoke leaves a NEIGHBOURING saved tool completely alone", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("keep"));
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("drop"));
    insertGeneratedToolRow(ctx.gateDeps.db, "keep");
    insertGeneratedToolRow(ctx.gateDeps.db, "drop");

    await dispatchToolgenRpc("toolgen.revoke", { toolId: "drop" }, ctx);

    expect(getSavedTool(ctx.gateDeps.db, "keep")).not.toBeNull();
    expect(ctx.gateDeps.registry.savedTools().map((t) => t.toolId)).toEqual(["keep"]);
  });

  // The handler's docstring has always claimed the drops are "all attempted unconditionally". A
  // sequential `await` chain does not deliver that, and the gap bit hardest exactly where the
  // ordering is most deliberate: the `generated_tool` ROW is deleted BEFORE `removeSavedDir` runs,
  // so a rejection there -- a locked `saved/<toolId>/index.ts` on Windows is the realistic
  // trigger -- skipped BOTH remaining drops, leaving every `toolgen.<toolId>.*` Vault credential
  // in the OS keychain with no row left to show anything was outstanding, after a revoke the owner
  // was told had completed. Replacing the handler's `drop()` isolation with a plain `await` chain
  // reproduces it: `revokeCredentialsForToolCalls` comes back empty.
  test("toolgen.revoke still drops the script and the Vault credentials when removeSavedDir REJECTS", async () => {
    const base = makeCtx();
    const ctx: TestCtx = {
      ...base,
      removeSavedDir: async (toolId: string) => {
        base.removeSavedDirCalls.push(toolId);
        throw new Error("EBUSY: saved/tg_locked/index.ts is locked by another process");
      },
    };
    ctx.gateDeps.registry.registerSaved(makeSavedEnvelope("tg_locked"));
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_locked");
    await writeToolCredential(ctx.vault, "tg_locked", "api.example.com", {
      type: "bearer",
      token: "s3cret",
    });

    // Still surfaced, not swallowed: reporting a clean withdrawal that did not happen would be a
    // worse defect than the one this test covers.
    await expect(
      dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_locked" }, ctx),
    ).rejects.toThrow("EBUSY");

    expect(ctx.removeSavedDirCalls).toEqual(["tg_locked"]);
    // The point of the fix: the two drops AFTER the failing one still ran, and the credential is
    // really gone from the Vault -- not merely requested via a call counter.
    expect(ctx.removeScriptCalls).toEqual(["tg_locked"]);
    expect(ctx.revokeCredentialsForToolCalls).toEqual(["tg_locked"]);
    expect(await ctx.vault.get("toolgen.tg_locked.api_pexample_pcom")).toBeNull();
    // And the drops BEFORE it are unaffected -- the row is gone, so nothing is left claiming the
    // standing approval still stands.
    expect(getSavedTool(ctx.gateDeps.db, "tg_locked")).toBeNull();
    expect(ctx.gateDeps.registry.savedTools()).toEqual([]);
  });

  // Failure at the very FIRST drop, plus a second failure later, so this pins two things at once:
  // every later drop still runs, and the error the caller sees is the FIRST one (the diagnosis),
  // not whichever happened to fail last.
  test("toolgen.revoke attempts every drop when the FIRST one rejects, and surfaces the first failure", async () => {
    const base = makeCtx();
    const ctx: TestCtx = {
      ...base,
      removeSavedDir: async (toolId: string) => {
        base.removeSavedDirCalls.push(toolId);
        throw new Error("second-failure");
      },
    };
    // A live child whose close() rejects -- `ToolgenRegistry.revoke` awaits it, so this is drop 1
    // rejecting for real rather than a stubbed registry.
    ctx.gateDeps.registry.register(makeEnvelope("tg_first", "s1"), async () => {
      throw new Error("first-failure: child would not close");
    });
    insertGeneratedToolRow(ctx.gateDeps.db, "tg_first");
    await writeToolCredential(ctx.vault, "tg_first", "api.example.com", {
      type: "bearer",
      token: "s3cret",
    });

    await expect(dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_first" }, ctx)).rejects.toThrow(
      "first-failure",
    );

    expect(getSavedTool(ctx.gateDeps.db, "tg_first")).toBeNull();
    expect(ctx.removeSavedDirCalls).toEqual(["tg_first"]);
    expect(ctx.removeScriptCalls).toEqual(["tg_first"]);
    expect(ctx.revokeCredentialsForToolCalls).toEqual(["tg_first"]);
    expect(await ctx.vault.get("toolgen.tg_first.api_pexample_pcom")).toBeNull();
  });

  // `deleteCredentialsForTool` deletes `toolgen.<toolId>.*` by PREFIX, and `signing` is a
  // well-formed tool id whose prefix is byte-for-byte the artifact-signing keypair's. Losing that
  // keypair makes every saved tool on the machine permanently `pubkey_unavailable` -- and, before
  // the revoke fix above, unclearable as well. Two independent checks: this boundary refusal, and
  // the prefix exclusion inside `deleteCredentialsForTool` itself
  // (`toolgen-credentials.test.ts`), so neither one alone carries the keyspace.
  test("toolgen.revoke REFUSES the reserved `signing` tool id and touches no Vault key", async () => {
    const ctx = makeCtx();
    await ctx.vault.set("toolgen.signing.privkey", "priv-seed");
    await ctx.vault.set("toolgen.signing.pubkey", "pub-key");

    await expect(dispatchToolgenRpc("toolgen.revoke", { toolId: "signing" }, ctx)).rejects.toThrow(
      ToolgenError,
    );

    expect(await ctx.vault.get("toolgen.signing.privkey")).toBe("priv-seed");
    expect(await ctx.vault.get("toolgen.signing.pubkey")).toBe("pub-key");
    // Refused BEFORE anything ran -- not "ran and happened to skip the keys".
    expect(ctx.revokeCredentialsForToolCalls).toEqual([]);
    expect(ctx.removeScriptCalls).toEqual([]);
    expect(ctx.removeSavedDirCalls).toEqual([]);
  });

  test("the `signing` refusal carries its own named code, distinct from a malformed id", async () => {
    const ctx = makeCtx();
    // Callers branch on `.code`, never on message text (`ToolgenError`'s docstring).
    await expect(
      dispatchToolgenRpc("toolgen.revoke", { toolId: "signing" }, ctx),
    ).rejects.toMatchObject({ code: ERR_TOOLGEN_TOOL_ID_RESERVED });
    await expect(
      dispatchToolgenRpc("toolgen.revoke", { toolId: "../../etc/passwd" }, ctx),
    ).rejects.toMatchObject({ code: ERR_TOOLGEN_TOOL_ID_INVALID });
  });

  test("toolgen.credentialSet refuses the reserved id too, before composing a Vault key", async () => {
    // `toolgen.credentialSet` is the OTHER method whose caller-supplied id becomes part of a Vault
    // key. Its `credentialHosts` membership check already fails closed for an unknown tool, but
    // that puts the keyspace boundary two steps away from the string that addresses it.
    const ctx = makeCtx();
    await expect(
      dispatchToolgenRpc(
        "toolgen.credentialSet",
        { toolId: "signing", host: "privkey", binding: { type: "bearer", token: "t" } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: ERR_TOOLGEN_TOOL_ID_RESERVED });
  });

  test("toolgen.revoke without toolId is an invalid-params error", async () => {
    await expect(dispatchToolgenRpc("toolgen.revoke", {}, makeCtx())).rejects.toThrow();
  });

  // `createGeneratedTool` is a hard import in `toolgen-rpc.ts`, not an injectable dep on
  // `ToolgenRpcCtx`/`ToolgenGateDeps` -- there is no `create` closure to intercept the way the
  // brief's `fakeCtx({ create: ... })` sketch assumes. `bindCredentials` is the gate dependency
  // that receives the parsed, per-host bearer bindings (step 7 of `createGeneratedTool`, BEFORE
  // consent), so overriding it is what actually observes "parsed and forwarded as the third
  // argument" without reaching into the gate's internals.
  test("toolgen.create parses credentials and forwards them as bearer bindings before consent", async () => {
    const bound: Array<[string, unknown]> = [];
    const ctx = makeCtx({
      bindCredentials: async (toolId, credentials) => {
        bound.push([toolId, credentials]);
        return [];
      },
    });
    const run = dispatchToolgenRpc(
      "toolgen.create",
      {
        sessionId: "s1",
        description: "d",
        hosts: ["api.github.com"],
        credentials: [{ host: "api.github.com", token: "s3cret" }],
      },
      ctx,
    );
    // Let the gate reach `bindCredentials` (step 7, before consent) and the approval broadcast.
    await Bun.sleep(1);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.[1]).toEqual([
      { host: "api.github.com", binding: { type: "bearer", token: "s3cret" } },
    ]);
    // Deny so the pending approval settles rather than leaking a dangling promise into the next test.
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    await dispatchToolgenRpc("toolgen.approvalRespond", { requestId, approved: false }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("toolgen.create drops a malformed credential entry rather than throwing", async () => {
    const bound: unknown[] = [];
    const ctx = makeCtx({
      bindCredentials: async (_toolId, credentials) => {
        bound.push(credentials);
        return [];
      },
    });
    const run = dispatchToolgenRpc(
      "toolgen.create",
      {
        sessionId: "s1",
        description: "d",
        hosts: ["api.github.com"],
        credentials: [
          { host: "api.github.com" }, // missing token
          { host: "api.github.com", token: 42 }, // wrong type
          { token: "s3cret" }, // missing host
          "not-an-object",
          null,
          { host: "api.github.com", token: "s3cret" }, // the one valid entry
        ],
      },
      ctx,
    );
    await Bun.sleep(1);
    // Every malformed entry dropped, the one valid entry kept -- no throw reached this far.
    expect(bound).toEqual([
      [{ host: "api.github.com", binding: { type: "bearer", token: "s3cret" } }],
    ]);
    const requestId = ctx.broadcasts[0]?.["requestId"] as string;
    await dispatchToolgenRpc("toolgen.approvalRespond", { requestId, approved: false }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  // Fix round 1 on Task 10: `toolgen.create`'s handler returns `createGeneratedTool(...)`'s
  // outcome WHOLE (it is never reconstructed field by field here), so the newly-optional
  // `locality` field should already survive. Proven by round-tripping the dispatched value through
  // `JSON.parse(JSON.stringify(...))`, the same transform the real JSON-RPC transport applies.
  test("toolgen.create's refused outcome carries `locality` through the RPC dispatch AND JSON serialization", async () => {
    const ctx = makeCtx({
      draftTool: async () => {
        throw new ToolgenError(
          "ERR_TOOLGEN_DRAFT_INVALID",
          "the drafted tool failed validation twice",
          "local",
        );
      },
    });
    const out = await dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: ["api.example.com"] },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    const serialized = JSON.parse(JSON.stringify(out.value));
    expect(serialized).toEqual({
      status: "refused",
      code: "ERR_TOOLGEN_DRAFT_INVALID",
      locality: "local",
    });
  });
});

describe("toolgen.save", () => {
  test("dispatches to the save gate and returns its outcome", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("t1", "s1"), async () => {});
    const run = dispatchToolgenRpc("toolgen.save", { toolId: "t1" }, ctx);
    await Bun.sleep(1);
    const requestId = ctx.saveBroadcasts[0]?.["requestId"] as string;
    expect(typeof requestId).toBe("string");
    await dispatchToolgenRpc("toolgen.saveApprovalRespond", { requestId, approved: true }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toMatchObject({ status: "saved", toolId: "t1" });
  });

  // Carried-forward review item 1: this is the test that would fail if `saveDeps.requestApproval`
  // were mistakenly wired to the CREATE broker (`consent.request`) instead of the save one --
  // every other test in this file would still pass, because each injects its own stub. Asserting
  // on the METHOD NAME actually broadcast, not on broker instance identity, is what makes this a
  // real check of the wire rather than of `makeCtx`'s own wiring.
  test("routes its approval through toolgen.saveApprovalRequest, never the create broker's channel", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.register(makeEnvelope("t1", "s1"), async () => {});
    const seenMethods: string[] = [];
    ctx.saveConsent.setBroadcast((method, params) => {
      seenMethods.push(method);
      ctx.saveBroadcasts.push(params as Record<string, unknown>);
    });
    const run = dispatchToolgenRpc("toolgen.save", { toolId: "t1" }, ctx);
    await Bun.sleep(1);
    expect(seenMethods).toEqual(["toolgen.saveApprovalRequest"]);
    // The CREATE broker must never see this -- a wiring mistake would land a broadcast here too.
    expect(ctx.broadcasts).toHaveLength(0);
    const requestId = ctx.saveBroadcasts[0]?.["requestId"] as string;
    await dispatchToolgenRpc("toolgen.saveApprovalRespond", { requestId, approved: false }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("without toolId is an invalid-params error", async () => {
    await expect(dispatchToolgenRpc("toolgen.save", {}, makeCtx())).rejects.toThrow();
  });

  test("refuses a tool that is not live in this registry", async () => {
    const ctx = makeCtx();
    const out = await dispatchToolgenRpc("toolgen.save", { toolId: "ghost" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toMatchObject({ status: "refused", code: "ERR_TOOLGEN_SAVE_NOT_LIVE" });
  });

  // Carried-forward review item 2: proves `ctx.saveDeps.enforced` is a REAL, live-checked field on
  // this ctx (not a stub that always reads as enabled) -- a wrong wiring in `assemble.ts` (e.g. an
  // always-empty `capabilitiesDisabled`) would make this refusal never fire in production even
  // though every gate-level unit test in `toolgen-save-gate.test.ts` still passes.
  test("refuses fail-closed when org policy disables tool_generation, via saveDeps' OWN enforced accessor", async () => {
    const ctx = makeCtx({}, { enforced: { capabilitiesDisabled: new Set(["tool_generation"]) } });
    ctx.gateDeps.registry.register(makeEnvelope("t1", "s1"), async () => {});
    const out = await dispatchToolgenRpc("toolgen.save", { toolId: "t1" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toMatchObject({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
  });
});

describe("toolgen.credentialSet", () => {
  /** A live envelope registered under `t1`, approved for `api.example.com` as a credential host. */
  function registerCredentialedLiveTool(ctx: TestCtx, toolId = "t1"): void {
    const envelope = makeEnvelope(toolId, "s1");
    ctx.gateDeps.registry.register(
      { ...envelope, artifact: { ...envelope.artifact, credentialHosts: ["api.example.com"] } },
      async () => {},
    );
  }

  test("refuses a host outside the signed credentialHosts", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    // Asserted via `.code`, never a message-text regex: named `ToolgenError` codes exist so a
    // caller distinguishes refusals without matching on message text (its own docstring), and
    // `.rejects.toMatchObject({ code })` still fails the test outright if the call unexpectedly
    // resolves instead of rejecting.
    await expect(
      dispatchToolgenRpc(
        "toolgen.credentialSet",
        { toolId: "t1", host: "evil.com", binding: { type: "bearer", token: "x" } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN });
  });

  // Positive control: without this, "refuses unknown hosts" would pass for an implementation that
  // refused EVERY host.
  test("accepts a host that IS in credentialHosts", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    const out = await dispatchToolgenRpc(
      "toolgen.credentialSet",
      { toolId: "t1", host: "api.example.com", binding: { type: "bearer", token: "s3cret" } },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ bound: true });
  });

  // The exact defect `toolgen-gate.ts:293-294` postmortems: normalising for the membership check
  // but forwarding the raw spelling elsewhere. An UPPERCASE host must be accepted for a tool whose
  // signed `credentialHosts` holds the lowercase name, and the write must land under the SAME
  // normalised key a later `nimbus tool credential set api.example.com` would also use.
  test("normalises an UPPERCASE host before checking membership AND before composing the Vault key", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    const out = await dispatchToolgenRpc(
      "toolgen.credentialSet",
      { toolId: "t1", host: "API.EXAMPLE.COM", binding: { type: "bearer", token: "s3cret" } },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ bound: true });
    expect(await ctx.vault.get("toolgen.t1.api_pexample_pcom")).not.toBeNull();
  });

  test("normalises a URL-form host (scheme + path) the same way", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    const out = await dispatchToolgenRpc(
      "toolgen.credentialSet",
      {
        toolId: "t1",
        host: "https://api.example.com/v1",
        binding: { type: "bearer", token: "s3cret" },
      },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ bound: true });
    expect(await ctx.vault.get("toolgen.t1.api_pexample_pcom")).not.toBeNull();
  });

  test("writes the credential to the Vault and never echoes its value back on the wire", async () => {
    // Distinctive enough for the never-echoed assertions below to be meaningful, and deliberately
    // NOT secret-SHAPED: the first version of this fixture was `sk_live_…`, Stripe's real live-key
    // prefix, and gitleaks flagged it as a `generic-api-key` — correctly, since a scanner cannot
    // know a money-moving credential is fake. A fixture proving a secret is never echoed does not
    // need to look like a real one.
    const SECRET = "nimbus-test-credential-value-DO-NOT-USE";
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    const out = await dispatchToolgenRpc(
      "toolgen.credentialSet",
      { toolId: "t1", host: "api.example.com", binding: { type: "bearer", token: SECRET } },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(JSON.stringify(out.value)).not.toContain(SECRET);
    const stored = await ctx.vault.get("toolgen.t1.api_pexample_pcom");
    expect(stored).toContain(SECRET);
  });

  test("binds header and basic schemes too -- the first user-facing path for them", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    await dispatchToolgenRpc(
      "toolgen.credentialSet",
      {
        toolId: "t1",
        host: "api.example.com",
        binding: { type: "header", headerName: "X-Api-Key", value: "v" },
      },
      ctx,
    );
    const stored = await ctx.vault.get("toolgen.t1.api_pexample_pcom");
    expect(stored).toContain("header");

    await dispatchToolgenRpc(
      "toolgen.credentialSet",
      {
        toolId: "t1",
        host: "api.example.com",
        binding: { type: "basic", username: "u", password: "p" },
      },
      ctx,
    );
    const stored2 = await ctx.vault.get("toolgen.t1.api_pexample_pcom");
    expect(stored2).toContain("basic");
  });

  test("resolves credentialHosts from a SAVED (healthy) tool, not only a live ephemeral one", async () => {
    const ctx = makeCtx();
    ctx.gateDeps.registry.registerSaved(
      makeSavedEnvelope("tg_saved", { credentialHosts: ["api.example.com"] }),
    );
    const out = await dispatchToolgenRpc(
      "toolgen.credentialSet",
      {
        toolId: "tg_saved",
        host: "api.example.com",
        binding: { type: "bearer", token: "s3cret" },
      },
      ctx,
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ bound: true });
  });

  test("an unknown toolId resolves to an EMPTY credentialHosts and is refused fail-closed", async () => {
    const ctx = makeCtx();
    await expect(
      dispatchToolgenRpc(
        "toolgen.credentialSet",
        { toolId: "ghost", host: "api.example.com", binding: { type: "bearer", token: "x" } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN });
  });

  test("without toolId, host or binding is an invalid-params error", async () => {
    await expect(dispatchToolgenRpc("toolgen.credentialSet", {}, makeCtx())).rejects.toThrow();
  });

  test("a malformed binding.type is refused without leaking any supplied value", async () => {
    const ctx = makeCtx();
    registerCredentialedLiveTool(ctx);
    await expect(
      dispatchToolgenRpc(
        "toolgen.credentialSet",
        { toolId: "t1", host: "api.example.com", binding: { type: "nope" } },
        ctx,
      ),
    ).rejects.toThrow(/binding\.type/);
  });
});

describe("params that are not a keyed record at all", () => {
  // `asRecord` returns undefined for a non-record, and both `requireString` and `toolgen.create`'s
  // own `?? {}` have to survive that — a JSON-RPC caller can legally send an array or a scalar as
  // `params`, and neither may reach the gate as a half-read request.
  test.each([
    ["an array", [] as unknown],
    ["a string", "nope" as unknown],
    ["a number", 7 as unknown],
    ["null", null as unknown],
  ])(
    "toolgen.create with %s is an invalid-params error, never a defaulted call",
    async (_label, params) => {
      let reached = false;
      const ctx = makeCtx({
        draftTool: async () => {
          reached = true;
          return {
            body: "return 1;",
            inputSchema: { type: "object", properties: {} },
            grounding: { kind: "description_only" },
            attempts: 1,
            locality: "local",
          };
        },
      });
      await expect(dispatchToolgenRpc("toolgen.create", params, ctx)).rejects.toMatchObject({
        rpcCode: -32602,
      });
      expect(reached).toBe(false);
    },
  );

  test("toolgen.list with a non-record params is refused rather than listing every session", async () => {
    await expect(dispatchToolgenRpc("toolgen.list", [], makeCtx())).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });
});

describe("a malformed hosts array yields an EMPTY host list, never a partial one", () => {
  // Silently dropping the bad element would approve a tool for a host list nobody typed. An empty
  // list is refused outright by the gate, which turns a malformed array into a clean refusal.
  test("a mixed string/non-string hosts array is refused, not partially granted", async () => {
    const ctx = makeCtx();
    const out = await dispatchToolgenRpc(
      "toolgen.create",
      { sessionId: "s1", description: "d", hosts: ["api.example.com", 42] },
      ctx,
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toMatchObject({
      status: "refused",
      code: "ERR_TOOLGEN_HOST_NOT_ALLOWED",
    });
    // The point of the test: the ONE good host was not silently kept.
    expect(ctx.broadcasts).toHaveLength(0);
  });
});
