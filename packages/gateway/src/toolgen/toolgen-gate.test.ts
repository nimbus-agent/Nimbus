import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { createGeneratedTool, normalizeHost } from "./toolgen-gate.ts";
import { ToolgenRegistry } from "./toolgen-registry.ts";
import { ToolgenError } from "./toolgen-types.ts";

function deps(over: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  // Spy counters on the three "reaches outside the process" effects: writing the script, spawning
  // the child, and undoing a Vault bind. A test overriding one of these fakes loses its counter for
  // that dep only -- the other two keep counting, which is what lets a single override (e.g.
  // `requestApproval`) still prove "nothing was written or spawned" via the untouched defaults.
  const calls = { writeScript: 0, spawn: 0, revokeCredentials: 0 };
  return {
    db,
    config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry: new ToolgenRegistry(),
    draftTool: async () => ({
      body: "return 1;",
      inputSchema: { type: "object", properties: {} },
      grounding: { kind: "description_only" },
      attempts: 1,
      locality: "local",
    }),
    assertConfinement: async () => {},
    writeScript: async () => {
      calls.writeScript++;
      return "/tmp/tg/index.ts";
    },
    scriptDir: () => "/tmp/tg",
    bindCredentials: async () => [],
    revokeCredentials: async () => {
      calls.revokeCredentials++;
    },
    spawn: async () => {
      calls.spawn++;
      return {
        describe: async () => ({ name: "t", description: "d" }),
        call: async () => null,
        close: async () => {},
      };
    },
    requestApproval: async () => true,
    now: () => 1,
    newId: () => "tg_a",
    calls,
    ...over,
  };
}

const req = { sessionId: "s1", description: "list open PRs", hosts: ["api.example.com"] };

function auditRows(db: Database) {
  return db
    .query<{ hitl_status: string; action_json: string }, []>(
      "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'tool.generate'",
    )
    .all();
}

describe("createGeneratedTool refusals happen BEFORE consent", () => {
  test("config off refuses, never prompts, and reaches nothing outside the process", async () => {
    let prompted = false;
    const d = deps({
      config: DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    expect(await createGeneratedTool(req, d as never)).toEqual({
      status: "refused",
      code: "ERR_TOOLGEN_DISABLED",
    });
    expect(prompted).toBe(false);
    // Proves non-spawn / non-write, not just non-registration: a gate that wrote the script or
    // spawned the child and only skipped `registry.register` would still pass a
    // `forSession(...).length === 0` check.
    expect(d.calls.writeScript).toBe(0);
    expect(d.calls.spawn).toBe(0);
    expect(d.calls.revokeCredentials).toBe(0);
  });

  test("org policy off refuses and never prompts", async () => {
    let prompted = false;
    const d = deps({
      enforced: { capabilitiesDisabled: new Set(["tool_generation"]) },
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    expect((await createGeneratedTool(req, d as never)).status).toBe("refused");
    expect(prompted).toBe(false);
  });

  test("an ABSENT policy accessor refuses fail-closed, it does not default to enabled, and never prompts", async () => {
    let prompted = false;
    const d = deps({
      enforced: undefined,
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    const outcome = await createGeneratedTool(req, d as never);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    // Weakest possible assertion here would be `.status === "refused"` alone -- that also passes for
    // a gate that crashed on `undefined.capabilitiesDisabled`, or one that prompted and THEN refused.
    // Pin the exact code and prove the prompt was never reached.
    expect(outcome.code).toBe("ERR_TOOLGEN_POLICY_DISABLED");
    expect(prompted).toBe(false);
  });

  test("session budget refuses and never prompts", async () => {
    let prompted = false;
    const registry = new ToolgenRegistry();
    for (const id of ["a", "b", "c"]) {
      registry.register(
        {
          sessionId: "s1",
          scriptPath: "/tmp",
          approvedAt: 1,
          artifact: {
            toolId: id,
            toolName: id,
            description: "",
            body: "",
            approvedHosts: [],
            credentialHosts: [],
            manifest: {
              id: `toolgen.${id}`,
              version: "0.0.0",
              permissions: { network: [], filesystem: { read: [], write: [] } },
              updateChannel: "stable",
            },
            inputSchema: { type: "object", properties: {} },
          },
        },
        async () => {},
      );
    }
    const d = deps({
      registry,
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    const outcome = await createGeneratedTool(req, d as never);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.code).toBe("ERR_TOOLGEN_SESSION_BUDGET_EXCEEDED");
    expect(prompted).toBe(false);
  });

  test("a failed confinement probe refuses and never prompts", async () => {
    let prompted = false;
    const d = deps({
      assertConfinement: async () => {
        throw new Error("degraded");
      },
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    expect((await createGeneratedTool(req, d as never)).status).toBe("refused");
    expect(prompted).toBe(false);
  });

  test("an unsafe minted tool id refuses and never prompts", async () => {
    let prompted = false;
    const d = deps({
      newId: () => "a\nb",
      requestApproval: async () => {
        prompted = true;
        return true;
      },
    });
    const outcome = await createGeneratedTool(req, d as never);
    expect(outcome).toEqual({ status: "refused", code: "ERR_TOOLGEN_INTERNAL" });
    expect(prompted).toBe(false);
  });
});

describe("the manifest granted to the sandbox", () => {
  test("grants read to the script dir AND the runtime's own read paths, never node_modules", async () => {
    let seenRead: string[] | undefined;
    const d = deps({
      assertConfinement: async (manifest: { permissions: { filesystem: { read: string[] } } }) => {
        seenRead = manifest.permissions.filesystem.read;
      },
    });
    await createGeneratedTool(req, d as never);
    expect(seenRead).toBeDefined();
    const read = seenRead ?? [];
    // The script directory (Task 11's grant) ...
    expect(read).toContain("/tmp/tg");
    // ... AND the interpreter's own paths (`ExecRuntime.requiredReadPaths()`), without which the
    // Windows AppContainer helper leaves bun itself unreadable and the child dies at exit 68 before
    // running a line, no stdout, no stderr.
    expect(read.length).toBeGreaterThan(1);
    expect(read.some((p) => p.toLowerCase().includes("node_modules"))).toBe(false);
  });
});

describe("normalizeHost", () => {
  test.each([
    ["https://api.example.com/v1", "api.example.com"],
    ["API.Example.COM", "api.example.com"],
    ["api.example.com:443", "api.example.com"],
    ["  api.example.com  ", "api.example.com"],
  ])("%s -> %s", (raw, want) => {
    expect(normalizeHost(raw)).toBe(want);
  });

  test.each([
    [""],
    ["   "],
    // A non-https scheme must be refused, not silently accepted with an empty hostname: `unix:///x`
    // parses cleanly (its own scheme, an empty authority) and `new URL(...).hostname` comes back as
    // `""`, which sails past the leading blank-string guard because that guard runs on the RAW input,
    // not the parsed result.
    ["unix:///x"],
    ["http://api.example.com"],
    ["ftp://api.example.com"],
  ])("refuses %p", (raw) => {
    expect(() => normalizeHost(raw)).toThrow();
  });
});

describe("createGeneratedTool outcomes", () => {
  test("approval registers the tool and audits approved", async () => {
    const d = deps();
    expect(await createGeneratedTool(req, d as never)).toEqual({
      status: "registered",
      toolId: "tg_a",
    });
    expect(d.registry.forSession("s1")).toHaveLength(1);
    expect(auditRows(d.db)[0]?.hitl_status).toBe("approved");
  });

  test("a denial registers NOTHING, writes and spawns nothing, revokes any bound credential, and audits rejected", async () => {
    const d = deps({
      bindCredentials: async () => ["api.example.com"],
      requestApproval: async () => false,
    });
    expect(await createGeneratedTool(req, d as never)).toEqual({ status: "denied" });
    expect(d.registry.forSession("s1")).toHaveLength(0);
    // Proves non-spawn / non-write, not just non-registration.
    expect(d.calls.writeScript).toBe(0);
    expect(d.calls.spawn).toBe(0);
    // The credential was bound BEFORE the prompt (so the prompt can name a real host list) -- a
    // denial must not leave it behind under a toolId nothing will ever call again.
    expect(d.calls.revokeCredentials).toBe(1);
    expect(auditRows(d.db)[0]?.hitl_status).toBe("rejected");
  });

  test("a THROWING revokeCredentials on the denial path still returns 'denied' and still audits — the outcome is not lost (load-bearing #4)", async () => {
    // A previous version of the gate called `deps.revokeCredentials` unguarded on this path. If
    // that throws, it escapes into the outer `catch`, which then sees `credentialsBound` still
    // `true` and calls `revokeCredentials` again -- also unguarded -- and a SECOND throw there
    // escapes `createGeneratedTool` entirely, so no `audit()` call ever runs for a denial the
    // owner actually gave. This test fails on that regression: the `throw` below is designed to
    // hit exactly that unguarded second call if `safeRevokeCredentials`'s swallow is ever removed.
    const d = deps({
      bindCredentials: async () => ["api.example.com"],
      requestApproval: async () => false,
      revokeCredentials: async () => {
        throw new Error("vault unavailable");
      },
    });
    const outcome = await createGeneratedTool(req, d as never);
    expect(outcome).toEqual({ status: "denied" });
    const row = auditRows(d.db)[0];
    expect(row?.hitl_status).toBe("rejected");
    expect(row?.action_json).toContain("denied_by_owner");
  });

  test("the audit row carries the VERBATIM body, and never hitl_status not_required", async () => {
    const d = deps({
      draftTool: async () => ({
        body: "VERBATIM-BODY",
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "description_only" },
        attempts: 1,
        locality: "local",
      }),
    });
    await createGeneratedTool(req, d as never);
    const row = auditRows(d.db)[0];
    expect(row?.action_json).toContain("VERBATIM-BODY");
    expect(row?.hitl_status).not.toBe("not_required");
  });

  test("the approval prompt names the hosts that will receive a CREDENTIAL", async () => {
    let seen: { credentialHosts: readonly string[] } | undefined;
    const d = deps({
      bindCredentials: async () => ["api.example.com"],
      requestApproval: async (input: { credentialHosts: readonly string[] }) => {
        seen = input;
        return true;
      },
    });
    await createGeneratedTool(req, d as never);
    // Vacuous before credentials moved to create time: nothing could be in the Vault under a
    // toolId that did not exist yet, so this list was ALWAYS empty and disclosed nothing.
    expect(seen?.credentialHosts).toEqual(["api.example.com"]);
  });

  test("a refusal before consent still audits, as rejected with its own outcome tag", async () => {
    const d = deps({ config: DEFAULT_NIMBUS_TOOL_GENERATION_TOML });
    await createGeneratedTool(req, d as never);
    const row = auditRows(d.db)[0];
    expect(row?.hitl_status).toBe("rejected");
    expect(row?.action_json).toContain("refused_before_consent");
  });

  test("a failure AFTER approval is audited hitl_status APPROVED (not rejected), tagged failed_after_approval, and still revokes the bound credential", async () => {
    // Deleting the `approved ? ... : ...` branch in the gate's catch block leaves every one of the
    // other 16 tests green -- this is the one test that fails if that sentinel regresses. An owner
    // who approved and then hit a write/spawn failure must not be recorded as though they were never
    // asked: an auditor filtering `hitl_status='approved'` on `tool.generate` would otherwise miss a
    // run they actually consented to, where a process may already have spawned.
    const d = deps({
      bindCredentials: async () => ["api.example.com"],
      writeScript: async () => {
        throw new Error("disk full");
      },
    });
    const outcome = await createGeneratedTool(req, d as never);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.code).toBe("ERR_TOOLGEN_INTERNAL");
    const row = auditRows(d.db)[0];
    expect(row?.hitl_status).toBe("approved");
    expect(row?.action_json).toContain("failed_after_approval");
    expect(row?.action_json).not.toContain("refused_before_consent");
    // The toolId will never register (writeScript failed), so its bound credential must not survive.
    expect(d.calls.revokeCredentials).toBe(1);
  });
});

describe("createGeneratedTool drafting and credential binding (Task 9)", () => {
  test("the drafted schema reaches the approval prompt and the artifact", async () => {
    const prompts: Array<{ inputSchema: unknown }> = [];
    const d = deps({
      draftTool: async () => ({
        body: "return 1;",
        inputSchema: { type: "object", properties: { owner: { type: "string" } } },
        grounding: { kind: "description_only" },
        attempts: 1,
        locality: "local",
      }),
      requestApproval: async (input: { inputSchema: unknown }) => {
        prompts.push(input);
        return true;
      },
    });
    const out = await createGeneratedTool(req, d as never);
    expect(out.status).toBe("registered");
    expect(prompts[0]?.inputSchema).toEqual({
      type: "object",
      properties: { owner: { type: "string" } },
    });
  });

  test("credentials are bound before consent and NOT passed to the drafter", async () => {
    let draftArg: unknown;
    const bound: unknown[] = [];
    const d = deps({
      draftTool: async (r: unknown) => {
        draftArg = r;
        return {
          body: "return 1;",
          inputSchema: { type: "object", properties: {} },
          grounding: { kind: "description_only" },
          attempts: 1,
          locality: "local",
        };
      },
      bindCredentials: async (_toolId: string, creds: Array<{ host: string }>) => {
        bound.push(creds);
        return creds.map((c) => c.host);
      },
    });
    await createGeneratedTool(req, d as never, [
      { host: "api.example.com", binding: { type: "bearer", token: "s3cret" } },
    ]);
    // `req` is exactly what reaches `draftTool` -- credentials are a SEPARATE parameter to
    // `createGeneratedTool` and never merged onto it (Task 9 controller ruling 1).
    expect(JSON.stringify(draftArg)).not.toContain("s3cret");
    expect(bound).toHaveLength(1);
  });

  test("a denial revokes the credentials supplied via the credentials parameter", async () => {
    const revoked: string[] = [];
    const d = deps({
      requestApproval: async () => false,
      bindCredentials: async (_id: string, creds: Array<{ host: string }>) =>
        creds.map((c) => c.host),
      revokeCredentials: async (id: string) => {
        revoked.push(id);
      },
    });
    const out = await createGeneratedTool(req, d as never, [
      { host: "api.example.com", binding: { type: "bearer", token: "s3cret" } },
    ]);
    expect(out.status).toBe("denied");
    expect(revoked).toHaveLength(1);
  });

  test("the audit row records the draft attempts, grounding and locality", async () => {
    const d = deps({
      draftTool: async () => ({
        body: "return 1;",
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "endpoints", count: 2, services: ["github"] },
        attempts: 2,
        locality: "remote",
      }),
    });
    await createGeneratedTool(req, d as never);
    const row = auditRows(d.db)[0];
    expect(row).toBeDefined();
    const payload = JSON.parse(row?.action_json ?? "{}") as Record<string, unknown>;
    expect(payload["draftAttempts"]).toBe(2);
    expect(payload["draftGrounding"]).toEqual({
      kind: "endpoints",
      count: 2,
      services: ["github"],
    });
    expect(payload["draftLocality"]).toBe("remote");
  });

  test("a partial bindCredentials failure still revokes the ATTEMPTED hosts, refused before consent (fix round 1 finding 1)", async () => {
    // Simulates Task 11's real `bindCredentials`: a sequential per-host write loop that can write
    // host A's credential to the Vault and THEN throw before it ever returns -- so the flag/list
    // this test cares about must be set BEFORE the call, not derived from its (never-received)
    // return value.
    const revoked: Array<{ toolId: string; hosts: readonly string[] }> = [];
    const d = deps({
      bindCredentials: async () => {
        throw new Error("vault unavailable after writing the first host");
      },
      revokeCredentials: async (id: string, hosts: readonly string[]) => {
        revoked.push({ toolId: id, hosts });
      },
    });
    const out = await createGeneratedTool(req, d as never, [
      { host: "api.example.com", binding: { type: "bearer", token: "s3cret" } },
    ]);
    expect(out.status).toBe("refused");
    if (out.status !== "refused") throw new Error("unreachable");
    expect(out.code).toBe("ERR_TOOLGEN_INTERNAL");
    // The attempted set, not an empty/never-assigned return value.
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.hosts).toEqual(["api.example.com"]);
    const row = auditRows(d.db)[0];
    expect(row?.hitl_status).toBe("rejected");
    expect(row?.action_json).toContain("refused_before_consent");
  });

  test("forApprovedHosts drops a credential for a host outside --host, before EITHER bindCredentials or the prompt sees it (fix round 1 finding 2)", async () => {
    const bound: Array<ReadonlyArray<{ host: string }>> = [];
    let seenCredentialHosts: readonly string[] | undefined;
    const d = deps({
      bindCredentials: async (_toolId: string, creds: Array<{ host: string }>) => {
        bound.push(creds);
        return creds.map((c) => c.host);
      },
      requestApproval: async (input: { credentialHosts: readonly string[] }) => {
        seenCredentialHosts = input.credentialHosts;
        return true;
      },
    });
    // `req.hosts` is `["api.example.com"]` -- only the FIRST of these two is approved.
    await createGeneratedTool(req, d as never, [
      { host: "api.example.com", binding: { type: "bearer", token: "a" } },
      { host: "not-approved.example.com", binding: { type: "bearer", token: "b" } },
    ]);
    // Assert on what the fake RECEIVED, not only on the outcome.
    expect(bound).toHaveLength(1);
    expect(bound[0]?.map((c) => c.host)).toEqual(["api.example.com"]);
    expect(seenCredentialHosts).toEqual(["api.example.com"]);
  });
});

// The credential host was FILTERED through `normalizeHost` but forwarded RAW, so one host became
// two names: the Vault key was written under `https://api_pexample_pcom` while
// `ToolgenBroker.handleFetch` reads under `url.hostname.toLowerCase()`. Three consequences, all
// pinned here, and the third is the one that breaks a safety property this gate establishes.
describe("a credential host is NORMALISED everywhere, not merely matched against a normalised host", () => {
  const RAW = "https://API.example.com/v1";
  const NORMALISED = "api.example.com";

  test("bindCredentials RECEIVES the normalised host, not the string the owner typed", async () => {
    // Captures the WHOLE credential, binding included — a `{ host: string }` capture would make the
    // "the token travelled with it" assertion below untypeable, and a narrower capture is exactly
    // how a dropped field goes unnoticed.
    type Captured = { host: string; binding: { type: string; token: string } };
    const bound: Array<ReadonlyArray<Captured>> = [];
    const d = deps({
      bindCredentials: async (_toolId: string, creds: Captured[]) => {
        bound.push(creds);
        return creds.map((c) => c.host);
      },
    });
    // Assert on what the fake RECEIVED: the outcome is `registered` either way, which is exactly
    // why the raw-host bug survived — the tool registered, then made unauthenticated requests.
    const out = await createGeneratedTool(req, d as never, [
      { host: RAW, binding: { type: "bearer", token: "s3cret" } },
    ]);
    expect(out.status).toBe("registered");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.map((c) => c.host)).toEqual([NORMALISED]);
    // The binding travels intact — normalising the host must not drop the token.
    expect(bound[0]?.[0]).toEqual({
      host: NORMALISED,
      binding: { type: "bearer", token: "s3cret" },
    });
  });

  test("the approval prompt's credentialHosts AGREES with its approvedHosts", async () => {
    let seen: { approvedHosts: readonly string[]; credentialHosts: readonly string[] } | undefined;
    const d = deps({
      bindCredentials: async (_toolId: string, creds: Array<{ host: string }>) =>
        creds.map((c) => c.host),
      requestApproval: async (input: {
        approvedHosts: readonly string[];
        credentialHosts: readonly string[];
      }) => {
        seen = input;
        return true;
      },
    });
    await createGeneratedTool(req, d as never, [
      { host: RAW, binding: { type: "bearer", token: "s3cret" } },
    ]);
    // An owner cannot meaningfully approve an envelope that contradicts itself: two spellings of
    // one host read as a credential for a host the tool was not approved to reach.
    expect(seen?.approvedHosts).toEqual([NORMALISED]);
    expect(seen?.credentialHosts).toEqual([NORMALISED]);
  });

  test("a DENIAL revokes that same normalised name — the key that was actually written", async () => {
    const revoked: Array<{ toolId: string; hosts: readonly string[] }> = [];
    const d = deps({
      requestApproval: async () => false,
      bindCredentials: async (_id: string, creds: Array<{ host: string }>) =>
        creds.map((c) => c.host),
      revokeCredentials: async (id: string, hosts: readonly string[]) => {
        revoked.push({ toolId: id, hosts });
      },
    });
    const out = await createGeneratedTool(req, d as never, [
      { host: RAW, binding: { type: "bearer", token: "s3cret" } },
    ]);
    expect(out.status).toBe("denied");
    // Under the raw-host bug this named `https://API.example.com/v1`, a key nothing had written,
    // so the real bearer token SURVIVED in the Vault under a toolId that will never register.
    expect(revoked).toEqual([{ toolId: "tg_a", hosts: [NORMALISED] }]);
  });

  test("the denial audit row DISCLOSES the credential hosts a secret may have been written for", async () => {
    const d = deps({
      requestApproval: async () => false,
      bindCredentials: async (_id: string, creds: Array<{ host: string }>) =>
        creds.map((c) => c.host),
    });
    await createGeneratedTool(req, d as never, [
      { host: RAW, binding: { type: "bearer", token: "s3cret" } },
    ]);
    const row = auditRows(d.db)[0];
    const payload = JSON.parse(row?.action_json ?? "{}") as Record<string, unknown>;
    expect(payload["outcome"]).toBe("denied_by_owner");
    // `bindCredentials` runs BEFORE consent, so a denial can follow a real Vault write. This is the
    // row an auditor reads to ask whether one happened; without the field the answer was invisible.
    expect(payload["credentialHosts"]).toEqual([NORMALISED]);
    // And never the secret itself.
    expect(row?.action_json).not.toContain("s3cret");
  });

  test("two credentials for the SAME host after normalisation are disclosed ONCE, not twice", async () => {
    let seen: readonly string[] | undefined;
    const d = deps({
      bindCredentials: async (_id: string, creds: Array<{ host: string }>) =>
        creds.map((c) => c.host),
      requestApproval: async (input: { credentialHosts: readonly string[] }) => {
        seen = input.credentialHosts;
        return true;
      },
    });
    await createGeneratedTool(req, d as never, [
      { host: "api.example.com", binding: { type: "bearer", token: "a" } },
      { host: "API.example.com:443", binding: { type: "bearer", token: "b" } },
    ]);
    expect(seen).toEqual([NORMALISED]);
  });
});

// Fix round 1 on Task 10: the CLI's local-model hint reads `outcome.locality`, and this is the
// producer -- the outer `catch` must carry a thrown `ToolgenError`'s locality onto the refused
// outcome, since that is the only place `ToolgenOutcome`'s "refused" variant is constructed.
describe("createGeneratedTool's refused outcome carries the draft's locality (Task 10 fix round 1)", () => {
  test('ERR_TOOLGEN_DRAFT_INVALID from a LOCAL route produces a refused outcome with locality "local"', async () => {
    const d = deps({
      draftTool: async () => {
        throw new ToolgenError(
          "ERR_TOOLGEN_DRAFT_INVALID",
          "the drafted tool failed validation twice",
          "local",
        );
      },
    });
    const out = await createGeneratedTool(req, d as never);
    expect(out).toEqual({
      status: "refused",
      code: "ERR_TOOLGEN_DRAFT_INVALID",
      locality: "local",
    });
  });

  test('ERR_TOOLGEN_DRAFT_INVALID from a REMOTE route produces a refused outcome with locality "remote"', async () => {
    const d = deps({
      draftTool: async () => {
        throw new ToolgenError(
          "ERR_TOOLGEN_DRAFT_INVALID",
          "the drafted tool failed validation twice",
          "remote",
        );
      },
    });
    const out = await createGeneratedTool(req, d as never);
    expect(out).toEqual({
      status: "refused",
      code: "ERR_TOOLGEN_DRAFT_INVALID",
      locality: "remote",
    });
  });

  test("ERR_TOOLGEN_NO_DRAFT_MODEL carries NO locality on the refused outcome", async () => {
    const d = deps({
      draftTool: async () => {
        throw new ToolgenError("ERR_TOOLGEN_NO_DRAFT_MODEL", "no model is available");
      },
    });
    const out = await createGeneratedTool(req, d as never);
    // Not `locality: undefined` -- the KEY itself must be absent, matching every other refusal
    // that genuinely has none to report (config off, policy, budget, bad host, confinement).
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_NO_DRAFT_MODEL" });
    expect(Object.hasOwn(out, "locality")).toBe(false);
  });

  test("a pre-draft refusal (config off) carries no locality at all", async () => {
    const d = deps({ config: DEFAULT_NIMBUS_TOOL_GENERATION_TOML });
    const out = await createGeneratedTool(req, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_DISABLED" });
    expect(Object.hasOwn(out, "locality")).toBe(false);
  });
});

// `credentialRevokeFailed` is the one field telling an operator that a bearer token may still sit
// in the Vault under a toolId that will never register. It is written by all THREE
// non-registering audit rows (the denial arm, and both rows the outer `catch` can write), and must
// be PRESENT exactly when a bound credential failed to revoke and ABSENT otherwise — `false` or a
// bare key would still read as a claim about cleanup on a run that bound nothing. Asserted on the
// PARSED row, never by substring, so an absent field cannot pass on an accident of formatting.
describe("credentialRevokeFailed on the three non-registering audit rows", () => {
  const failingRevoke = async (): Promise<void> => {
    throw new Error("vault unavailable");
  };

  function onlyRow(db: Database): Record<string, unknown> {
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    return JSON.parse(rows[0]?.action_json ?? "{}") as Record<string, unknown>;
  }

  test("denied_by_owner: present when the revoke FAILED, absent when it succeeded", async () => {
    const failed = deps({
      bindCredentials: async () => ["api.example.com"],
      requestApproval: async () => false,
      revokeCredentials: failingRevoke,
    });
    expect(await createGeneratedTool(req, failed as never)).toEqual({ status: "denied" });
    const failedRow = onlyRow(failed.db);
    expect(failedRow["outcome"]).toBe("denied_by_owner");
    expect(failedRow["credentialRevokeFailed"]).toBe(true);

    const clean = deps({
      bindCredentials: async () => ["api.example.com"],
      requestApproval: async () => false,
    });
    expect(await createGeneratedTool(req, clean as never)).toEqual({ status: "denied" });
    expect(clean.calls.revokeCredentials).toBe(1);
    const cleanRow = onlyRow(clean.db);
    expect(cleanRow["outcome"]).toBe("denied_by_owner");
    expect(Object.hasOwn(cleanRow, "credentialRevokeFailed")).toBe(false);
  });

  test("failed_after_approval: present when the revoke FAILED, absent when it succeeded", async () => {
    const diskFull = async (): Promise<string> => {
      throw new Error("disk full");
    };
    const failed = deps({
      bindCredentials: async () => ["api.example.com"],
      writeScript: diskFull,
      revokeCredentials: failingRevoke,
    });
    expect((await createGeneratedTool(req, failed as never)).status).toBe("refused");
    const failedRow = onlyRow(failed.db);
    expect(failedRow["outcome"]).toBe("failed_after_approval");
    expect(failedRow["credentialRevokeFailed"]).toBe(true);

    const clean = deps({ bindCredentials: async () => ["api.example.com"], writeScript: diskFull });
    expect((await createGeneratedTool(req, clean as never)).status).toBe("refused");
    expect(clean.calls.revokeCredentials).toBe(1);
    const cleanRow = onlyRow(clean.db);
    expect(cleanRow["outcome"]).toBe("failed_after_approval");
    expect(Object.hasOwn(cleanRow, "credentialRevokeFailed")).toBe(false);
  });

  test("refused_before_consent: present when a partial bind's revoke FAILED, absent when nothing was ever bound", async () => {
    const failed = deps({
      bindCredentials: async () => {
        throw new Error("vault unavailable after writing the first host");
      },
      revokeCredentials: failingRevoke,
    });
    expect((await createGeneratedTool(req, failed as never)).status).toBe("refused");
    const failedRow = onlyRow(failed.db);
    expect(failedRow["outcome"]).toBe("refused_before_consent");
    expect(failedRow["credentialRevokeFailed"]).toBe(true);

    // Refused before the bind step (config off): no revoke is ever attempted. The FAILING revoke is
    // deliberate — had the gate called it anyway, the field would appear and this would fail.
    const nothingBound = deps({
      config: DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
      revokeCredentials: failingRevoke,
    });
    expect((await createGeneratedTool(req, nothingBound as never)).status).toBe("refused");
    const nothingBoundRow = onlyRow(nothingBound.db);
    expect(nothingBoundRow["outcome"]).toBe("refused_before_consent");
    expect(Object.hasOwn(nothingBoundRow, "credentialRevokeFailed")).toBe(false);
  });
});
