import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGrafanaSyncable } from "../../../src/connectors/grafana-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureGrafanaMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-grafana1:";

const SEARCH_RE = /^https:\/\/grafana\.example\.com\/api\/search\?type=dash-db&limit=30$/;

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

describe("grafana-sync — credential short-circuits", () => {
  test("returns noop when neither vault key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("grafana"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when only url is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("grafana.url", "https://grafana.example.com");
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("grafana"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when only api_token is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("grafana.api_token", "grafana-stub-token");
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("grafana"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when url is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("grafana.url", "   ");
      await iso.vault.set("grafana.api_token", "grafana-stub-token");
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("grafana"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when api_token is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("grafana.url", "https://grafana.example.com");
      await iso.vault.set("grafana.api_token", "   ");
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("grafana"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createGrafanaSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("grafana"), "preserved-cursor");
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("grafana-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("grafana.url", "https://grafana.example.com");
    await fixture.vault.set("grafana.api_token", "grafana-stub-token");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request path", () => {
    test("sends Authorization: Bearer <token> and Accept: application/json", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, []);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      const call = fixture.fetchMock.firstCall();
      expect(call.headers["authorization"]).toBe("Bearer grafana-stub-token");
      expect(call.headers["accept"]).toBe("application/json");
    });

    test("strips trailing slash from base url", async () => {
      await fixture.vault.set("grafana.url", "https://grafana.example.com/");
      fixture.fetchMock.respond("GET", SEARCH_RE, []);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(
        "https://grafana.example.com/api/search?type=dash-db&limit=30",
      );
    });

    test("non-200 → no upserts, returns http-empty pass cursor", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, { error: "boom" }, { status: 500 });
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("invalid JSON → returns parse-empty pass cursor", async () => {
      fixture.fetchMock.respondWithText("GET", SEARCH_RE, "<html>not json</html>");
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("non-array JSON body → 0 upserts, success pass cursor", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, { dashboards: [] });
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("indexing skip paths", () => {
    test("missing uid is skipped", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [
        { title: "no uid" },
        { uid: "kept", title: "kept" },
      ]);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'grafana'",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["kept"]);
    });

    test("empty uid is skipped", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [{ uid: "" }, { uid: "k" }]);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("non-record entry is skipped", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [42, "string", null, { uid: "k" }]);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("title falls back to uid when missing", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [{ uid: "abc" }]);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      const row = fixture.db
        .query<{ title: string }, []>(
          "SELECT title FROM item WHERE service = 'grafana' AND external_id = 'abc'",
        )
        .get();
      expect(row?.title).toBe("abc");
    });

    test("title falls back to uid when title is empty string", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [{ uid: "abc", title: "" }]);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      const row = fixture.db
        .query<{ title: string }, []>(
          "SELECT title FROM item WHERE service = 'grafana' AND external_id = 'abc'",
        )
        .get();
      expect(row?.title).toBe("abc");
    });

    test("metadata.uid is set on upserted row", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [{ uid: "u1", title: "T1" }]);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      const row = fixture.db
        .query<{ metadata: string }, []>(
          "SELECT metadata FROM item WHERE service = 'grafana' AND external_id = 'u1'",
        )
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as { uid?: string };
      expect(meta.uid).toBe("u1");
    });
  });

  describe("cursor decode", () => {
    test("null cursor returns success pass cursor with pass:1", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, []);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
      const decoded = JSON.parse(
        Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      ) as { pass: number };
      expect(decoded.pass).toBe(1);
    });

    test("any incoming cursor is replaced on success (pass cursor)", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, []);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        encodeCursor({ arbitrary: true }),
      );
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("full-cycle", () => {
    test("three dashboards → three upserts; itemsUpserted reflects count", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, [
        { uid: "d1", title: "Prod" },
        { uid: "d2", title: "Staging" },
        { uid: "d3", title: "Dev" },
      ]);
      const res = await createGrafanaSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("grafana"),
        null,
      );
      expect(res.itemsUpserted).toBe(3);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'grafana' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["d1", "d2", "d3"]);
    });

    test("emits no notifications", async () => {
      fixture.fetchMock.respond("GET", SEARCH_RE, []);
      await createGrafanaSyncable(ENSURE_MCP).sync(fixture.createSyncContext("grafana"), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
