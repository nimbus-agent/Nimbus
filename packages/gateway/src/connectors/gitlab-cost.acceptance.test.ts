// Phase 7 slice 8 acceptance: a fake GitLab.com (documentation-shaped GraphQL, no network). Day 1: two projects
// with 100 and 40 compute minutes and no rate, so `cost.products` shows 140 unpriced minutes under the source and
// no money. Day 2: 130 and 40 with `rate_per_minute = 0.01`, so day 2 holds only the 30-minute difference and the
// whole month is re-priced to 1.70 USD. A re-sync changes nothing, and a group the token cannot see shows its gap.
// The real config parse, syncable, capabilities, store and cost RPC run; one fixed clock serves syncs and views.
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
import { createGitlabCostSyncable } from "./gitlab-cost-sync.ts";

const DAY = 86_400_000;
const DAY1 = Date.UTC(2026, 10, 19, 9);
const DAY2 = DAY1 + DAY;

let db: Database;
let dir: string;
const toml = (rate: string) =>
  `[cost.gitlab]\ngroups = ["acme", "hidden"]\n${rate}\n\n[[cost.rule]]\nmatch = { provider = "gitlab" }\nset = { product = "platform" }\n`;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-gl-billing-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function gitlabFake(totals: Record<string, number>) {
  return (async (_input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    if (body.query.includes("group(fullPath")) {
      const group = body.variables["p"] === "hidden" ? null : { id: "gid://gitlab/Group/1" };
      return new Response(JSON.stringify({ data: { group } }), { status: 200 });
    }
    // Only the current month has usage; the previous month (read on a first sync) is empty.
    const nodes = String(body.variables["d"]).startsWith("2026-11")
      ? Object.entries(totals).map(([fullPath, minutes]) => ({ minutes, project: { fullPath } }))
      : [];
    return new Response(
      JSON.stringify({
        data: {
          ciMinutesProjectMonthlyUsage: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
}

async function syncAt(now: number, totals: Record<string, number>, cursor: string | null) {
  const vault = createMockVault();
  await vault.set("gitlab.pat", "glpat-x");
  upsertSchedulerRegistration(db, "gitlab_billing", DAY, now, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "gitlab_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
  const out = await createGitlabCostSyncable({
    gitlab: () => loadNimbusCostFromConfigDir(dir).gitlab,
    now: () => now,
    fetch: gitlabFake(totals),
  }).sync(ctx, cursor);
  // The scheduler stores the cursor; the cost views read the gaps from there.
  updateSchedulerState(db, {
    serviceId: "gitlab_billing",
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

describe("acceptance: GitLab compute minutes as cost lines", () => {
  test("unpriced minutes, then a rate re-prices the month; deltas per day; a hidden group's gap", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml(""));
    const c1 = await syncAt(DAY1, { "acme/web": 100, "acme/api": 40 }, null);
    const v1 = await products(DAY1);
    const gl1 = v1.freshness.find((f) => f.source === "gitlab_billing");
    expect(gl1?.unpriced).toEqual([{ unit: "minute", quantity: 140, lines: 2 }]);
    expect(gl1?.gap).toContain("hidden");
    expect(v1.byCurrency["USD"]?.total ?? 0).toBe(0);

    writeFileSync(join(dir, "nimbus.toml"), toml("rate_per_minute = 0.01"));
    const c2 = await syncAt(DAY2, { "acme/web": 130, "acme/api": 40 }, c1);
    const v2 = await products(DAY2);
    const platform = v2.byCurrency["USD"]?.rows.filter((r) => r.key === "platform") ?? [];
    expect(platform.reduce((a, r) => a + r.amount, 0)).toBeCloseTo(1.7, 9);
    expect(v2.freshness.find((f) => f.source === "gitlab_billing")?.unpriced).toBeUndefined();
    const days = db
      .query(
        "SELECT charge_day AS d, SUM(consumed_quantity) AS q FROM cost_line GROUP BY charge_day ORDER BY d",
      )
      .all();
    expect(days).toEqual([
      { d: "2026-11-19", q: 140 },
      { d: "2026-11-20", q: 30 },
    ]);

    await syncAt(DAY2, { "acme/web": 130, "acme/api": 40 }, c2);
    expect((await products(DAY2)).byCurrency["USD"]?.rows).toEqual(v2.byCurrency["USD"]?.rows);
  });
});
