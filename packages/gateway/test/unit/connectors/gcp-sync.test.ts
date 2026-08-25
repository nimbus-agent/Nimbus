import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGcpSyncable } from "../../../src/connectors/gcp-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureGcpMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-gcp1:";
const PROJECT_ID = "gcp-stub-project";
const CRED_PATH = "/var/secrets/gcp-stub-credentials.json";

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

describe("gcp-sync — credential short-circuits", () => {
  test("no vault keys → noop, no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createGcpSyncable(ENSURE_MCP).sync(iso.createSyncContext("gcp"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(iso.spawnMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("missing credentials_json_path (project_id only) → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("gcp.project_id", PROJECT_ID);
      await createGcpSyncable(ENSURE_MCP).sync(iso.createSyncContext("gcp"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("missing project_id (cred path only) → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("gcp.credentials_json_path", CRED_PATH);
      await createGcpSyncable(ENSURE_MCP).sync(iso.createSyncContext("gcp"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("whitespace-only credentials_json_path → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("gcp.credentials_json_path", "   ");
      await iso.vault.set("gcp.project_id", PROJECT_ID);
      await createGcpSyncable(ENSURE_MCP).sync(iso.createSyncContext("gcp"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("whitespace-only project_id → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("gcp.credentials_json_path", CRED_PATH);
      await iso.vault.set("gcp.project_id", "   ");
      await createGcpSyncable(ENSURE_MCP).sync(iso.createSyncContext("gcp"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createGcpSyncable(ENSURE_MCP).sync(
        iso.createSyncContext("gcp"),
        "preserved-cursor",
      );
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("gcp-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    fixture.spawnMock.install();
    await fixture.vault.set("gcp.credentials_json_path", CRED_PATH);
    await fixture.vault.set("gcp.project_id", PROJECT_ID);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("spawn invocation", () => {
    test("binary `gcloud`; argv contains project id and --format json", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout: "{}" });
      await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(fixture.spawnMock.calls[0]!.binary).toBe("gcloud");
      expect(fixture.spawnMock.calls[0]!.argv).toEqual([
        "projects",
        "describe",
        PROJECT_ID,
        "--format",
        "json",
      ]);
    });

    test("env contains GOOGLE_APPLICATION_CREDENTIALS = cred path", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout: "{}" });
      await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      const env = fixture.spawnMock.calls[0]!.env;
      expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBe(CRED_PATH);
    });

    test("non-zero exit → http-empty pass cursor (preserves prior cursor)", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 1, stderr: "PermissionDenied" });
      const res = await createGcpSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("gcp"),
        "preserved-cursor",
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe("preserved-cursor");
    });

    test("non-zero exit + null cursor → falls back to pass-1 default", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 1 });
      const res = await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    });

    test("invalid JSON → parse-empty pass cursor (pass-1 default)", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout: "not-json" });
      const res = await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    });

    test("project_id is trimmed in argv (leading/trailing whitespace stripped)", async () => {
      await fixture.vault.set("gcp.project_id", `  ${PROJECT_ID}  `);
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout: "{}" });
      await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(fixture.spawnMock.calls[0]!.argv).toContain(PROJECT_ID);
      expect(fixture.spawnMock.calls[0]!.argv).not.toContain(`  ${PROJECT_ID}  `);
    });
  });

  describe("indexing", () => {
    test("upserts project with name as title", async () => {
      fixture.spawnMock.respond("gcloud", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "My GCP Project", projectId: PROJECT_ID }),
      });
      const res = await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<
          { external_id: string; title: string; body_preview: string | null; metadata: string },
          []
        >("SELECT external_id, title, body_preview, metadata FROM item WHERE service = 'gcp'")
        .get();
      expect(row?.external_id).toBe(PROJECT_ID);
      expect(row?.title).toBe("My GCP Project");
      expect(row?.body_preview).toBe(PROJECT_ID);
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.projectId).toBe(PROJECT_ID);
    });

    test("missing name → title falls back to projectId", async () => {
      fixture.spawnMock.respond("gcloud", {
        exitCode: 0,
        stdout: JSON.stringify({ projectNumber: "123" }),
      });
      await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'gcp'",
        )
        .get();
      expect(row?.external_id).toBe(PROJECT_ID);
      expect(row?.title).toBe(PROJECT_ID);
    });

    test("non-record root → still upserts project (name falls back to projectId)", async () => {
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout: "[1,2,3]" });
      const res = await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'gcp'")
        .get();
      expect(row?.title).toBe(PROJECT_ID);
    });

    test("empty-string name → stored as empty title (stringField accepts empty)", async () => {
      fixture.spawnMock.respond("gcloud", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "" }),
      });
      await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'gcp'")
        .get();
      expect(row?.title).toBe("");
    });
  });

  describe("full-cycle", () => {
    test("success → pass-1 cursor; bytesTransferred = stdout length; emits no notifications", async () => {
      const stdout = JSON.stringify({ name: "p", projectId: PROJECT_ID });
      fixture.spawnMock.respond("gcloud", { exitCode: 0, stdout });
      const res = await createGcpSyncable(ENSURE_MCP).sync(fixture.createSyncContext("gcp"), null);
      expect(res.cursor).toBe(PASS_1_CURSOR);
      expect(res.hasMore).toBe(false);
      expect(res.bytesTransferred).toBe(stdout.length);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
