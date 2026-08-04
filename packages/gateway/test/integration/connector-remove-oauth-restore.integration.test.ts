import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { NULL_EGRESS_SINK } from "../../src/egress/egress-ledger.ts";
import { ToolExecutor } from "../../src/engine/executor.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { dispatchConnectorRpc } from "../../src/ipc/connector-rpc.ts";
import { MockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

const autoApproveExecutor = new ToolExecutor(
  { requestApproval: async () => true },
  { recordAudit: () => {} },
  {
    dispatch(): Promise<unknown> {
      return Promise.reject(new Error("stub — should not be called"));
    },
  },
  undefined,
  NULL_EGRESS_SINK,
);

const OAUTH_BACKUP = '{"access_token":"redacted-for-test","refresh_token":"also-redacted"}';

class FaultAfterGoogleOauthDeleteVault implements NimbusVault {
  private readonly inner = new MockVault();

  async set(key: string, value: string): Promise<void> {
    await this.inner.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
    if (key === "google.oauth") {
      throw new Error("simulated fault immediately after google.oauth delete");
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return this.inner.listKeys(prefix);
  }
}

describe("connector.remove OAuth restore (integration)", () => {
  test("restores google.oauth backup when vault fails after deleting the key", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const localIndex = new LocalIndex(db);
    const vault = new FaultAfterGoogleOauthDeleteVault();
    await vault.set("google.oauth", OAUTH_BACKUP);

    const now = 1_700_000_000_000;
    localIndex.ensureConnectorSchedulerRegistration("google_drive", 60_000, now);
    localIndex.upsert({
      id: "g1",
      service: "google_drive",
      itemType: "file",
      name: "doc",
    });

    await expect(
      dispatchConnectorRpc({
        method: "connector.remove",
        params: { serviceId: "google_drive" },
        vault,
        localIndex,
        openUrl: async () => {},
        syncScheduler: undefined,
        toolExecutor: autoApproveExecutor,
      }),
    ).rejects.toThrow(/simulated fault/);

    expect(await vault.get("google.oauth")).toBe(OAUTH_BACKUP);
    expect(localIndex.persistedConnectorStatuses("google_drive")).toEqual([]);
    expect(localIndex.search({ service: "google_drive", limit: 10 })).toEqual([]);
  });
});
