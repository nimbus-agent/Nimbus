// Phase 7 slice 9 acceptance: a fake Bitbucket Cloud (documentation-shaped REST, no network). Two repositories with
// 100 and 40 pipeline minutes and no rate, so `cost.products` shows 140 unpriced minutes under the source and no
// money; then `[cost.bitbucket] rate_per_minute = 0.01` prices the stored month at 1.40 USD with no new fetch of its
// own; a re-sync changes nothing; a workspace the token cannot see shows its gap. The credential is an Atlassian API
// token pair. The real config parse, syncable, capabilities, store and cost RPC run; one clock serves syncs and views.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { loadNimbusCostFromConfigDir } from "../config/cost-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import { createBitbucketCostSyncable } from "./bitbucket-cost-sync.ts";

const DAY = 86_400_000;
const DAY1 = Date.UTC(2026, 10, 19, 9);
const DAY2 = DAY1 + DAY;

let db: Database;
let dir: string;
const toml = (rate: string) =>
  `[cost.bitbucket]\nworkspaces = ["acme", "hidden"]\n${rate}\n\n[[cost.rule]]\nmatch = { provider = "bitbucket" }\nset = { product = "platform" }\n`;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-bb-billing-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const REPOS = [
  { uuid: "{r-web}", full_name: "acme/web", seconds: 6000 },
  { uuid: "{r-api}", full_name: "acme/api", seconds: 2400 },
];

function bitbucketFake() {
  return (async (input: string) => {
    const parts = new URL(input).pathname.replace("/2.0/repositories/", "").split("/");
    if (parts[0] === "hidden") return new Response("", { status: 404 });
    if (parts.length === 1) {
      const values = REPOS.map((r) => ({ uuid: r.uuid, full_name: r.full_name }));
      return new Response(JSON.stringify({ values, pagelen: 100 }), { status: 200 });
    }
    const repo = REPOS.find((r) => r.full_name === `${parts[0]}/${parts[1]}`);
    const values = [
      {
        uuid: `{p-${parts[1]}}`,
        created_on: "2026-11-18T09:00:00.000000+00:00",
        completed_on: "2026-11-18T10:00:00.000000+00:00",
        build_seconds_used: repo?.seconds ?? 0,
      },
    ];
    return new Response(JSON.stringify({ values, pagelen: 100 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function syncAt(now: number, cursor: string | null) {
  const vault = createMockVault();
  await vault.set("bitbucket.email", "me@acme.test");
  await vault.set("bitbucket.api_token", "tok");
  upsertSchedulerRegistration(db, "bitbucket_billing", DAY, now, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "bitbucket_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      bitbucket: { requestsPerMinute: 600_000, burstSize: 100 },
    }),
    depth: "full",
  } as SyncContext;
  const out = await createBitbucketCostSyncable({
    bitbucket: () => loadNimbusCostFromConfigDir(dir).bitbucket,
    now: () => now,
    fetch: (u, i) => bitbucketFake()(u, i) as ReturnType<typeof fetch>,
  }).sync(ctx, cursor);
  // The scheduler stores the cursor; the cost views read the gaps from there.
  updateSchedulerState(db, {
    serviceId: "bitbucket_billing",
    cursor: out.cursor,
    intervalMs: DAY,
    lastSyncAt: now,
    nextSyncAt: now + DAY,
    status: "ok",
    errorMsg: null,
    consecutiveFailures: 0,
    paused: false,
  });
  return out.cursor;
}

type Products = {
  byCurrency: Record<
    string,
    { total: number; rows: { key: string; provider: string; amount: number }[] }
  >;
  freshness: {
    source: string;
    gap?: string;
    unpriced?: { unit: string; quantity: number; lines: number }[];
  }[];
};

async function products(now: number): Promise<Products> {
  const out = await dispatchCostRpc(
    "cost.products",
    { period: "month" },
    { db, configDir: dir, caller: { kind: "cli" }, now: () => now },
  );
  if (out.kind !== "hit") throw new Error("cost.products was not routed");
  return out.value as Products;
}

describe("acceptance: Bitbucket Pipelines minutes as cost lines", () => {
  test("unpriced minutes, then a rate prices the month; a re-sync changes nothing; a hidden workspace's gap", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml(""));
    const c1 = await syncAt(DAY1, null);
    const v1 = await products(DAY1);
    const bb1 = v1.freshness.find((f) => f.source === "bitbucket_billing");
    expect(bb1?.unpriced).toEqual([{ unit: "minute", quantity: 140, lines: 2 }]);
    expect(bb1?.gap).toContain("hidden");
    expect(v1.byCurrency["USD"]?.total ?? 0).toBe(0);

    writeFileSync(join(dir, "nimbus.toml"), toml("rate_per_minute = 0.01"));
    const c2 = await syncAt(DAY2, c1);
    const v2 = await products(DAY2);
    const platform = v2.byCurrency["USD"]?.rows.filter((r) => r.key === "platform") ?? [];
    expect(platform.reduce((a, r) => a + r.amount, 0)).toBeCloseTo(1.4, 9);
    expect(v2.freshness.find((f) => f.source === "bitbucket_billing")?.unpriced).toBeUndefined();
    const days = db
      .query(
        "SELECT charge_day AS d, SUM(consumed_quantity) AS q FROM cost_line GROUP BY charge_day ORDER BY d",
      )
      .all();
    expect(days).toEqual([{ d: "2026-11-18", q: 140 }]);

    await syncAt(DAY2, c2);
    expect((await products(DAY2)).byCurrency["USD"]?.rows).toEqual(v2.byCurrency["USD"]?.rows);
  });
});
