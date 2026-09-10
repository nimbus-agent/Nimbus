import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ToolgenSaveApprovalInput } from "./toolgen-consent-broker.ts";
import { ensureToolgenKeypair } from "./toolgen-keypair.ts";
import { ToolgenRegistry } from "./toolgen-registry.ts";
import { saveGeneratedTool } from "./toolgen-save-gate.ts";
import { getSavedTool, setSavedToolDisabled } from "./toolgen-saved-repo.ts";
import { readVerifiedSavedTool, savedToolDir } from "./toolgen-saved-store.ts";
import type { ToolgenEnvelope } from "./toolgen-types.ts";

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
  return mkdtempSync(join(tmpdir(), "nimbus-toolgen-save-gate-"));
}

/** A live, registered generated tool's envelope — the shape the save gate reads from. */
function envelopeWithBody(body: string, toolId = "t1"): ToolgenEnvelope {
  return {
    sessionId: "s1",
    scriptPath: "/tmp/tg/index.ts",
    approvedAt: 1,
    artifact: {
      toolId,
      toolName: `generated_${toolId}`,
      description: "list open PRs",
      body,
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

/**
 * A DEFAULT live "t1" tool is registered unless the caller supplies its own `registry` override —
 * matching `toolgen-gate.test.ts`'s `deps()` shape: plain overrides spread last, so any field
 * (including `enforced: undefined`) wins outright.
 */
function deps(over: Record<string, unknown> = {}) {
  const registry = (over["registry"] as ToolgenRegistry | undefined) ?? new ToolgenRegistry();
  if (!("registry" in over)) {
    const registryClose =
      (over["registryClose"] as (() => Promise<void>) | undefined) ?? (async () => {});
    registry.register(envelopeWithBody("return 1;"), registryClose);
  }
  return {
    db: migratedDb(),
    configDir: tmpConfigDir(),
    vault: new FakeVault(),
    registry,
    config: { enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async () => true,
    now: () => 1,
    ...over,
  };
}

function auditRows(db: Database) {
  return db
    .query<{ hitl_status: string; action_json: string }, []>(
      "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'tool.save'",
    )
    .all();
}

describe("saveGeneratedTool refusals happen BEFORE consent", () => {
  test("refuses when the capability is disabled by config — WITHOUT prompting", async () => {
    let prompted = 0;
    const d = deps({
      config: { enabled: false },
      requestApproval: async () => {
        prompted++;
        return true;
      },
    });
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
    expect(prompted).toBe(0);
    expect(auditRows(d.db)).toHaveLength(1);
    expect(auditRows(d.db)[0]?.hitl_status).toBe("rejected");
  });

  test("refuses when org policy disables tool_generation — still without prompting", async () => {
    let prompted = 0;
    const d = deps({
      enforced: { capabilitiesDisabled: new Set(["tool_generation"]) },
      requestApproval: async () => {
        prompted++;
        return true;
      },
    });
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
    expect(prompted).toBe(0);
  });

  test("refuses fail-closed when the policy accessor is ABSENT — it does not default to enabled", async () => {
    let prompted = 0;
    const d = deps({
      enforced: undefined,
      requestApproval: async () => {
        prompted++;
        return true;
      },
    });
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
    expect(prompted).toBe(0);
  });

  test("refuses a terminated tool — WITHOUT prompting", async () => {
    let prompted = 0;
    const registry = new ToolgenRegistry();
    registry.register(envelopeWithBody("return 1;"), async () => {});
    registry.markTerminated("t1");
    const d = deps({
      registry,
      requestApproval: async () => {
        prompted++;
        return true;
      },
    });
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_NOT_LIVE" });
    expect(prompted).toBe(0);
  });

  test("refuses an unknown tool id — WITHOUT prompting", async () => {
    let prompted = 0;
    const d = deps({
      registry: new ToolgenRegistry(),
      requestApproval: async () => {
        prompted++;
        return true;
      },
    });
    const out = await saveGeneratedTool({ toolId: "never-created" }, d as never);
    expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_NOT_LIVE" });
    expect(prompted).toBe(0);
  });
});

describe("saveGeneratedTool — a denial writes nothing", () => {
  test("a denied approval writes NOTHING — no row, no files", async () => {
    const d = deps({ requestApproval: async () => false });
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "denied" });
    expect(getSavedTool(d.db, "t1")).toBeNull();
    expect(existsSync(savedToolDir(d.configDir, "t1"))).toBe(false);
    const rows = auditRows(d.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
  });

  test("an approval TIMEOUT is treated as a denial", async () => {
    // The gate itself only ever sees the boolean `requestApproval` resolves to — it cannot
    // distinguish an explicit "no" from a TTL fail-closed timeout, by design (I2's frozen-set
    // philosophy applied here: a gate must not need to know WHY consent was withheld). The TTL
    // mechanic itself is proven at the broker layer, in
    // `toolgen-consent-broker.test.ts`'s "resolves FALSE on TTL expiry" tests for
    // `ToolgenSaveConsentBroker`.
    const d = deps({ requestApproval: async () => false });
    expect(await saveGeneratedTool({ toolId: "t1" }, d as never)).toEqual({ status: "denied" });
  });
});

describe("saveGeneratedTool — a successful save", () => {
  test("writes the row and the files, and the artifact verifies", async () => {
    const d = deps();
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).toEqual({ status: "saved", toolId: "t1" });
    const row = getSavedTool(d.db, "t1");
    expect(row?.disabledReason).toBeNull();
    const pub = (await ensureToolgenKeypair(d.vault)).pubkeyB64;
    expect(await readVerifiedSavedTool(d.configDir, "t1", pub)).toMatchObject({ ok: true });
    const rows = auditRows(d.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("approved");
  });

  test("the approved bytes ARE the signed bytes", async () => {
    let approvedBody = "";
    const d = deps({
      requestApproval: async (i: ToolgenSaveApprovalInput) => {
        approvedBody = i.body;
        return true;
      },
    });
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    const pub = (await ensureToolgenKeypair(d.vault)).pubkeyB64;
    const r = await readVerifiedSavedTool(d.configDir, "t1", pub);
    if (!r.ok) throw new Error("expected a verified save");
    expect(JSON.parse(r.canonicalJson).body).toBe(approvedBody);
    expect(approvedBody).toBe("return 1;");
  });

  test("the prompt discloses persistence — it is a different grant from create", async () => {
    let input: ToolgenSaveApprovalInput | undefined;
    const d = deps({
      requestApproval: async (i: ToolgenSaveApprovalInput) => {
        input = i;
        return true;
      },
    });
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(input?.persistence).toBe(true);
    expect(input?.initiator).toBe("owner");
  });

  test("saving an UNCHANGED tool twice returns already_saved and prompts ONCE", async () => {
    let prompts = 0;
    const d = deps({
      requestApproval: async () => {
        prompts++;
        return true;
      },
    });
    expect(await saveGeneratedTool({ toolId: "t1" }, d as never)).toEqual({
      status: "saved",
      toolId: "t1",
    });
    expect(await saveGeneratedTool({ toolId: "t1" }, d as never)).toEqual({
      status: "already_saved",
      toolId: "t1",
    });
    expect(prompts).toBe(1);
    // already_saved audits too, distinct from the earlier "saved" row.
    const rows = auditRows(d.db);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.hitl_status).toBe("not_required");
  });

  test("saving after the artifact CHANGED prompts again — and the resave actually succeeds", async () => {
    let prompts = 0;
    const d = deps({
      requestApproval: async () => {
        prompts++;
        return true;
      },
    });
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    (d.registry as ToolgenRegistry).register(envelopeWithBody("return 2;"), async () => {});
    const second = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(prompts).toBe(2); // else the standing approval widens to bytes nobody approved
    // Not merely "prompted again" -- the resave must actually persist the NEW bytes, not collide
    // with the row the first save already wrote under the same tool_id.
    expect(second).toEqual({ status: "saved", toolId: "t1" });
    const pub = (await ensureToolgenKeypair(d.vault)).pubkeyB64;
    const r = await readVerifiedSavedTool(d.configDir, "t1", pub);
    if (!r.ok) throw new Error("expected a verified save");
    expect(r.artifact.body).toBe("return 2;");
  });

  test("a save does NOT kill the running child", async () => {
    let closed = 0;
    const d = deps({
      registryClose: async () => {
        closed++;
      },
    });
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(closed).toBe(0);
  });
});

describe("saveGeneratedTool — repairing a disabled row", () => {
  test("a DISABLED row with a matching digest is REPAIRED, not reported already_saved", async () => {
    let prompts = 0;
    const d = deps({
      requestApproval: async () => {
        prompts++;
        return true;
      },
    });
    await saveGeneratedTool({ toolId: "t1" }, d as never);

    await rm(join(savedToolDir(d.configDir, "t1"), "artifact.sig")); // corrupt the disk

    // Task 8 (boot reconciliation) has not landed on this branch yet -- this reproduces exactly
    // the state its pass 1 would leave behind for THIS corruption (readVerifiedSavedTool would
    // return `{ ok: false, reason: "signature_missing" }` for a missing artifact.sig; Task 8's
    // pass 1 sets `disabled_reason` to that exact value).
    setSavedToolDisabled(d.db, "t1", "signature_missing");
    expect(getSavedTool(d.db, "t1")?.disabledReason).toBe("signature_missing");

    expect(await saveGeneratedTool({ toolId: "t1" }, d as never)).toEqual({
      status: "repaired",
      toolId: "t1",
    });
    expect(getSavedTool(d.db, "t1")?.disabledReason).toBeNull();
    const pub = (await ensureToolgenKeypair(d.vault)).pubkeyB64;
    expect(await readVerifiedSavedTool(d.configDir, "t1", pub)).toMatchObject({ ok: true });
    expect(prompts).toBe(1); // the bytes were already approved; a second prompt buys nothing

    const rows = auditRows(d.db);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.hitl_status).toBe("not_required");
  });

  test("would fail if already_saved short-circuited a disabled row (regression guard)", async () => {
    // A gate that checked ONLY the digest (never disabled_reason) before the healthy/repair split
    // would report `already_saved` here forever, and the tool would stay dead with no user-facing
    // way to fix it -- this is the exact defect this task exists to keep closed.
    const d = deps();
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    setSavedToolDisabled(d.db, "t1", "artifact_missing");
    const out = await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(out).not.toEqual({ status: "already_saved", toolId: "t1" });
    expect(out).toEqual({ status: "repaired", toolId: "t1" });
  });

  test("repair preserves approved_at — no NEW approval happened", async () => {
    const fixedNow = (() => {
      let n = 100;
      return () => n++;
    })();
    const d = deps({ now: fixedNow });
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    const approvedAtBefore = getSavedTool(d.db, "t1")?.approvedAt;
    setSavedToolDisabled(d.db, "t1", "pubkey_rotated");
    await saveGeneratedTool({ toolId: "t1" }, d as never);
    expect(getSavedTool(d.db, "t1")?.approvedAt).toBe(approvedAtBefore as number);
  });
});
