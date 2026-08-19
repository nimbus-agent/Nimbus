import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { dispatchMetricsRpc, type MetricsRpcContext } from "./metrics-rpc.ts";

const NOW = 1_700_000_000_000;

// Mirrors `metrics/stats.test.ts`'s `makeDb` — the two tables the DORA calculators and the
// `pr-merges`/`incidents-opened` evaluators read from.
function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE item (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, type TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT, body_preview TEXT, url TEXT,
    canonical_url TEXT, modified_at INTEGER NOT NULL, author_id TEXT,
    metadata TEXT, synced_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE deployment_items (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, nimbus_service_id TEXT NOT NULL,
    environment TEXT NOT NULL, sha TEXT NOT NULL, ref TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, conclusion TEXT NOT NULL,
    workflow_url TEXT, ci_run_external_id TEXT, created_at INTEGER NOT NULL)`);
  return db;
}

function checkoutWebConfig(): ServiceConfig {
  return {
    serviceId: "checkout-web",
    repos: [{ provider: "github", providerId: "acme/web" }],
    pagerdutyServices: [],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

const db = makeDb();
const ctx: MetricsRpcContext = {
  db,
  loadConfig: () => new Map([["checkout-web", checkoutWebConfig()]]),
  nowMs: () => NOW,
};

describe("metrics.stats", () => {
  test("returns a series with one point per bucket", async () => {
    const out = await dispatchMetricsRpc(
      "metrics.stats",
      {
        service: "checkout-web",
        metric: "pr-merges",
        window_ms: 4 * 86_400_000,
        bucket_ms: 2 * 86_400_000,
      },
      ctx,
    );
    expect(out.kind).toBe("hit");
    const v = (out as { value: { points: readonly unknown[] } }).value;
    expect(v.points.length).toBe(2);
  });

  test("an unknown metric id is a -32602, naming the valid ids", async () => {
    let code = 0;
    let msg = "";
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        {
          service: "checkout-web",
          metric: "not-a-metric",
          window_ms: 86_400_000,
          bucket_ms: 86_400_000,
        },
        ctx,
      );
    } catch (e) {
      code = (e as { rpcCode: number }).rpcCode;
      msg = (e as Error).message;
    }
    expect(code).toBe(-32602);
    expect(msg).toContain("pr-merges");
  });

  test("non-integer window_ms or bucket_ms is a -32602", async () => {
    for (const params of [
      { service: "checkout-web", metric: "pr-merges", window_ms: "7d", bucket_ms: 1 },
      { service: "checkout-web", metric: "pr-merges", window_ms: 7, bucket_ms: null },
    ]) {
      let code = 0;
      try {
        await dispatchMetricsRpc("metrics.stats", params, ctx);
      } catch (e) {
        code = (e as { rpcCode: number }).rpcCode;
      }
      expect(code).toBe(-32602);
    }
  });

  // A StatsBucketError must not escape as an unhandled 500-class fault.
  test("bucket larger than window surfaces as -32602, not an internal error", async () => {
    let code = 0;
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        {
          service: "checkout-web",
          metric: "pr-merges",
          window_ms: 86_400_000,
          bucket_ms: 7 * 86_400_000,
        },
        ctx,
      );
    } catch (e) {
      code = (e as { rpcCode: number }).rpcCode;
    }
    expect(code).toBe(-32602);
  });

  test("an unconfigured service is a -32602 naming the service", async () => {
    let msg = "";
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        { service: "nope", metric: "pr-merges", window_ms: 86_400_000, bucket_ms: 86_400_000 },
        ctx,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("nope");
  });

  test("metrics.dora still dispatches unchanged", async () => {
    const out = await dispatchMetricsRpc("metrics.dora", { service: "checkout-web" }, ctx);
    expect(out.kind).toBe("hit");
  });
});
