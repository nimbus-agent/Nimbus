import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createWizSyncable } from "../../../src/connectors/wiz-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  variables: Record<string, unknown> | null;
}

interface IssueNode {
  id: string;
  sourceRule?: { id: string; name: string };
  severity?: string;
  status?: string;
  type?: string;
  description?: string;
  entity?: { id: string; name: string; type: string };
  projects?: Array<{ id: string; name: string }>;
}

interface FakeWizConfig {
  pages: Array<{ nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }>;
  authStatus?: number;
  authNoToken?: boolean;
  graphqlErrors?: boolean;
}

interface FakeWiz {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeWiz(config: FakeWizConfig): FakeWiz {
  const requests: RecordedReq[] = [];
  let pageIdx = 0;
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      let variables: Record<string, unknown> | null = null;
      let bodyText = "";
      if (req.method === "POST") {
        bodyText = await req.text();
      }
      if (u.pathname === "/graphql" && bodyText !== "") {
        try {
          const parsed = JSON.parse(bodyText) as { variables?: Record<string, unknown> };
          variables = parsed.variables ?? null;
        } catch {
          variables = null;
        }
      }
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        variables,
      });

      if (u.pathname === "/oauth/token") {
        if (config.authStatus !== undefined && config.authStatus !== 200) {
          return new Response("auth denied", { status: config.authStatus });
        }
        if (config.authNoToken === true) {
          return Response.json({ token_type: "Bearer", expires_in: 86_400 });
        }
        return Response.json({ access_token: "fake-wiz-token", expires_in: 86_400 });
      }
      if (u.pathname === "/graphql") {
        if (config.graphqlErrors === true) {
          return Response.json({ errors: [{ message: "field 'issues' is not defined" }] });
        }
        const page = config.pages[pageIdx] ?? { nodes: [], hasNextPage: false, endCursor: null };
        pageIdx += 1;
        return Response.json({
          data: {
            issues: {
              nodes: page.nodes,
              pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeWiz;
  cleanup: () => void;
}

function startHarness(config: FakeWizConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeWiz(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url
      .replace("https://auth.app.wiz.io", fake.baseUrl)
      .replace("https://api.app.wiz.io", fake.baseUrl);
    return originalFetch(rewritten, init);
  };
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "wiz"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

function issue(over: Partial<IssueNode> & { id: string }): IssueNode {
  return {
    sourceRule: { id: "rule-1", name: "Publicly exposed bucket" },
    severity: "HIGH",
    status: "OPEN",
    type: "TOXIC_COMBINATION",
    description: "Bucket is publicly readable.",
    entity: { id: "ent-1", name: "prod-bucket", type: "BUCKET" },
    projects: [{ id: "proj-1", name: "Payments" }],
    ...over,
  };
}

describe("wiz-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  async function withCreds(harness: Harness): Promise<void> {
    await harness.vault.set("wiz.client_id", "client-abc");
    await harness.vault.set("wiz.client_secret", "secret-xyz");
  }

  test("authenticates then walks issues and upserts well-formed rows", async () => {
    h = startHarness({
      pages: [
        {
          nodes: [issue({ id: "iss-1" }), issue({ id: "iss-2", severity: "CRITICAL" })],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    });
    await withCreds(h);

    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-wiz1:")).toBe(true);

    const authCalls = h.fake.requests.filter((r) => r.path === "/oauth/token");
    expect(authCalls).toHaveLength(1);
    const gqlCalls = h.fake.requests.filter((r) => r.path === "/graphql");
    expect(gqlCalls.length).toBeGreaterThan(0);
    for (const r of gqlCalls) {
      expect(r.auth).toBe("Bearer fake-wiz-token");
    }
    const firstGql = gqlCalls[0];
    if (firstGql === undefined) throw new Error("expected a graphql call");
    expect(firstGql.variables?.["filterBy"]).toEqual({ status: ["OPEN"] });

    const rows = h.db
      .query<{ external_id: string; title: string; metadata: string }, []>(
        "SELECT external_id, title, metadata FROM item WHERE service = 'wiz' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["iss-1", "iss-2"]);
    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["severity"]).toBe("HIGH");
    expect(first["entity_name"]).toBe("prod-bucket");
    expect(first["source_rule_name"]).toBe("Publicly exposed bucket");
    const second = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(second["severity"]).toBe("CRITICAL");
  });

  test("follows pageInfo.endCursor across pages, passing `after` on the second call", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => issue({ id: `iss-${String(i)}` }));
    h = startHarness({
      pages: [
        { nodes: fullPage, hasNextPage: true, endCursor: "cursor-2" },
        { nodes: [issue({ id: "iss-last" })], hasNextPage: false, endCursor: null },
      ],
    });
    await withCreds(h);

    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const gqlCalls = h.fake.requests.filter((r) => r.path === "/graphql");
    expect(gqlCalls).toHaveLength(2);
    expect(gqlCalls[0]?.variables?.["after"]).toBeNull();
    expect(gqlCalls[1]?.variables?.["after"]).toBe("cursor-2");
  });

  test("skips nodes that fail to map (missing id) without aborting the page", async () => {
    h = startHarness({
      pages: [
        {
          nodes: [issue({ id: "ok-1" }), { severity: "HIGH" }, issue({ id: "ok-2" })],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    });
    await withCreds(h);

    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(2);
  });

  test("noop when wiz credentials are unset — no auth or graphql calls", async () => {
    h = startHarness({ pages: [] });
    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("auth failure yields zero items, a pass-1 cursor, and no graphql calls", async () => {
    h = startHarness({ pages: [], authStatus: 401 });
    await withCreds(h);
    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-wiz1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/graphql")).toHaveLength(0);
  });

  test("auth 200 without access_token yields zero items and no graphql calls", async () => {
    h = startHarness({ pages: [], authNoToken: true });
    await withCreds(h);
    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-wiz1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/graphql")).toHaveLength(0);
  });

  test("a GraphQL errors envelope breaks the page loop with zero upserts", async () => {
    h = startHarness({ pages: [], graphqlErrors: true });
    await withCreds(h);
    const syncable = createWizSyncable({ ensureWizMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-wiz1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/oauth/token")).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });
});
