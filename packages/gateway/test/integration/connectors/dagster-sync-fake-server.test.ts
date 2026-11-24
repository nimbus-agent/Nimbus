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
  // Runs served for the `runsOrError` query (a missing list is an empty one).
  runs?: unknown[];
  // The runs query answers HTTP 500.
  runsFail?: boolean;
}

interface FakeDagster {
  baseUrl: string;
  requests: RecordedReq[];
  runRequests: RecordedReq[];
  stop(): void;
}

function startFakeDagster(config: FakeDagsterConfig): FakeDagster {
  const requests: RecordedReq[] = [];
  const runRequests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      const isRun = body.includes("runsOrError");
      (isRun ? runRequests : requests).push({
        method: req.method,
        path: u.pathname,
        token: req.headers.get("dagster-cloud-api-token"),
      });
      if (isRun) {
        if (config.runsFail === true) return new Response("error", { status: 500 });
        return Response.json({
          data: { runsOrError: { __typename: "Runs", results: config.runs ?? [] } },
        });
      }
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
  return { baseUrl, requests, runRequests, stop: () => server?.stop(true) };
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

  test("indexes recent runs as metadata only, with failed step keys and the trigger", async () => {
    h = startHarness({
      repos: [
        repo("analytics", "analytics_code", [pipeline("nightly_etl", { name: "nightly_etl" })]),
      ],
      runs: [
        {
          runId: "run-a",
          jobName: "nightly_etl",
          status: "FAILURE",
          startTime: 1_780_000_000.5,
          endTime: 1_780_000_300,
          creationTime: 1_779_999_990,
          repositoryOrigin: {
            repositoryName: "analytics",
            repositoryLocationName: "analytics_code",
          },
          tags: [{ key: "dagster/schedule_name", value: "customer a@example.com" }],
          stepStats: [
            { stepKey: "load_orders", status: "FAILURE" },
            { stepKey: "dedupe", status: "SUCCESS" },
          ],
        },
      ],
    });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const row = h.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'dagster' AND type = 'job_run'",
      )
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["parent_item_id"]).toBe("dagster:analytics_code:analytics:nightly_etl");
    expect(m["outcome"]).toBe("failed");
    expect(m["failed_tasks"]).toEqual(["load_orders"]);
    expect(m["trigger"]).toBe("schedule");
    expect(m["start_ms"]).toBe(1_780_000_000_500);
    expect(row?.metadata).not.toContain("a@example.com");
  });

  test("a failing runs query never fails the job sync", async () => {
    h = startHarness({
      repos: [repo("r", "l", [pipeline("p", { name: "p" })])],
      runsFail: true,
    });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-dagster1:")).toBe(true);
  });

  test("the run walk pages by the last run id and stops at its page cap", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      runId: `r${String(i)}`,
      status: "SUCCESS",
    }));
    h = startHarness({
      repos: [repo("r", "l", [pipeline("p", { name: "p" })])],
      runs: full,
    });
    await setCreds(h);
    const syncable = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    expect(h.fake.runRequests).toHaveLength(5);
  });
});
