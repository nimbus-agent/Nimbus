import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const DAY = 86_400_000;
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags";

function row(cost: number, day: string, service: string, tags: Record<string, string>): string {
  const json = JSON.stringify(tags).replaceAll('"', '""');
  return `${String(cost)},111,USD,${day}T00:00:00Z,AWS,${service},"${json}"`;
}

/** 28 days to 2026-11-26: checkout/payment-service 10/day with 50 on the last two days, search 3/day. */
function csv(): string {
  const rows = [HEADER];
  for (let d = 0; d < 28; d++) {
    const day = new Date(Date.UTC(2026, 10, 26) - (27 - d) * DAY).toISOString().slice(0, 10);
    rows.push(
      row(d >= 26 ? 50 : 10, day, "Amazon EC2", {
        product: "checkout",
        service: "payment-service",
      }),
    );
    rows.push(row(5, day, "Amazon RDS", { product: "checkout", service: "orders-service" }));
    rows.push(row(3, day, "Amazon S3", { product: "search" }));
  }
  return rows.join("\n");
}

const TOML = [
  "[[cost.rule]]",
  'match = { tag = { product = "*", service = "*" } }',
  'set = { product = "{tag.product}", service = "{tag.service}" }',
  "",
  "[[cost.rule]]",
  'match = { tag = { product = "*" } }',
  'set = { product = "{tag.product}" }',
  "",
  "[metrics.dora.payment-service]",
  'repos = ["github:acme/payments"]',
  'deploy_environments = ["prod"]',
  "",
].join("\n");

let db: Database;
let dir: string;
let realFetch: typeof fetch;
let fetchCalls = 0;
beforeEach(async () => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-why-rpc-"));
  writeFileSync(join(dir, "a.csv"), csv());
  writeFileSync(join(dir, "nimbus.toml"), TOML);
  await call("cost.import", { path: join(dir, "a.csv") }, "cli");
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('dep-1', 'github_actions', 'deployment', 'dep-1', 'Deploy', ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, workflow_url, ci_run_external_id, created_at)
     VALUES ('dep-1', 'github-actions', 'payment-service', 'prod', 'sha-1', 'refs/heads/main', ?, ?, 'success', NULL, NULL, ?)`,
    [NOW - 30 * 3_600_000, NOW - 29 * 3_600_000, NOW],
  );
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("cost.why must not reach the network");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, params: unknown, kind?: ClientKind): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    configDir: dir,
    now: () => NOW,
    ...(kind === undefined ? {} : { caller: { kind } }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<CostRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CostRpcError) return e;
    throw e;
  }
  throw new Error("expected a CostRpcError");
}

type Why = {
  empty: boolean;
  target: { kind: string; name: string };
  range: { fromDay: string; toDay: string };
  byCurrency: Record<string, { current: number; previous: number; spikeDay: string | null }>;
  services: string[];
  context: {
    serviceId: string;
    configured: boolean;
    deploys: { sha: string; nearSpike: boolean }[];
  }[];
  freshness: { source: string }[];
};

const egressRows = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;

describe("cost.why", () => {
  test("compares the default 14 days and joins the context for the target's services", async () => {
    const w = (await call("cost.why", { target: "checkout" }, "cli")) as Why;
    expect(w.empty).toBe(false);
    expect(w.target).toEqual({ kind: "product", name: "checkout" });
    expect(w.range).toMatchObject({ fromDay: "2026-11-13", toDay: "2026-11-26" });
    expect(w.byCurrency["USD"]).toMatchObject({
      current: 290,
      previous: 210,
      spikeDay: "2026-11-25",
    });
    expect(w.services).toEqual(["payment-service", "orders-service"]);
    expect(w.context.map((c) => c.serviceId)).toEqual(["payment-service", "orders-service"]);
    expect(w.context[0]?.deploys).toEqual([
      expect.objectContaining({ sha: "sha-1", nearSpike: true }),
    ]);
    expect(w.context[1]?.configured).toBe(false);
    expect(w.freshness.map((f) => f.source)).toEqual(["focus"]);
    expect(egressRows()).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("served to ui, refused to every other kind", async () => {
    expect(((await call("cost.why", { target: "search" }, "ui")) as Why).target.name).toBe(
      "search",
    );
    for (const kind of ["mcp", "http", undefined] as (ClientKind | undefined)[]) {
      const e = await rpcError(call("cost.why", { target: "search" }, kind));
      expect(e.message).toContain("ERR_COST_FORBIDDEN_CLIENT");
    }
  });

  test("bad params are -32602", async () => {
    for (const p of [
      undefined,
      {},
      { target: "" },
      { target: 3 },
      { target: "x", period: "9y" },
      { target: "x", nope: 1 },
    ]) {
      expect((await rpcError(call("cost.why", p, "cli"))).rpcCode).toBe(-32602);
    }
  });

  test("an unknown target is -32602 naming the known products and services", async () => {
    const e = await rpcError(call("cost.why", { target: "nope" }, "cli"));
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("products: checkout, search");
    expect(e.message).toContain("services: orders-service, payment-service");
  });

  test("no cost data imported is its own answer", async () => {
    db.run("DELETE FROM cost_line");
    const w = (await call("cost.why", { target: "checkout" }, "cli")) as Why;
    expect(w.empty).toBe(true);
    expect(w.context).toEqual([]);
  });
});

describe("cost.why across the two periods", () => {
  async function reimport(rows: string[]): Promise<void> {
    db.run("DELETE FROM cost_line");
    writeFileSync(join(dir, "b.csv"), [HEADER, ...rows].join("\n"));
    await call("cost.import", { path: join(dir, "b.csv") }, "cli");
  }
  const dayOf = (offset: number): string =>
    new Date(Date.UTC(2026, 10, 26) - offset * DAY).toISOString().slice(0, 10);

  test("one source rule applies to both periods: raw lines now exclude Vantage before as well", async () => {
    const rows: string[] = [];
    for (let d = 0; d < 12; d++)
      rows.push(row(20, dayOf(d), "Amazon EC2", { product: "checkout" }));
    await reimport(rows);
    for (let d = 14; d < 28; d++) {
      upsertIndexedItem(db, {
        service: "vantage",
        type: "cost_allocation",
        externalId: `v${String(d)}`,
        title: "t",
        bodyPreview: "t",
        modifiedAt: Date.parse(`${dayOf(d)}T00:00:00Z`),
        metadata: {
          scopeSeries: `rep|ws|tag~h${String(d)}`,
          dimensionKind: "tag",
          dimensionKey: "product",
          dimensionValue: "checkout",
          periodStartMs: Date.parse(`${dayOf(d)}T00:00:00Z`),
          periodEndMs: Date.parse(`${dayOf(d)}T00:00:00Z`) + DAY,
          amount: 50,
          currency: "USD",
          provider: "aws",
          cloudService: "Amazon EC2",
        },
        syncedAt: NOW,
      });
    }
    const w = (await call("cost.why", { target: "checkout" }, "cli")) as Why & {
      excludedSources: { source: string }[];
      coverage: Record<string, { current: number; previous: number }>;
    };
    expect(w.byCurrency["USD"]).toMatchObject({ current: 240, previous: 0 });
    expect(w.excludedSources.map((e) => e.source)).toEqual(["vantage"]);
    expect(w.coverage["USD"]).toMatchObject({ current: 12, previous: 0 });
  });

  test("a deploy the day before a spike on the first day of the period is listed, near the spike", async () => {
    const rows: string[] = [];
    for (let d = 0; d < 28; d++) {
      rows.push(
        row(d < 14 ? 30 : 10, dayOf(d), "Amazon EC2", {
          product: "checkout",
          service: "payment-service",
        }),
      );
    }
    await reimport(rows);
    const at = Date.parse(`${dayOf(14)}T22:00:00Z`);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('dep-0', 'github_actions', 'deployment', 'dep-0', 'Deploy', ?, ?)`,
      [at, NOW],
    );
    db.run(
      `INSERT INTO deployment_items
         (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
          conclusion, workflow_url, ci_run_external_id, created_at)
       VALUES ('dep-0', 'github-actions', 'payment-service', 'prod', 'sha-0', 'refs/heads/main', ?, ?, 'success', NULL, NULL, ?)`,
      [at - 600_000, at, NOW],
    );
    const w = (await call("cost.why", { target: "checkout" }, "cli")) as Why;
    expect(w.byCurrency["USD"]?.spikeDay).toBe("2026-11-13");
    expect(w.context[0]?.deploys[0]).toMatchObject({ sha: "sha-0", nearSpike: true });
  });
});

describe("cost.rulesCheck", () => {
  test("defaults to 30 days, serves cli and ui only, writes no egress row", async () => {
    const r = (await call("cost.rulesCheck", undefined, "cli")) as {
      range: { fromDay: string };
      rules: { index: number; lines: number }[];
      unusedRules: number[];
    };
    expect(r.range.fromDay).toBe("2026-10-28");
    expect(r.rules.map((x) => x.lines)).toEqual([56, 28]);
    expect(r.unusedRules).toEqual([]);
    expect(
      (r as unknown as { freshness: { source: string }[] }).freshness.map((f) => f.source),
    ).toEqual(["focus"]);
    await call("cost.rulesCheck", { period: "7d" }, "ui");
    expect((await rpcError(call("cost.rulesCheck", {}, "mcp"))).message).toContain(
      "ERR_COST_FORBIDDEN_CLIENT",
    );
    expect((await rpcError(call("cost.rulesCheck", { period: "x" }, "cli"))).rpcCode).toBe(-32602);
    expect(egressRows()).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
