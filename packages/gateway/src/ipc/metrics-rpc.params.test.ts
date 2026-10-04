import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { dispatchMetricsRpc, type MetricsRpcContext, MetricsRpcError } from "./metrics-rpc.ts";

/**
 * `metrics-rpc.ts` parameter paths the existing suites do not reach: every `since` refusal and the
 * hour unit, the service-length and type refusals of both methods, the wall clock used when no
 * `nowMs` is injected, and a non-bucket fault in the stats evaluator propagating as itself rather
 * than being relabelled as invalid params.
 */

const db = new Database(":memory:");
LocalIndex.ensureSchema(db);
afterAll(() => db.close());

function config(serviceId: string): ServiceConfig {
  return {
    serviceId,
    repos: [{ provider: "github", providerId: "acme/web" }],
    pagerdutyServices: [],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

const ctx: MetricsRpcContext = {
  db,
  loadConfig: () => new Map([["checkout-web", config("checkout-web")]]),
  nowMs: () => 1_700_000_000_000,
};

async function refusal(
  method: "metrics.dora" | "metrics.stats",
  params: unknown,
  c: MetricsRpcContext = ctx,
): Promise<string> {
  const err: unknown = await dispatchMetricsRpc(method, params, c).then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MetricsRpcError);
  expect((err as MetricsRpcError).rpcCode).toBe(-32602);
  return (err as MetricsRpcError).message;
}

const STATS = { metric: "pr-merges", window_ms: 4 * 86_400_000, bucket_ms: 86_400_000 };

describe("metrics.dora — since", () => {
  test("anything but <n>d or <n>h is refused, quoting what was sent", async () => {
    for (const since of ["30", "30m", "d", "-3d", "1.5d", ""]) {
      expect(await refusal("metrics.dora", { service: "checkout-web", since })).toBe(
        String.raw`since must match \d+(d|h), got '${since}'`,
      );
    }
  });

  test("the count is bounded to 1..365, and the refusal names the unit it was given in", async () => {
    expect(await refusal("metrics.dora", { service: "checkout-web", since: "0d" })).toBe(
      "since duration must be 1..365 d",
    );
    expect(await refusal("metrics.dora", { service: "checkout-web", since: "366h" })).toBe(
      "since duration must be 1..365 h",
    );
  });

  test("a non-string since is refused as such", async () => {
    expect(await refusal("metrics.dora", { service: "checkout-web", since: 30 })).toBe(
      "since must be a string",
    );
  });

  test("an hour window converts at 3,600,000 ms per hour", async () => {
    const out = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "unknown-svc", since: "12h" },
      ctx,
    );
    expect(out.kind).toBe("hit");
    expect((out as { value: { since_ms: number } }).value.since_ms).toBe(12 * 3_600_000);
  });
});

describe("metrics.dora — the params shape", () => {
  test("anything but a plain object is refused, naming the shape it needs", async () => {
    for (const params of [null, undefined, [], ["checkout-web"], "checkout-web", 7]) {
      expect(await refusal("metrics.dora", params)).toBe(
        "metrics.dora requires { service: string }",
      );
    }
  });

  test("a missing or non-string service is refused as such, before the length bound", async () => {
    for (const params of [{}, { service: 7 }, { service: null }, { service: ["checkout-web"] }]) {
      expect(await refusal("metrics.dora", params)).toBe("service must be a string");
    }
  });
});

describe("routing", () => {
  test("an unrecognised metrics.* method is a miss — its params are never validated", async () => {
    // `null` would be refused by either method's validator; a miss proves routing comes first.
    for (const method of ["metrics.doraa", "metrics.unknown", "metrics."]) {
      expect(await dispatchMetricsRpc(method, null, ctx)).toEqual({ kind: "miss" });
    }
  });
});

describe("service bounds — both methods measure AFTER the trim", () => {
  const BOUND = "service must be 1..64 chars";

  test("metrics.dora refuses a blank or over-long service", async () => {
    expect(await refusal("metrics.dora", { service: "   " })).toBe(BOUND);
    expect(await refusal("metrics.dora", { service: "s".repeat(65) })).toBe(BOUND);
  });

  test("metrics.stats refuses a non-object, a non-string service, and a blank or over-long one", async () => {
    for (const params of [null, [], "checkout-web"]) {
      expect(await refusal("metrics.stats", params)).toBe("metrics.stats requires an object");
    }
    expect(await refusal("metrics.stats", { ...STATS, service: 7 })).toBe(
      "service must be a string",
    );
    expect(await refusal("metrics.stats", { ...STATS, service: "  " })).toBe(BOUND);
    expect(await refusal("metrics.stats", { ...STATS, service: "s".repeat(65) })).toBe(BOUND);
    // 64 once trimmed: measured on the trimmed value, so the padding does not count.
    const padded = await dispatchMetricsRpc(
      "metrics.stats",
      { ...STATS, service: `  ${"s".repeat(64)}  ` },
      { ...ctx, loadConfig: () => new Map([["s".repeat(64), config("s".repeat(64))]]) },
    );
    expect(padded.kind).toBe("hit");
  });
});

describe("the clock", () => {
  test("with no nowMs injected, both methods read the wall clock", async () => {
    const wallCtx: MetricsRpcContext = { db, loadConfig: ctx.loadConfig };
    const before = Date.now();
    const dora = await dispatchMetricsRpc("metrics.dora", { service: "unknown-svc" }, wallCtx);
    const stats = await dispatchMetricsRpc(
      "metrics.stats",
      { ...STATS, service: "checkout-web" },
      wallCtx,
    );
    const after = Date.now();

    const computedAt = Date.parse((dora as { value: { computed_at: string } }).value.computed_at);
    expect(computedAt).toBeGreaterThanOrEqual(before);
    expect(computedAt).toBeLessThanOrEqual(after);
    const until = (stats as { value: { window: { until_ms: number } } }).value.window.until_ms;
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until).toBeLessThanOrEqual(after);
  });
});

describe("metrics.stats — faults that are not about the request", () => {
  test("an evaluator failure propagates as itself, not as a -32602", async () => {
    const bare = new Database(":memory:"); // no `item` table for the evaluator to read
    try {
      const err: unknown = await dispatchMetricsRpc(
        "metrics.stats",
        { ...STATS, service: "checkout-web" },
        { ...ctx, db: bare },
      ).then(
        (v) => new Error(`resolved: ${JSON.stringify(v)}`),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MetricsRpcError);
      expect((err as Error).message).toContain("no such table");
    } finally {
      bare.close();
    }
  });
});
