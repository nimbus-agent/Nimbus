import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createMlflowSyncable } from "../../../src/connectors/mlflow-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface SearchPage {
  registered_models: unknown[];
  next_page_token?: string;
}

interface FakeMlflowConfig {
  searchPages?: Record<string, SearchPage>;
  searchStatus?: number;
  searchInvalidJson?: boolean;
}

interface FakeMlflow {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeMlflow(config: FakeMlflowConfig): FakeMlflow {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        query: u.search,
        authorization: req.headers.get("authorization"),
      });
      if (u.pathname === "/api/2.0/mlflow/registered-models/search") {
        if (config.searchStatus !== undefined && config.searchStatus !== 200) {
          return new Response("error", { status: config.searchStatus });
        }
        if (config.searchInvalidJson === true) {
          return new Response("not json {{{", { status: 200 });
        }
        const token = u.searchParams.get("page_token") ?? "";
        const page = config.searchPages?.[token] ?? { registered_models: [] };
        return Response.json(page);
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
  fake: FakeMlflow;
  cleanup: () => void;
}

function startHarness(config: FakeMlflowConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeMlflow(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "mlflow"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        mlflow: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function model(
  name: string,
  over: { description?: string; stage?: string; version?: string } = {},
): Record<string, unknown> {
  return {
    name,
    creation_timestamp: 1_613_001_791_000,
    last_updated_timestamp: 1_699_900_000_000,
    description: over.description ?? `${name} description`,
    latest_versions: [
      {
        name,
        version: over.version ?? "2",
        current_stage: over.stage ?? "Staging",
        status: "READY",
        run_id: `run-${name}`,
      },
    ],
    tags: [{ key: "team", value: "ml" }],
  };
}

describe("mlflow-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: 2 models → 2 upserts with Bearer auth + model_<name> external_id", async () => {
    h = startHarness({
      searchPages: {
        "": {
          registered_models: [
            model("fraud-detector", { stage: "Production", version: "5" }),
            model("churn-ranker"),
          ],
        },
      },
    });
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "mlflow-test-token");

    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-mlflow1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer mlflow-test-token");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'mlflow' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["model_churn-ranker", "model_fraud-detector"]);

    const fraud = rows.find((r) => r.external_id === "model_fraud-detector");
    const m = JSON.parse(fraud?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["name"]).toBe("fraud-detector");
    expect(m["latest_stage"]).toBe("Production");
    expect(m["latest_version"]).toBe("5");
    expect(m["tags"]).toEqual(["team=ml"]);
  });

  test("noop when host + token unset — no requests", async () => {
    h = startHarness({ searchPages: { "": { registered_models: [model("m1")] } } });
    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("token pagination: next_page_token triggers a second page_token request", async () => {
    h = startHarness({
      searchPages: {
        "": { registered_models: [model("m1")], next_page_token: "PAGE2" },
        PAGE2: { registered_models: [model("m2")] },
      },
    });
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "t");
    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);

    const searchReqs = h.fake.requests.filter(
      (r) => r.path === "/api/2.0/mlflow/registered-models/search",
    );
    expect(searchReqs).toHaveLength(2);
    expect(searchReqs[1]?.query).toContain("page_token=PAGE2");
  });

  test("MAX_PAGES cap: an endlessly-paginating registry stops after 20 page requests", async () => {
    h = startHarness({});
    h.fake.stop();
    const requests: RecordedReq[] = [];
    let counter = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        requests.push({
          method: req.method,
          path: u.pathname,
          query: u.search,
          authorization: req.headers.get("authorization"),
        });
        counter += 1;
        return Response.json({
          registered_models: [model(`m${String(counter)}`)],
          next_page_token: `tok-${String(counter)}`,
        });
      },
    });
    h.fake = {
      baseUrl: `http://${server.hostname}:${server.port}`,
      requests,
      stop: () => server.stop(true),
    };
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "t");

    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(requests).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20);
  });

  test("a 5xx on the first search page degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      searchPages: { "": { registered_models: [model("m1")] } },
      searchStatus: 503,
    });
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "t");
    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mlflow1:")).toBe(true);
  });

  test("a parse error on the first search page degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ searchInvalidJson: true });
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "t");
    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mlflow1:")).toBe(true);
  });

  test("an empty registry yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ searchPages: { "": { registered_models: [] } } });
    await h.vault.set("mlflow.host", h.fake.baseUrl);
    await h.vault.set("mlflow.token", "t");
    const syncable = createMlflowSyncable({ ensureMlflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mlflow1:")).toBe(true);
  });
});
