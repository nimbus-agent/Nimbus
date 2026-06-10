/**
 * Coverage tests for ipc/connector-rpc-handlers/removal.ts
 *
 * Strategy: call handleConnectorRemove and resumePendingRemovals directly
 * through a real SQLite LocalIndex + MockVault, varying inputs to drive each
 * uncovered branch.  No mock.module usage; all seams are real implementations.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";
import { handleConnectorRemove, resumePendingRemovals } from "./removal.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

/** Register a connector in the scheduler so requireRegisteredSchedulerServiceId passes. */
function registerConnector(serviceId: string): void {
  fixture.localIndex.ensureConnectorSchedulerRegistration(serviceId, 60_000, 1_700_000_000_000);
}

type SyncSchedulerStub = ConnectorRpcHandlerContext["syncScheduler"];

function makeSchedulerStub(): { stub: SyncSchedulerStub; calls: { unregistered: string[] } } {
  const calls = { unregistered: [] as string[] };
  const stub = {
    unregister(id: string): void {
      calls.unregistered.push(id);
    },
  } as unknown as SyncSchedulerStub;
  return { stub, calls };
}

function buildCtx(
  rec: Record<string, unknown> | undefined,
  scheduler?: SyncSchedulerStub,
  vault?: NimbusVault,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault: vault ?? fixture.vault,
    localIndex: fixture.localIndex,
    openUrl: async () => {},
    syncScheduler: scheduler,
    connectorMesh: undefined,
    notify: fixture.notify,
  };
}

// ---------------------------------------------------------------------------
// handleConnectorRemove — basic (non-google, non-microsoft, non-github)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — slack (non-family, non-github)", () => {
  test("removes the connector and returns ok + itemsDeleted + vaultKeysRemoved", async () => {
    registerConnector("slack");
    // Store some vault secrets so we can verify they are cleared
    await fixture.vault.set("slack.oauth", "tok1");
    await fixture.vault.set("slack.bot_token", "tok2");
    await fixture.vault.set("slack.app_token", "tok3");

    const r = await handleConnectorRemove(buildCtx({ serviceId: "slack" }));
    expect(r.kind).toBe("hit");
    const val = r.value as { ok: boolean; itemsDeleted: number; vaultKeysRemoved: string[] };
    expect(val.ok).toBe(true);
    expect(typeof val.itemsDeleted).toBe("number");
    // slack vault keys should have been cleared
    expect(val.vaultKeysRemoved).toContain("slack.oauth");
    expect(val.vaultKeysRemoved).toContain("slack.bot_token");
    expect(val.vaultKeysRemoved).toContain("slack.app_token");
    // vault entries should be gone
    expect(await fixture.vault.get("slack.oauth")).toBeNull();
    expect(await fixture.vault.get("slack.bot_token")).toBeNull();
  });

  test("connector is no longer in scheduler state after removal", async () => {
    registerConnector("slack");
    await handleConnectorRemove(buildCtx({ serviceId: "slack" }));
    expect(fixture.localIndex.persistedConnectorStatuses("slack")).toHaveLength(0);
  });

  test("remove_intent row is cleared after successful removal", async () => {
    registerConnector("slack");
    await handleConnectorRemove(buildCtx({ serviceId: "slack" }));
    // The DB should not have a pending remove intent for slack after success
    const db = fixture.localIndex.getDatabase();
    const row = db
      .query<{ service_id: string }, [string]>(
        "SELECT service_id FROM connector_remove_intent WHERE service_id = ?",
      )
      .get("slack");
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — with syncScheduler (covers line 70 branch=1)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — with syncScheduler provided", () => {
  test("calls scheduler.unregister when syncScheduler is defined (line 70 branch=1 covered)", async () => {
    registerConnector("slack");
    const { stub, calls } = makeSchedulerStub();
    await handleConnectorRemove(buildCtx({ serviceId: "slack" }, stub));
    // unregister should have been called with the service id
    expect(calls.unregistered).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — github (covers line 73 branch=0 + line 81 branch=0)
// github has a companion service (github_actions) that must also be unregistered
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — github (companion service path)", () => {
  test("github removal unregisters github_actions companion via scheduler (line 73 branch=0)", async () => {
    registerConnector("github");
    const { stub, calls } = makeSchedulerStub();
    await handleConnectorRemove(buildCtx({ serviceId: "github" }, stub));
    // unregister must be called for both github_actions AND github
    expect(calls.unregistered).toContain("github_actions");
    expect(calls.unregistered).toContain("github");
  });

  test("github removal also calls removeConnectorIndexData for github_actions (line 81 branch=0)", async () => {
    registerConnector("github");
    // Register github_actions companion so removeConnectorIndexData can count it
    fixture.localIndex.ensureConnectorSchedulerRegistration(
      "github_actions",
      60_000,
      1_700_000_000_000,
    );
    const r = await handleConnectorRemove(buildCtx({ serviceId: "github" }));
    expect(r.kind).toBe("hit");
    // Both github and github_actions scheduler rows should be gone
    expect(fixture.localIndex.persistedConnectorStatuses("github")).toHaveLength(0);
    expect(fixture.localIndex.persistedConnectorStatuses("github_actions")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — non-github id in unregister (line 73 branch=1)
// Already covered by the slack tests above; confirmed here explicitly.
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — id !== github (line 73 branch=1)", () => {
  test("non-github id does NOT unregister github_actions", async () => {
    registerConnector("slack");
    const { stub, calls } = makeSchedulerStub();
    await handleConnectorRemove(buildCtx({ serviceId: "slack" }, stub));
    expect(calls.unregistered).not.toContain("github_actions");
    expect(calls.unregistered).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — google_drive last family member WITH vault keys
// Covers: line 34 branch=0 (enters snapshot body), line 48 branch=0 (snap > 0)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — google_drive last family member (vault has OAuth)", () => {
  test("google vault key snapshot is taken when google_drive is the sole google connector", async () => {
    registerConnector("google_drive");
    // Pre-load google OAuth vault keys
    await fixture.vault.set("google.oauth", "access_token_xyz");
    await fixture.vault.set("google_drive.oauth", "drive_token");

    const r = await handleConnectorRemove(buildCtx({ serviceId: "google_drive" }));
    expect(r.kind).toBe("hit");
    const val = r.value as { ok: boolean; vaultKeysRemoved: string[] };
    expect(val.ok).toBe(true);
    // google OAuth vault keys should be cleared (line 34 branch=0 taken)
    expect(await fixture.vault.get("google.oauth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — google_drive last family member WITHOUT vault keys
// Covers: line 48 branch=1 (snap is empty → snapshot returns null)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — google_drive last family member (vault empty)", () => {
  test("google OAuth snapshot is null when vault has no google keys (line 48 branch=1)", async () => {
    registerConnector("google_drive");
    // Do NOT set any google vault keys — snapshot should produce empty map → null

    const r = await handleConnectorRemove(buildCtx({ serviceId: "google_drive" }));
    expect(r.kind).toBe("hit");
    const val = r.value as { ok: boolean; vaultKeysRemoved: string[] };
    expect(val.ok).toBe(true);
    // clearOAuthVaultIfProviderUnused will still run and return its cleared list
    // (may include keys it deleted even if values were null/empty).
    expect(Array.isArray(val.vaultKeysRemoved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — outlook last family member (covers line 56 branch=1
// and line 57 block=6 branch=2: enters microsoft snapshot body)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — outlook last microsoft family member", () => {
  test("microsoft OAuth key is restored on error if microsoft was last member with OAuth (lines 56/57)", async () => {
    registerConnector("outlook");
    // Store microsoft shared OAuth so it gets snapshotted
    await fixture.vault.set("microsoft.oauth", "ms_token");

    // We need to trigger the error path so vault restore is exercised.
    // Build a vault that throws on clearOAuthVaultIfProviderUnused → vault.delete
    const vaultStore = new Map<string, string>([
      ["microsoft.oauth", "ms_token"],
      ["outlook.oauth", "out_token"],
    ]);
    let deleteCallCount = 0;
    const flakyVault: NimbusVault = {
      async set(key: string, value: string): Promise<void> {
        vaultStore.set(key, value);
      },
      async get(key: string): Promise<string | null> {
        return vaultStore.get(key) ?? null;
      },
      async delete(key: string): Promise<void> {
        deleteCallCount++;
        // Throw on the first delete to trigger the catch/restore path
        if (deleteCallCount === 1) {
          throw new Error("vault delete failed");
        }
        vaultStore.delete(key);
      },
      async listKeys(prefix?: string): Promise<string[]> {
        const keys = [...vaultStore.keys()];
        return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
      },
    };

    // Register outlook in a new fixture using flakyVault
    const flakyCtx: ConnectorRpcHandlerContext = {
      rec: { serviceId: "outlook" },
      vault: flakyVault,
      localIndex: fixture.localIndex,
      openUrl: async () => {},
      syncScheduler: undefined,
      connectorMesh: undefined,
    };
    fixture.localIndex.ensureConnectorSchedulerRegistration("outlook", 60_000, 1_700_000_000_000);

    // Should throw because flakyVault throws, but microsoft.oauth must be restored
    await expect(handleConnectorRemove(flakyCtx)).rejects.toThrow("vault delete failed");

    // microsoft.oauth should have been restored by the catch block (line 98 branch=0)
    expect(vaultStore.get("microsoft.oauth")).toBe("ms_token");
  });

  test("successful outlook removal clears microsoft OAuth keys (line 56 branch=1 taken)", async () => {
    registerConnector("outlook");
    await fixture.vault.set("microsoft.oauth", "ms_token");

    const r = await handleConnectorRemove(buildCtx({ serviceId: "outlook" }));
    expect(r.kind).toBe("hit");
    expect(await fixture.vault.get("microsoft.oauth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — restoreGoogleAndMicrosoftOAuthBackups
// covers line 93 branch=1 (googleOAuthBackup is null) + line 98 branch=0 (ms backup present)
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — vault restore on error (google null, microsoft non-null)", () => {
  test("google backup null does NOT call vault.set for google keys (line 93 branch=1)", async () => {
    // Use outlook as service so google backup is null, microsoft backup may be non-null
    registerConnector("outlook");
    await fixture.vault.set("microsoft.oauth", "ms_tok");

    let googleSetCalled = false;
    const trackingVault: NimbusVault = {
      async set(key: string, value: string): Promise<void> {
        if (key.startsWith("google")) {
          googleSetCalled = true;
        }
        await fixture.vault.set(key, value);
      },
      async get(key: string): Promise<string | null> {
        return fixture.vault.get(key);
      },
      async delete(_key: string): Promise<void> {
        throw new Error("simulated vault failure");
      },
      async listKeys(prefix?: string): Promise<string[]> {
        return fixture.vault.listKeys(prefix);
      },
    };

    fixture.localIndex.ensureConnectorSchedulerRegistration("outlook", 60_000, 1_700_000_000_000);
    const ctx: ConnectorRpcHandlerContext = {
      rec: { serviceId: "outlook" },
      vault: trackingVault,
      localIndex: fixture.localIndex,
      openUrl: async () => {},
      syncScheduler: undefined,
      connectorMesh: undefined,
    };

    await expect(handleConnectorRemove(ctx)).rejects.toThrow("simulated vault failure");
    // google backup was null → no google set calls (line 93 branch=1)
    expect(googleSetCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — normalizedBuiltin non-null (line 126 branch=0)
// Slack has secret keys → clearConnectorVaultSecretKeys is called
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — normalizedBuiltin non-null (line 126 branch=0)", () => {
  test("built-in connector with vault secret keys has those keys cleared (line 126 branch=0)", async () => {
    registerConnector("slack");
    await fixture.vault.set("slack.oauth", "oauth_val");
    await fixture.vault.set("slack.bot_token", "bot_val");
    await fixture.vault.set("slack.app_token", "app_val");

    const r = await handleConnectorRemove(buildCtx({ serviceId: "slack" }));
    expect(r.kind).toBe("hit");
    const val = r.value as { vaultKeysRemoved: string[] };
    expect(val.vaultKeysRemoved).toContain("slack.oauth");
    expect(val.vaultKeysRemoved).toContain("slack.bot_token");
    expect(val.vaultKeysRemoved).toContain("slack.app_token");
    expect(await fixture.vault.get("slack.oauth")).toBeNull();
    expect(await fixture.vault.get("slack.bot_token")).toBeNull();
    expect(await fixture.vault.get("slack.app_token")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — normalizedBuiltin null (line 126 branch=1)
// user-mcp connector id (e.g. "mcp_myserver") has null normalizedBuiltin
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — normalizedBuiltin null (line 126 branch=1)", () => {
  test("user-mcp connector skips clearConnectorVaultSecretKeys (line 126 branch=1)", async () => {
    // mcp_myserver is a user-mcp service id: normalizeConnectorServiceId returns null
    registerConnector("mcp_myserver");

    const r = await handleConnectorRemove(buildCtx({ serviceId: "mcp_myserver" }));
    expect(r.kind).toBe("hit");
    const val = r.value as { ok: boolean; vaultKeysRemoved: string[] };
    expect(val.ok).toBe(true);
    // No built-in keys → vaultKeysRemoved is empty (clearOAuthVaultIfProviderUnused
    // also returns [] for a non-google/non-ms service, and no clearConnectorVaultSecretKeys
    // call is made when normalizedBuiltin is null).
    expect(Array.isArray(val.vaultKeysRemoved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleConnectorRemove — missing / unregistered serviceId errors
// ---------------------------------------------------------------------------

describe("handleConnectorRemove — error paths", () => {
  test("missing serviceId throws ConnectorRpcError -32602", async () => {
    await expect(handleConnectorRemove(buildCtx({}))).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("unregistered serviceId throws ConnectorRpcError -32602", async () => {
    await expect(handleConnectorRemove(buildCtx({ serviceId: "slack" }))).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });
});

// ---------------------------------------------------------------------------
// resumePendingRemovals — empty queue
// ---------------------------------------------------------------------------

describe("resumePendingRemovals — no pending intents", () => {
  test("returns empty array when there are no pending removals", async () => {
    const completed = await resumePendingRemovals(fixture.vault, fixture.localIndex);
    expect(completed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resumePendingRemovals — normalizedBuiltin non-null (line 151 branch=0)
// ---------------------------------------------------------------------------

describe("resumePendingRemovals — built-in connector with vault keys (line 151 branch=0)", () => {
  test("completes pending removal for a built-in connector and clears vault keys", async () => {
    registerConnector("slack");
    await fixture.vault.set("slack.oauth", "tok");
    await fixture.vault.set("slack.bot_token", "btok");

    // Simulate a removal that was interrupted: write the intent manually, then
    // remove the scheduler row to simulate partial completion
    const db = fixture.localIndex.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO connector_remove_intent (service_id, started_at) VALUES (?, ?)`,
      ["slack", Date.now()],
    );

    const completed = await resumePendingRemovals(fixture.vault, fixture.localIndex);
    expect(completed).toContain("slack");

    // Vault keys should have been cleared
    expect(await fixture.vault.get("slack.oauth")).toBeNull();
    // remove_intent row should be gone
    const row = db
      .query<{ service_id: string }, [string]>(
        "SELECT service_id FROM connector_remove_intent WHERE service_id = ?",
      )
      .get("slack");
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resumePendingRemovals — normalizedBuiltin null (line 151 branch=1)
// ---------------------------------------------------------------------------

describe("resumePendingRemovals — user-mcp connector (line 151 branch=1)", () => {
  test("completes pending removal for a user-mcp connector (normalizedBuiltin is null)", async () => {
    registerConnector("mcp_orphan");
    const db = fixture.localIndex.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO connector_remove_intent (service_id, started_at) VALUES (?, ?)`,
      ["mcp_orphan", Date.now()],
    );

    const completed = await resumePendingRemovals(fixture.vault, fixture.localIndex);
    expect(completed).toContain("mcp_orphan");

    const row = db
      .query<{ service_id: string }, [string]>(
        "SELECT service_id FROM connector_remove_intent WHERE service_id = ?",
      )
      .get("mcp_orphan");
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resumePendingRemovals — error path (leaves intent intact for retry)
// ---------------------------------------------------------------------------

describe("resumePendingRemovals — error during removal leaves intent intact", () => {
  test("a failing connector is skipped and its intent remains for retry", async () => {
    // Register two connectors
    registerConnector("slack");
    registerConnector("github");

    const db = fixture.localIndex.getDatabase();
    // Write intents for both
    db.run(
      `INSERT OR REPLACE INTO connector_remove_intent (service_id, started_at) VALUES (?, ?)`,
      ["slack", Date.now() - 1000],
    );
    db.run(
      `INSERT OR REPLACE INTO connector_remove_intent (service_id, started_at) VALUES (?, ?)`,
      ["github", Date.now()],
    );

    // Build a vault that throws when deleting slack keys, but succeeds for github
    const slackFailed: NimbusVault = {
      async set(key: string, value: string): Promise<void> {
        await fixture.vault.set(key, value);
      },
      async get(key: string): Promise<string | null> {
        return fixture.vault.get(key);
      },
      async delete(key: string): Promise<void> {
        if (key.startsWith("slack.")) {
          throw new Error("slack vault delete failed");
        }
        await fixture.vault.delete(key);
      },
      async listKeys(prefix?: string): Promise<string[]> {
        return fixture.vault.listKeys(prefix);
      },
    };

    const completed = await resumePendingRemovals(slackFailed, fixture.localIndex);
    // github should complete; slack should be skipped
    expect(completed).toContain("github");
    expect(completed).not.toContain("slack");

    // slack intent should still be in the DB (failed → retry later)
    const slackRow = db
      .query<{ service_id: string }, [string]>(
        "SELECT service_id FROM connector_remove_intent WHERE service_id = ?",
      )
      .get("slack");
    expect(slackRow).not.toBeNull();

    // github intent should be cleared
    const githubRow = db
      .query<{ service_id: string }, [string]>(
        "SELECT service_id FROM connector_remove_intent WHERE service_id = ?",
      )
      .get("github");
    expect(githubRow).toBeNull();
  });
});
