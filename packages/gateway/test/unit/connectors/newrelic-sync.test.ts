import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createNewrelicSyncable } from "../../../src/connectors/newrelic-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureNewrelicMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-nr1:";

const APPS_URL = "https://api.newrelic.com/v2/applications.json";

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

describe("newrelic-sync — credential short-circuits", () => {
  test("returns noop when api_key is not set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createNewrelicSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("newrelic"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when api_key is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("newrelic.api_key", "   ");
      const syncable = createNewrelicSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("newrelic"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createNewrelicSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("newrelic"), "preserved-cursor");
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("newrelic-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("newrelic.api_key", "newrelic-stub-key");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request path", () => {
    test("sends X-Api-Key header (NOT Authorization) and Accept: application/json", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      await createNewrelicSyncable(ENSURE_MCP).sync(fixture.createSyncContext("newrelic"), null);
      const call = fixture.fetchMock.firstCall();
      expect(call.headers["x-api-key"]).toBe("newrelic-stub-key");
      expect(call.headers["accept"]).toBe("application/json");
      expect(call.headers["authorization"]).toBeUndefined();
    });

    test("requests the exact apps URL with no query params", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      await createNewrelicSyncable(ENSURE_MCP).sync(fixture.createSyncContext("newrelic"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(APPS_URL);
    });

    test("non-200 → no upserts, returns http-empty pass cursor", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { error: "boom" }, { status: 500 });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("invalid JSON → returns parse-empty pass cursor", async () => {
      fixture.fetchMock.respondWithText("GET", APPS_URL, "<html>not json</html>");
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("non-record root JSON (bare array) → 0 upserts, success pass cursor", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, []);
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("indexing skip paths", () => {
    test("applications field missing → 0 upserts", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { other: "field" });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("applications: null → 0 upserts (non-array branch)", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: null });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("empty applications array → 0 upserts, success cursor", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("id-only → external_id = 'app:' + id; title falls back to ext", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [{ id: "abc" }] });
      await createNewrelicSyncable(ENSURE_MCP).sync(fixture.createSyncContext("newrelic"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'newrelic'",
        )
        .get();
      expect(row?.external_id).toBe("app:abc");
      expect(row?.title).toBe("app:abc");
    });

    test("name-only (id missing) → external_id = name (no prefix); title = name", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [{ name: "MyApp" }] });
      await createNewrelicSyncable(ENSURE_MCP).sync(fixture.createSyncContext("newrelic"), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'newrelic'",
        )
        .get();
      expect(row?.external_id).toBe("MyApp");
      expect(row?.title).toBe("MyApp");
    });

    test("non-record entry is skipped", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, {
        applications: [42, "string", null, { id: "kept", name: "Kept" }],
      });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'newrelic'",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["app:kept"]);
    });

    test("entry missing both id and name is skipped", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, {
        applications: [{ other: "field" }, { id: "kept", name: "Kept" }],
      });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });
  });

  describe("cursor decode", () => {
    test("null cursor returns success pass cursor with pass:1", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
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
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        encodeCursor({ arbitrary: true }),
      );
      expect(res.cursor).not.toBeNull();
      expect(res.cursor!.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("full-cycle", () => {
    test("three applications → three upserts in ascending external_id order", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, {
        applications: [
          { id: "a1", name: "App One" },
          { id: "a2", name: "App Two" },
          { id: "a3", name: "App Three" },
        ],
      });
      const res = await createNewrelicSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("newrelic"),
        null,
      );
      expect(res.itemsUpserted).toBe(3);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'newrelic' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual([
        "app:a1",
        "app:a2",
        "app:a3",
      ]);
    });

    test("emits no notifications", async () => {
      fixture.fetchMock.respond("GET", APPS_URL, { applications: [] });
      await createNewrelicSyncable(ENSURE_MCP).sync(fixture.createSyncContext("newrelic"), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
