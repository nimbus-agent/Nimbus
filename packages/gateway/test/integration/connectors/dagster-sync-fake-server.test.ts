import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createDagsterSyncable } from "../../../src/connectors/dagster-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  token: string | null;
}

type RepoNode = {
  name: string;
  location?: { name: string } | null;
  pipelines?: unknown[];
};

interface FakeDagsterConfig {
  repos?: RepoNode[];
  status?: number;
  // HTTP 200 carrying a top-level GraphQL errors array.
  graphqlErrors?: boolean;
  // HTTP 200 where repositoriesOrError resolves to a PythonError typename.
  pythonError?: boolean;
}

interface FakeDagster {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeDagster(config: FakeDagsterConfig): FakeDagster {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        token: req.headers.get("dagster-cloud-api-token"),
      });
      if (u.pathname !== "/graphql" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      if (config.graphqlErrors === true) {
        return Response.json({ errors: [{ message: "field 'repositoriesOrError' missing" }] });
      }
      if (config.pythonError === true) {
        return Response.json({
          data: {
            repositoriesOrError: {
              __typename: "PythonError",
              message: "boom in user code",
            },
          },
        });
      }
      return Response.json({
        data: {
          repositoriesOrError: {
            __typename: "RepositoryConnection",
            nodes: config.repos ?? [],
          },
        },
      });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeDagster;
  cleanup: () => void;
}

function startHarness(config: FakeDagsterConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeDagster(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "dagster"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        dagster: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function pipeline(name: string, over: Record<string, unknown> = {}): unknown {
  return {
    id: `opaque-${name}`,
    name,
    description: `desc for ${name}`,
    isJob: true,
    tags: [{ key: "team", value: "data" }],
    ...over,
  };
}

function repo(name: string, location: string, pipelines: unknown[]): RepoNode {
  return { name, location: { name: location }, pipelines };
}

async function setCreds(h: Harness): Promise<void> {
  await h.vault.set("dagster.base_url", h.fake.baseUrl);
  await h.vault.set("dagster.api_token", "tok_test");
}

describe("dagster-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: flattens multi-repo/multi-job catalog, Dagster-Cloud-Api-Token header, pass-1 cursor", async () => {
    h = startHarness({
      repos: [
        repo("analytics", "analytics_code", [
          pipeline("nightly_etl", { name: "nightly_etl" }),
          pipeline("hourly_rollup", { name: "hourly_rollup" }),
        ]),
        repo("ml", "ml_code", [pipeline("train", { name: "train" })]),
      ],
    });
    await setCreds(h);

    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);

    const gql = h.fake.requests.filter((r) => r.path === "/graphql");
    expect(gql).toHaveLength(1);
    expect(gql[0]?.method).toBe("POST");
    expect(gql[0]?.token).toBe("tok_test");

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'dagster' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "analytics_code:analytics:hourly_rollup",
      "analytics_code:analytics:nightly_etl",
      "ml_code:ml:train",
    ]);
    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["repository"]).toBe("analytics");
    expect(first["location"]).toBe("analytics_code");
    expect(first["tags"]).toEqual(["team=data"]);
  });

  test("skips pipelines with no name without aborting the flatten", async () => {
    h = startHarness({
      repos: [
        repo("analytics", "analytics_code", [
          pipeline("ok", { name: "ok" }),
          { id: "x", description: "no name" },
          pipeline("ok2", { name: "ok2" }),
        ]),
      ],
    });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(2);
  });

  test("noop when credentials unset — no requests", async () => {
    h = startHarness({ repos: [repo("r", "l", [pipeline("p", { name: "p" })])] });
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 429 });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
  });

  test("a 401 (auth failure) degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ status: 401 });
    await h.vault.set("dagster.base_url", h.fake.baseUrl);
    await h.vault.set("dagster.api_token", "bad");
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
  });

  test("a 403 (forbidden) degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ status: 403 });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
  });

  test("a top-level GraphQL errors array (HTTP 200) degrades gracefully with zero upserts", async () => {
    h = startHarness({ graphqlErrors: true });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
    // The GraphQL call was made (HTTP 200), but the errors envelope short-circuits.
    expect(h.fake.requests.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  test("a PythonError typename (HTTP 200) degrades gracefully with zero upserts", async () => {
    h = startHarness({ pythonError: true });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  test("empty catalog yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ repos: [] });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
  });
});
