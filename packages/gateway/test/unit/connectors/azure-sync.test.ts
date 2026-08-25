import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAzureSyncable } from "../../../src/connectors/azure-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureAzureMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-az1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const PASS_1_CURSOR = encodeCursor({ pass: 1 });

async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  isolated.spawnMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

describe("azure-sync — credential short-circuits", () => {
  test("no vault keys → noop, no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createAzureSyncable(ENSURE_MCP).sync(iso.createSyncContext("azure"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(iso.spawnMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("tenant whitespace → noop, no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("azure.tenant_id", "   ");
      await iso.vault.set("azure.client_id", "az-stub-client-id");
      await iso.vault.set("azure.client_secret", "az-stub-client-secret");
      await createAzureSyncable(ENSURE_MCP).sync(iso.createSyncContext("azure"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("tenant set + client_id missing → no spawn (azureCliJson short-circuits)", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("azure.tenant_id", "az-stub-tenant");
      await iso.vault.set("azure.client_secret", "az-stub-client-secret");
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        iso.createSyncContext("azure"),
        "preserved-cursor",
      );
      expect(iso.spawnMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe("preserved-cursor");
    });
  });

  test("tenant set + client_secret missing → no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("azure.tenant_id", "az-stub-tenant");
      await iso.vault.set("azure.client_id", "az-stub-client-id");
      const res = await createAzureSyncable(ENSURE_MCP).sync(iso.createSyncContext("azure"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    });
  });

  test("all three present → spawn fires", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("azure.tenant_id", "az-stub-tenant");
      await iso.vault.set("azure.client_id", "az-stub-client-id");
      await iso.vault.set("azure.client_secret", "az-stub-client-secret");
      iso.spawnMock.respond("az", { exitCode: 0, stdout: "{}" });
      await createAzureSyncable(ENSURE_MCP).sync(iso.createSyncContext("azure"), null);
      expect(iso.spawnMock.calls).toHaveLength(1);
    });
  });
});

describe("azure-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    fixture.spawnMock.install();
    await fixture.vault.set("azure.tenant_id", "az-stub-tenant");
    await fixture.vault.set("azure.client_id", "az-stub-client-id");
    await fixture.vault.set("azure.client_secret", "az-stub-client-secret");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("spawn invocation", () => {
    test("binary is `az`; argv is account show -o json", async () => {
      fixture.spawnMock.respond("az", { exitCode: 0, stdout: "{}" });
      await createAzureSyncable(ENSURE_MCP).sync(fixture.createSyncContext("azure"), null);
      expect(fixture.spawnMock.calls[0]!.binary).toBe("az");
      expect(fixture.spawnMock.calls[0]!.argv).toEqual(["account", "show", "-o", "json"]);
    });

    test("env contains AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET", async () => {
      fixture.spawnMock.respond("az", { exitCode: 0, stdout: "{}" });
      await createAzureSyncable(ENSURE_MCP).sync(fixture.createSyncContext("azure"), null);
      const env = fixture.spawnMock.calls[0]!.env;
      expect(env["AZURE_TENANT_ID"]).toBe("az-stub-tenant");
      expect(env["AZURE_CLIENT_ID"]).toBe("az-stub-client-id");
      expect(env["AZURE_CLIENT_SECRET"]).toBe("az-stub-client-secret");
    });

    test("non-zero exit → http-empty pass cursor (preserves prior cursor)", async () => {
      fixture.spawnMock.respond("az", { exitCode: 1, stderr: "InvalidCredentials" });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        "preserved-cursor",
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe("preserved-cursor");
    });

    test("non-zero exit + null cursor → falls back to pass-1 default", async () => {
      fixture.spawnMock.respond("az", { exitCode: 1 });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        null,
      );
      expect(res.cursor).toBe(PASS_1_CURSOR);
    });

    test("invalid JSON → parse-empty pass cursor", async () => {
      fixture.spawnMock.respond("az", { exitCode: 0, stdout: "not-json" });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    });
  });

  describe("indexing", () => {
    test("upserts subscription with id + name", async () => {
      fixture.spawnMock.respond("az", {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "11111111-2222-3333-4444-555555555555",
          name: "Production Subscription",
        }),
      });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<
          { external_id: string; title: string; body_preview: string | null; metadata: string },
          []
        >("SELECT external_id, title, body_preview, metadata FROM item WHERE service = 'azure'")
        .get();
      expect(row?.external_id).toBe("11111111-2222-3333-4444-555555555555");
      expect(row?.title).toBe("Production Subscription");
      expect(row?.body_preview).toBe("11111111-2222-3333-4444-555555555555");
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.subscriptionId).toBe("11111111-2222-3333-4444-555555555555");
    });

    test("missing id → external_id is 'default'", async () => {
      fixture.spawnMock.respond("az", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "No-ID Subscription" }),
      });
      await createAzureSyncable(ENSURE_MCP).sync(fixture.createSyncContext("azure"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string; metadata: string }, []>(
          "SELECT external_id, title, metadata FROM item WHERE service = 'azure'",
        )
        .get();
      expect(row?.external_id).toBe("default");
      expect(row?.title).toBe("No-ID Subscription");
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.subscriptionId).toBeNull();
    });

    test("missing name → title falls back to id", async () => {
      fixture.spawnMock.respond("az", {
        exitCode: 0,
        stdout: JSON.stringify({ id: "sub-only-id" }),
      });
      await createAzureSyncable(ENSURE_MCP).sync(fixture.createSyncContext("azure"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'azure'",
        )
        .get();
      expect(row?.external_id).toBe("sub-only-id");
      expect(row?.title).toBe("sub-only-id");
    });

    test("missing both id and name → external_id 'default'; title 'default'", async () => {
      fixture.spawnMock.respond("az", {
        exitCode: 0,
        stdout: JSON.stringify({ unrelatedKey: "x" }),
      });
      await createAzureSyncable(ENSURE_MCP).sync(fixture.createSyncContext("azure"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'azure'",
        )
        .get();
      expect(row?.external_id).toBe("default");
      expect(row?.title).toBe("default");
    });

    test("non-record root → still upserts a 'default' subscription", async () => {
      fixture.spawnMock.respond("az", { exitCode: 0, stdout: "[1,2,3]" });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'azure'")
        .get();
      expect(row?.external_id).toBe("default");
    });
  });

  describe("full-cycle", () => {
    test("success → cursor is pass-1 default; emits no notifications; bytesTransferred = stdout length", async () => {
      const stdout = JSON.stringify({ id: "sub-123", name: "Prod" });
      fixture.spawnMock.respond("az", { exitCode: 0, stdout });
      const res = await createAzureSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("azure"),
        null,
      );
      expect(res.cursor).toBe(PASS_1_CURSOR);
      expect(res.hasMore).toBe(false);
      expect(res.bytesTransferred).toBe(stdout.length);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
