import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSentrySyncable } from "../../../src/connectors/sentry-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureSentryMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-sentry1:";

const PROJECTS_DEFAULT_RE = /^https:\/\/sentry\.io\/api\/0\/organizations\/test-org\/projects\/$/;
const PROJECTS_CUSTOM_RE =
  /^https:\/\/sentry\.example\.com\/api\/0\/organizations\/test-org\/projects\/$/;

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

describe("sentry-sync — credential short-circuits", () => {
  test("returns noop when neither vault key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createSentrySyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when only auth_token is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("sentry.auth_token", "sentry-stub-token");
      const syncable = createSentrySyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when only org_slug is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("sentry.org_slug", "test-org");
      const syncable = createSentrySyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when auth_token is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("sentry.auth_token", "   ");
      await iso.vault.set("sentry.org_slug", "test-org");
      const syncable = createSentrySyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when org_slug is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("sentry.auth_token", "sentry-stub-token");
      await iso.vault.set("sentry.org_slug", "   ");
      const syncable = createSentrySyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createSentrySyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), "preserved-cursor");
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("sentry-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("sentry.auth_token", "sentry-stub-token");
    await fixture.vault.set("sentry.org_slug", "test-org");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request path", () => {
    test("uses default sentry.io base when sentry.url is unset", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.fetchMock.firstCall().url).toBe(
        "https://sentry.io/api/0/organizations/test-org/projects/",
      );
    });

    test("uses custom base when sentry.url is set", async () => {
      await fixture.vault.set("sentry.url", "https://sentry.example.com");
      fixture.fetchMock.respond("GET", PROJECTS_CUSTOM_RE, []);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.fetchMock.firstCall().url).toBe(
        "https://sentry.example.com/api/0/organizations/test-org/projects/",
      );
    });

    test("strips trailing slash from custom base url", async () => {
      await fixture.vault.set("sentry.url", "https://sentry.example.com/");
      fixture.fetchMock.respond("GET", PROJECTS_CUSTOM_RE, []);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.fetchMock.firstCall().url).toBe(
        "https://sentry.example.com/api/0/organizations/test-org/projects/",
      );
    });

    test("sends Authorization: Bearer <token> and Accept: application/json", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const call = fixture.fetchMock.firstCall();
      expect(call.headers["authorization"]).toBe("Bearer sentry-stub-token");
      expect(call.headers["accept"]).toBe("application/json");
    });

    test("non-200 → no upserts, returns http-empty pass cursor", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, { error: "boom" }, { status: 500 });
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("invalid JSON → returns parse-empty pass cursor", async () => {
      fixture.fetchMock.respondWithText("GET", PROJECTS_DEFAULT_RE, "<html>not json</html>");
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });

    test("non-array JSON body → 0 upserts, success pass cursor", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, { projects: [] });
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("indexing skip paths", () => {
    test("entry missing both slug and name is skipped", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [
        { other: "field" },
        { slug: "kept", name: "Kept" },
      ]);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      const rows = fixture.db
        .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'sentry'")
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["kept"]);
    });

    test("empty slug AND empty name is skipped", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [
        { slug: "", name: "" },
        { slug: "k", name: "K" },
      ]);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
    });

    test("non-record entry is skipped", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [42, "string", null, { slug: "k" }]);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
    });

    test("slug-only → upserted with id == slug; title falls back to id", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [{ slug: "abc" }]);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'sentry'",
        )
        .get();
      expect(row?.external_id).toBe("abc");
      expect(row?.title).toBe("abc");
    });

    test("name-only → upserted with id == name; title == name", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [{ name: "MyProject" }]);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'sentry'",
        )
        .get();
      expect(row?.external_id).toBe("MyProject");
      expect(row?.title).toBe("MyProject");
    });

    test("metadata captures org and slug (slug null when only name present)", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [
        { slug: "with-slug", name: "WithSlug" },
        { name: "OnlyName" },
      ]);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const rowWithSlug = fixture.db
        .query<{ metadata: string }, [string]>(
          "SELECT metadata FROM item WHERE service = 'sentry' AND external_id = ?",
        )
        .get("with-slug");
      const rowOnlyName = fixture.db
        .query<{ metadata: string }, [string]>(
          "SELECT metadata FROM item WHERE service = 'sentry' AND external_id = ?",
        )
        .get("OnlyName");
      const metaWithSlug = JSON.parse(rowWithSlug?.metadata ?? "{}") as {
        org?: string;
        slug?: string | null;
      };
      const metaOnlyName = JSON.parse(rowOnlyName?.metadata ?? "{}") as {
        org?: string;
        slug?: string | null;
      };
      expect(metaWithSlug.org).toBe("test-org");
      expect(metaWithSlug.slug).toBe("with-slug");
      expect(metaOnlyName.org).toBe("test-org");
      expect(metaOnlyName.slug).toBeNull();
    });
  });

  describe("cursor decode", () => {
    test("null cursor returns success pass cursor with pass:1", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
      const decoded = JSON.parse(
        Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      ) as { pass: number };
      expect(decoded.pass).toBe(1);
    });

    test("any incoming cursor is replaced on success (pass cursor)", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      const res = await createSentrySyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ arbitrary: true }),
      );
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    });
  });

  describe("full-cycle", () => {
    test("three projects → three upserts; itemsUpserted reflects count", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, [
        { slug: "p1", name: "Prod" },
        { slug: "p2", name: "Staging" },
        { slug: "p3", name: "Dev" },
      ]);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(3);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'sentry' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(["p1", "p2", "p3"]);
    });

    test("emits no notifications", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
