import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ToolgenConsentBroker } from "../toolgen/toolgen-consent-broker.ts";
import { deleteCredentialsForTool, writeToolCredential } from "../toolgen/toolgen-credentials.ts";
import type { ToolgenGateDeps } from "../toolgen/toolgen-gate.ts";
import { ToolgenRegistry } from "../toolgen/toolgen-registry.ts";
import { type ToolgenEnvelope, ToolgenError } from "../toolgen/toolgen-types.ts";
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
  ])("%s is refused over LAN", (method) => {
    expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });
});

const brokers: ToolgenConsentBroker[] = [];
// Pending approvals hold live TTL timers; without this, a test that leaves one pending hangs
// `bun test` teardown on Windows (the same trap `exec-rpc.test.ts` guards against).
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
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

interface TestCtx extends ToolgenRpcCtx {
  broadcasts: Array<Record<string, unknown>>;
  removeScriptCalls: string[];
  /** Backs the default `revokeCredentialsForTool` -- a REAL Vault, not a call-count stub, so the
   * "the credential is actually gone" tests exercise `deleteCredentialsForTool` for real rather
   * than trusting a mock that only records it was asked. */
  vault: NimbusVault;
  revokeCredentialsForToolCalls: string[];
}

function makeCtx(over: Partial<ToolgenGateDeps> = {}): TestCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const consent = new ToolgenConsentBroker();
  brokers.push(consent);
  const broadcasts: Array<Record<string, unknown>> = [];
  consent.setBroadcast((_m, params) => {
    broadcasts.push(params as Record<string, unknown>);
  });
  const registry = new ToolgenRegistry();
  const removeScriptCalls: string[] = [];
  const vault = new FakeVault();
  const revokeCredentialsForToolCalls: string[] = [];
  return {
    consent,
    broadcasts,
    removeScriptCalls,
    vault,
    revokeCredentialsForToolCalls,
    removeScript: async (toolId: string) => {
      removeScriptCalls.push(toolId);
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

  test("toolgen.revoke drops THREE things: the live registry entry, the on-disk script, and the Vault credential", async () => {
    const ctx = makeCtx();
    let closed = false;
    ctx.gateDeps.registry.register(makeEnvelope("tg_a", "s1"), async () => {
      closed = true;
    });
    const out = await dispatchToolgenRpc("toolgen.revoke", { toolId: "tg_a" }, ctx);
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toEqual({ revoked: true });
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
    expect(out.value).toEqual({ revoked: true });
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
    expect(out.value).toEqual({ revoked: true });
    expect(ctx.removeScriptCalls).toEqual(["tg_ghost"]);
    expect(ctx.revokeCredentialsForToolCalls).toEqual(["tg_ghost"]);
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
    expect(bound.length).toBe(1);
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
