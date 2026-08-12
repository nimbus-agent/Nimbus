import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSentrySyncable } from "../../../src/connectors/sentry-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureSentryMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-sentry2:";

const PROJECTS_DEFAULT_RE = /^https:\/\/sentry\.io\/api\/0\/organizations\/test-org\/projects\/$/;
const PROJECTS_CUSTOM_RE =
  /^https:\/\/sentry\.example\.com\/api\/0\/organizations\/test-org\/projects\/$/;
// No host anchor: matches the issue pass URL under both the default sentry.io
// host and the custom-base tests below.
const ISSUES_RE = /\/organizations\/test-org\/issues\/\?[^#]*$/;

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
    // These tests exercise the projects pass only; the two-pass syncable now
    // always runs the issue pass too whenever projects succeeds, so give it a
    // default empty response unless a test needs otherwise.
    fixture.fetchMock.respond("GET", ISSUES_RE, []);
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

    // IMPORTANT A: the sibling !res.ok arm already preserves a valid incoming
    // cursor with `cursor ?? encode(...)`; the parse-failure arm did not — it
    // always synthesized {lastSeenMs: 0}, destroying a good cursor on a
    // failure in a pass (projects) that isn't even the one that owns it. The
    // existing "invalid JSON" test above can't observe this: it passes `null`
    // as the incoming cursor, so a synthesized {lastSeenMs: 0} and a
    // preserved `null -> synthesized` fallback look identical there.
    test("an unparseable projects body preserves a valid incoming cursor unchanged", async () => {
      const validCursor = encodeCursor({ lastSeenMs: 1_700_000_000_000 });
      fixture.fetchMock.respondWithText("GET", PROJECTS_DEFAULT_RE, "<html>nope</html>");
      const res = await createSentrySyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        validCursor,
      );
      expect(res.cursor).toBe(validCursor);
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
    test("null cursor with no issues found returns a v2 cursor with lastSeenMs:0", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      const res = await createSentrySyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
      const decoded = JSON.parse(
        Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      ) as { lastSeenMs: number };
      expect(decoded.lastSeenMs).toBe(0);
    });

    // On any SUCCESSFUL pass the returned cursor is always a freshly re-encoded
    // v2 `{ lastSeenMs }` cursor — never a passthrough of whatever the caller
    // supplied. An incoming cursor whose payload does not decode as
    // `{ lastSeenMs }` fails `decodeCursor`'s validation (treated as a cold
    // start), so on success it is replaced with `lastSeenMs: 0`, not echoed back.
    test("an incoming cursor with no decodable lastSeenMs is replaced on success", async () => {
      fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      const incoming = encodeCursor({ arbitrary: true });
      const res = await createSentrySyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        incoming,
      );
      expect(res.cursor).not.toBeNull();
      if (res.cursor === null) throw new Error("unexpected null cursor");
      expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
      expect(res.cursor).not.toBe(incoming);
      const decoded = JSON.parse(
        Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      ) as { lastSeenMs: number };
      expect(decoded.lastSeenMs).toBe(0);
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

const ISSUES_PAGE1_RE = /\/organizations\/test-org\/issues\/\?(?!.*cursor=)/;
const ISSUES_PAGE2_RE = /\/organizations\/test-org\/issues\/\?.*cursor=C2/;
const ISSUES_PAGE3_RE = /\/organizations\/test-org\/issues\/\?.*cursor=C3/;
const CURSOR_V2_PREFIX = "nimbus-sentry2:";

function decodeV2Cursor(cursor: string): {
  lastSeenMs: number;
  resume?: string;
  pendingMax?: number;
} {
  return JSON.parse(
    Buffer.from(cursor.slice(CURSOR_V2_PREFIX.length), "base64url").toString("utf8"),
  ) as { lastSeenMs: number; resume?: string; pendingMax?: number };
}

function sentryIssue(id: string, lastSeen: string): Record<string, unknown> {
  return {
    id,
    title: `Issue ${id}`,
    culprit: "app/x.ts in run",
    permalink: `https://acme.sentry.io/issues/${id}/`,
    status: "resolved",
    level: "error",
    lastSeen,
    firstSeen: "2026-07-01T00:00:00.000Z",
    project: { slug: "web" },
    metadata: { value: `boom ${id}` },
    assignedTo: null,
  };
}

describe("sentry-sync — issue pass", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("sentry.auth_token", "sentry-stub-token");
    await fixture.vault.set("sentry.org_slug", "test-org");
    fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("indexes issues as sentry:error_issue with a null author", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [sentryIssue("1", "2026-08-01T00:00:00.000Z")], {
      headers: { "content-type": "application/json" },
    });
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const row = fixture.db
      .query<{ type: string; author_id: string | null; external_id: string }, []>(
        "SELECT type, author_id, external_id FROM item WHERE service = 'sentry' AND type = 'error_issue'",
      )
      .get();
    expect(row?.type).toBe("error_issue");
    expect(row?.external_id).toBe("1");
    expect(row?.author_id).toBeNull();
  });

  // THE STATUS GUARD. The API default is is:unresolved, which would drop these.
  test("sends a lastSeen query with no is: term, and never statsPeriod", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    const url = new URL(call?.url ?? "https://x/");
    expect(url.searchParams.get("query")).toBe("lastSeen:-30d");
    expect(url.searchParams.get("query")).not.toContain("is:");
    expect(url.searchParams.get("statsPeriod")).toBeNull();
    expect(url.searchParams.get("collapse")).toBe("stats");
    expect(url.searchParams.get("sort")).toBe("date");
  });

  // THE TERMINATION GUARD. Sentry sends rel="next" on the last page too.
  test("stops paginating when the next link declares results=false", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("1", "2026-08-02T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
        },
      },
    );
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE2_RE,
      [sentryIssue("2", "2026-08-01T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C3>; rel="next"; results="false"',
        },
      },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const issueCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"));
    expect(issueCalls).toHaveLength(2);
    const ids = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE type = 'error_issue' ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["1", "2"]);
  });

  test("stops early once a row is at or below the stored cursor", async () => {
    const cursor =
      CURSOR_V2_PREFIX +
      Buffer.from(
        JSON.stringify({ lastSeenMs: Date.parse("2026-08-01T12:00:00.000Z") }),
        "utf8",
      ).toString("base64url");
    fixture.fetchMock.respond(
      "GET",
      ISSUES_RE,
      [
        sentryIssue("new", "2026-08-02T00:00:00.000Z"),
        sentryIssue("old", "2026-07-01T00:00:00.000Z"),
      ],
      { headers: { "content-type": "application/json" } },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["new"]);
  });

  // THE LEGACY CURSOR. Every existing install has one persisted.
  test("a legacy nimbus-sentry1 cursor is treated as a cold start", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    const legacy =
      "nimbus-sentry1:" + Buffer.from(JSON.stringify({ pass: 1 }), "utf8").toString("base64url");
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      legacy,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    expect(new URL(call?.url ?? "https://x/").searchParams.get("query")).toBe("lastSeen:-30d");
    expect(res.cursor?.startsWith(CURSOR_V2_PREFIX)).toBe(true);
  });

  // THE MIS-SCOPED TOKEN. project:read lists projects but 403s on issues.
  test("a 403 on the issue pass indexes nothing and leaves the cursor unadvanced", async () => {
    const cursor =
      CURSOR_V2_PREFIX +
      Buffer.from(JSON.stringify({ lastSeenMs: 1_600_000_000_000 }), "utf8").toString("base64url");
    fixture.fetchMock.respond("GET", ISSUES_RE, { detail: "forbidden" }, { status: 403 });
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    expect(res.cursor).toBe(cursor);
    const n = fixture.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'error_issue'")
      .get();
    expect(n?.n).toBe(0);
  });

  // A stronger companion to the 403 test above: the single-page case above
  // can't distinguish `ok: false` from a hypothetical `ok: true` regression,
  // because when nothing was indexed, re-deriving the cursor from the already-
  // decoded incoming value and echoing that same incoming value byte-for-byte
  // coincide. Real partial progress (page 1 indexes something, THEN page 2
  // 403s) breaks that coincidence: a correct implementation must still discard
  // page 1's advance and echo the pre-sync cursor.
  test("a 403 on page 2, after page 1 indexed real progress, still discards that progress", async () => {
    const cursor =
      CURSOR_V2_PREFIX +
      Buffer.from(JSON.stringify({ lastSeenMs: 1_600_000_000_000 }), "utf8").toString("base64url");
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("1", "2026-08-02T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
        },
      },
    );
    fixture.fetchMock.respond("GET", ISSUES_PAGE2_RE, { detail: "forbidden" }, { status: 403 });
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    expect(res.cursor).toBe(cursor);
    const n = fixture.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'error_issue'")
      .get();
    // Page 1's row is indexed (the upsert already happened before page 2 was
    // even fetched) — it is the CURSOR that must not advance past it.
    expect(n?.n).toBe(1);
  });

  test("honours historyFloorMs on a cold start", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    const floor = Date.now() - 120 * 86_400_000;
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full", historyFloorMs: floor },
      null,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    const q = new URL(call?.url ?? "https://x/").searchParams.get("query") ?? "";
    expect(q).toMatch(/^lastSeen:-1[12]\dd$/);
  });

  test("a row with an unparseable lastSeen is skipped, not defaulted", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_RE,
      [
        { id: "bad", title: "x", lastSeen: "nope" },
        sentryIssue("good", "2026-08-01T00:00:00.000Z"),
      ],
      { headers: { "content-type": "application/json" } },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["good"]);
  });

  test("stops at the page budget", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [sentryIssue("1", "2026-08-02T00:00:00.000Z")], {
      headers: {
        "content-type": "application/json",
        Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=CN>; rel="next"; results="true"',
      },
    });
    const res = await createSentrySyncable({ ...ENSURE_MCP, maxPagesPerSync: 2 }).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    expect(fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"))).toHaveLength(2);
    expect(res.hasMore).toBe(true);
  });

  // ===========================================================================
  // CRITICAL FIX: a truncated descending walk must not strand rows forever.
  // ===========================================================================

  // Reproduces the review's scenario (a): maxPagesPerSync=2 over 3 pages of
  // issues 3@2026-08-03, 2@2026-08-02, 1@2026-08-01. Run 1 must save a resume
  // cursor (not publish issue 3's watermark), and run 2 — continuing from
  // that exact resume URL — must still reach issue 1.
  test("a budget-truncated walk saves a resume cursor, and the next run continues from it and reaches the oldest issue", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("3", "2026-08-03T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
        },
      },
    );
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE2_RE,
      [sentryIssue("2", "2026-08-02T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C3>; rel="next"; results="true"',
        },
      },
    );
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE3_RE,
      [sentryIssue("1", "2026-08-01T00:00:00.000Z")],
      { headers: { "content-type": "application/json" } }, // no Link header: this page is terminal
    );

    const syncable = createSentrySyncable({ ...ENSURE_MCP, maxPagesPerSync: 2 });

    const res1 = await syncable.sync({ ...fixture.createSyncContext(), depth: "full" }, null);
    expect(res1.hasMore).toBe(true);
    if (res1.cursor === null) throw new Error("unexpected null cursor after run 1");
    const decoded1 = decodeV2Cursor(res1.cursor);
    expect(decoded1.resume).toBeDefined();
    expect(decoded1.lastSeenMs).toBe(0); // unchanged: nothing is "caught up" yet

    const idsAfterRun1 = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id)
      .sort();
    expect(idsAfterRun1).toEqual(["2", "3"]);

    const callsBeforeRun2 = fixture.fetchMock.calls.length;
    const res2 = await syncable.sync(
      { ...fixture.createSyncContext(), depth: "full" },
      res1.cursor,
    );
    expect(res2.hasMore).toBe(false);

    // The resume URL — not a freshly built first page — is what run 2 fetched.
    const issueCallsRun2 = fixture.fetchMock.calls
      .slice(callsBeforeRun2)
      .filter((c) => c.url.includes("/issues/"));
    expect(issueCallsRun2[0]?.url).toBe(decoded1.resume);

    const idsAfterRun2 = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id)
      .sort();
    expect(idsAfterRun2).toEqual(["1", "2", "3"]); // the previously-unreachable tail is now indexed

    if (res2.cursor === null) throw new Error("unexpected null cursor after run 2");
    const decoded2 = decodeV2Cursor(res2.cursor);
    expect(decoded2.resume).toBeUndefined();
    expect(decoded2.pendingMax).toBeUndefined();
    expect(decoded2.lastSeenMs).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
  });

  // Reproduces the review's scenario (b): a page containing an out-of-order
  // below-cursor row must not stop the walk — the newer row after it must
  // still be indexed.
  test("a page containing an out-of-order below-cursor row still indexes the newer rows after it", async () => {
    const cursor = encodeCursor({ lastSeenMs: Date.parse("2026-07-15T00:00:00.000Z") });
    fixture.fetchMock.respond(
      "GET",
      ISSUES_RE,
      [
        sentryIssue("A", "2026-08-03T00:00:00.000Z"), // above cursor
        sentryIssue("B", "2026-06-01T00:00:00.000Z"), // BELOW cursor, out of order
        sentryIssue("C", "2026-08-02T00:00:00.000Z"), // above cursor, comes AFTER B
      ],
      { headers: { "content-type": "application/json" } }, // no Link header: single page, walk completes
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id)
      .sort();
    expect(ids).toEqual(["A", "C"]);
  });

  // Starts from an ALREADY-truncated state (a resume + pendingMax on the
  // incoming cursor) so this genuinely exercises "clear on completion" rather
  // than a cold start that never had those fields to begin with — a cold
  // start's output cursor has no resume/pendingMax either way, resumed or
  // not, so it can't tell the fix apart from its absence.
  test("a complete walk resumed from a truncated state clears resume/pendingMax and advances lastSeenMs to the max seen", async () => {
    const resumeUrl = "https://sentry.io/api/0/organizations/test-org/issues/?cursor=RESUME1";
    const cursor = encodeCursor({
      lastSeenMs: Date.parse("2026-07-01T00:00:00.000Z"),
      resume: resumeUrl,
      pendingMax: Date.parse("2026-08-04T00:00:00.000Z"), // higher than this walk's own row
    });
    fixture.fetchMock.respond(
      "GET",
      /cursor=RESUME1/,
      [sentryIssue("1", "2026-08-02T00:00:00.000Z")], // lower than pendingMax
      { headers: { "content-type": "application/json" } }, // no Link header: completes in this run
    );
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    if (res.cursor === null) throw new Error("unexpected null cursor");
    const decoded = decodeV2Cursor(res.cursor);
    expect(decoded.resume).toBeUndefined();
    expect(decoded.pendingMax).toBeUndefined();
    // The carried-over pendingMax (2026-08-04) is HIGHER than this walk's own
    // row (2026-08-02) — the final mark must not regress below it.
    expect(decoded.lastSeenMs).toBe(Date.parse("2026-08-04T00:00:00.000Z"));
  });

  // A resume URL Sentry no longer accepts (expired/invalidated cursor) must
  // fall back to a fresh first-page walk in the SAME run, never error out and
  // never leave the connector wedged on a dead cursor.
  test("a rejected resume URL falls back to a fresh walk in the same run and still indexes", async () => {
    const deadResumeUrl =
      "https://sentry.io/api/0/organizations/test-org/issues/?cursor=DEAD&query=lastSeen%3A-30d";
    const cursor = encodeCursor({
      lastSeenMs: Date.parse("2026-07-01T00:00:00.000Z"),
      resume: deadResumeUrl,
      pendingMax: Date.parse("2026-07-10T00:00:00.000Z"),
    });
    fixture.fetchMock.respond("GET", /cursor=DEAD/, { detail: "gone" }, { status: 410 });
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("fresh", "2026-08-05T00:00:00.000Z")],
      { headers: { "content-type": "application/json" } },
    );
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["fresh"]);
    if (res.cursor === null) throw new Error("unexpected null cursor");
    const decoded = decodeV2Cursor(res.cursor);
    expect(decoded.lastSeenMs).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
    expect(decoded.resume).toBeUndefined();
  });

  // ===========================================================================
  // IMPORTANT B: a failed cold start must not forfeit historyFloorMs forever.
  // ===========================================================================
  test("a failed cold start leaves the cursor null, so a later cold-start-with-floor run still honours historyFloorMs", async () => {
    const floor = Date.now() - 180 * 86_400_000;
    fixture.fetchMock.respond("GET", ISSUES_RE, { detail: "forbidden" }, { status: 403 });
    const res1 = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full", historyFloorMs: floor },
      null,
    );
    expect(res1.cursor).toBeNull();

    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("sentry.auth_token", "sentry-stub-token");
      await iso.vault.set("sentry.org_slug", "test-org");
      iso.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
      iso.fetchMock.respond("GET", ISSUES_RE, [], {
        headers: { "content-type": "application/json" },
      });
      await createSentrySyncable(ENSURE_MCP).sync(
        { ...iso.createSyncContext(), depth: "full", historyFloorMs: floor },
        res1.cursor,
      );
      const call = iso.fetchMock.calls.find((c) => c.url.includes("/issues/"));
      const q = new URL(call?.url ?? "https://x/").searchParams.get("query") ?? "";
      expect(q).toMatch(/^lastSeen:-1[789]\dd$/);
    });
  });

  // ===========================================================================
  // ALSO FIX: the next-page Link href must be resolved (relative hrefs) and
  // host-validated (never followed to a foreign host with the bearer token).
  // ===========================================================================
  test("a relative next href is resolved against the request URL, not followed as-is", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("1", "2026-08-02T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          // Relative — RFC 8288 permits this; an unresolved relative URL
          // makes fetch() throw.
          Link: '</api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
        },
      },
    );
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE2_RE,
      [sentryIssue("2", "2026-08-01T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C3>; rel="next"; results="false"',
        },
      },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const issueCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"));
    expect(issueCalls).toHaveLength(2);
    expect(issueCalls[1]?.url).toBe(
      "https://sentry.io/api/0/organizations/test-org/issues/?cursor=C2",
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id)
      .sort();
    expect(ids).toEqual(["1", "2"]);
  });

  test("a foreign-host next href is rejected — the walk ends instead of following it", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_PAGE1_RE,
      [sentryIssue("1", "2026-08-02T00:00:00.000Z")],
      {
        headers: {
          "content-type": "application/json",
          Link: '<https://evil.example.com/api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
        },
      },
    );
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const issueCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"));
    expect(issueCalls).toHaveLength(1); // never followed to evil.example.com
    expect(res.hasMore).toBe(false); // treated as a complete walk, not a truncated one
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["1"]); // page 1's own row is still indexed
  });
});
