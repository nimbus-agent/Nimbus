import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatadogSyncable } from "../../../src/connectors/datadog-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureDatadogMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-dd1:";

const MONITORS_DEFAULT_URL = "https://api.datadoghq.com/api/v1/monitor";
const MONITORS_EU_URL = "https://api.datadoghq.eu/api/v1/monitor";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

describe("datadog-sync — credential short-circuits", () => {
  test("returns noop when neither vault key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createDatadogSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("datadog"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when only api_key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("datadog.api_key", "datadog-stub-api-key");
      const syncable = createDatadogSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("datadog"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when only app_key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("datadog.app_key", "datadog-stub-app-key");
      const syncable = createDatadogSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("datadog"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when api_key is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("datadog.api_key", "   ");
      await iso.vault.set("datadog.app_key", "datadog-stub-app-key");
      const syncable = createDatadogSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("datadog"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when app_key is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("datadog.api_key", "datadog-stub-api-key");
      await iso.vault.set("datadog.app_key", "   ");
      const syncable = createDatadogSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("datadog"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createDatadogSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("datadog"), "preserved-cursor");
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("datadog-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("datadog.api_key", "datadog-stub-api-key");
    await fixture.vault.set("datadog.app_key", "datadog-stub-app-key");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request path", () => {
    test("uses default datadoghq.com site when datadog.site is unset", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      await createDatadogSyncable(ENSURE_MCP).sync(fixture.createSyncContext("datadog"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(MONITORS_DEFAULT_URL);
    });

    test("uses custom site when datadog.site is set", async () => {
      await fixture.vault.set("datadog.site", "datadoghq.eu");
      fixture.fetchMock.respond("GET", MONITORS_EU_URL, []);
      await createDatadogSyncable(ENSURE_MCP).sync(fixture.createSyncContext("datadog"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(MONITORS_EU_URL);
    });

    test("whitespace-only datadog.site falls back to default", async () => {
      await fixture.vault.set("datadog.site", "   ");
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      await createDatadogSyncable(ENSURE_MCP).sync(fixture.createSyncContext("datadog"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(MONITORS_DEFAULT_URL);
    });

    test("sends DD-API-KEY + DD-APPLICATION-KEY + Accept headers", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      await createDatadogSyncable(ENSURE_MCP).sync(fixture.createSyncContext("datadog"), null);
      const call = fixture.fetchMock.firstCall();
      expect(call.headers["dd-api-key"]).toBe("datadog-stub-api-key");
      expect(call.headers["dd-application-key"]).toBe("datadog-stub-app-key");
      expect(call.headers["accept"]).toBe("application/json");
    });

    test("non-200 → no upserts, returns http-empty pass cursor", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, { error: "boom" }, { status: 500 });
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("invalid JSON → returns parse-empty pass cursor", async () => {
      fixture.fetchMock.respondWithText("GET", MONITORS_DEFAULT_URL, "<html>not json</html>");
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("non-array root JSON → 0 upserts, success pass cursor", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, { monitors: [] });
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("indexing skip paths", () => {
    test("numeric id is stringified into external_id", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [{ id: 12345, name: "NumericIdMon" }]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'datadog'",
        )
        .get();
      expect(row?.external_id).toBe("12345");
      expect(row?.title).toBe("NumericIdMon");
    });

    test("string id is used verbatim", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [{ id: "mon-abc", name: "StrIdMon" }]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'datadog'",
        )
        .get();
      expect(row?.external_id).toBe("mon-abc");
    });

    test("boolean id is skipped", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        { id: true, name: "BoolId" },
        { id: "kept", name: "Kept" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'datadog'",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["kept"]);
    });

    test("null id is skipped", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        { id: null, name: "NullId" },
        { id: "kept", name: "Kept" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("missing id is skipped", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        { name: "NoIdField" },
        { id: "kept", name: "Kept" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("missing/empty name falls back to 'monitor <id>'", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        { id: "no-name" },
        { id: "empty-name", name: "" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(2);
      const rows = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'datadog' ORDER BY external_id",
        )
        .all();
      expect(rows).toEqual([
        { external_id: "empty-name", title: "monitor empty-name" },
        { external_id: "no-name", title: "monitor no-name" },
      ]);
    });

    test("non-record entry is skipped", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        42,
        "string",
        null,
        { id: "kept", name: "Kept" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });
  });

  describe("cursor decode", () => {
    test("null cursor returns success pass cursor with pass:1", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
      const decoded = JSON.parse(
        Buffer.from(res.cursor!.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      ) as { pass: number };
      expect(decoded.pass).toBe(1);
    });

    test("any incoming cursor is replaced on success (pass cursor)", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        encodeCursor({ arbitrary: true }),
      );
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("full-cycle", () => {
    test("three monitors → three upserts in ascending external_id order", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, [
        { id: "mon-a", name: "Monitor A" },
        { id: "mon-b", name: "Monitor B" },
        { id: "mon-c", name: "Monitor C" },
      ]);
      const res = await createDatadogSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("datadog"),
        null,
      );
      expect(res.itemsUpserted).toBe(3);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'datadog' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual([
        "mon-a",
        "mon-b",
        "mon-c",
      ]);
    });

    test("emits no notifications", async () => {
      fixture.fetchMock.respond("GET", MONITORS_DEFAULT_URL, []);
      await createDatadogSyncable(ENSURE_MCP).sync(fixture.createSyncContext("datadog"), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
