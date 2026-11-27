// Phase 7 slice 5 acceptance: a fake GitHub (documentation-shaped responses, no network) returns two days of
// Actions rows for acme/checkout; after the real syncable runs through the real capability and store,
// `cost.products` shows the GitHub cost under `checkout` (a `[[cost.rule]]` on `repo`), `cost.why` names it,
// a second identical sync changes nothing, and an org without billing access shows its gap in the freshness.
// Dates are relative to the real clock: the intake replaces the current UTC month's days up to today.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import { createGithubBillingCostSyncable } from "./github-billing-cost-sync.ts";

const DAY = 86_400_000;
const day = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10);

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-gh-billing-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    '[cost.github]\norgs = ["acme", "denied"]\n\n[[cost.rule]]\nmatch = { repo = "acme/checkout" }\nset = { product = "checkout" }\n',
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function githubFake() {
  return (async (input: string) => {
    const u = new URL(input);
    if (u.pathname.includes("/denied/"))
      return new Response('{"message":"Must be an org admin"}', { status: 403 });
    const month = `${u.searchParams.get("year")}-${String(u.searchParams.get("month")).padStart(2, "0")}`;
    const usageItems = [day(1), day(2)]
      .filter((d) => d.startsWith(month))
      .map((d) => ({
        date: `${d}T00:00:00Z`,
        product: "actions",
        sku: "actions_linux",
        quantity: 500,
        unitType: "minutes",
        pricePerUnit: 0.008,
        grossAmount: 4,
        discountAmount: 0,
        netAmount: 4,
        organizationName: "acme",
        repositoryName: "acme/checkout",
      }));
    return new Response(JSON.stringify({ usageItems }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function syncOnce(cursor: string | null): Promise<string | null> {
  const vault = createMockVault();
  await vault.set("github.pat", "tok");
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "github_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
  const s = createGithubBillingCostSyncable({
    githubOrgs: () => ["acme", "denied"],
    fetch: githubFake(),
  });
  const out = await s.sync(ctx, cursor);
  // The scheduler stores the cursor; the cost views read the gaps from there.
  upsertSchedulerRegistration(db, "github_billing", DAY, Date.now(), false);
  updateSchedulerState(db, {
    serviceId: "github_billing",
    cursor: out.cursor,
    intervalMs: DAY,
    lastSyncAt: Date.now(),
    nextSyncAt: Date.now() + DAY,
    status: "ok",
    errorMsg: null,
    consecutiveFailures: 0,
    paused: false,
  });
  return out.cursor;
}

async function call(method: string, params: unknown): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    configDir: dir,
    caller: { kind: "cli" },
  });
  if (out.kind !== "hit") throw new Error(`${method} was not routed`);
  return out.value;
}

type Products = {
  byCurrency: Record<string, { rows: { key: string; provider: string; amount: number }[] }>;
  freshness: { source: string; gap?: string }[];
};

describe("acceptance: GitHub billing usage as cost lines", () => {
  test("the GitHub cost lands under its product; a re-sync changes nothing; a denied org shows its gap", async () => {
    const cursor = await syncOnce(null);
    const view = (await call("cost.products", { period: "7d" })) as Products;
    const usd = view.byCurrency["USD"]?.rows ?? [];
    expect(
      usd.filter((r) => r.key === "checkout" && r.provider === "github").map((r) => r.amount),
    ).toEqual([8]);
    const github = view.freshness.find((f) => f.source === "github_billing");
    expect(github?.gap).toContain("cannot read billing for denied");

    await syncOnce(cursor);
    const again = (await call("cost.products", { period: "7d" })) as Products;
    expect(again.byCurrency["USD"]?.rows).toEqual(view.byCurrency["USD"]?.rows);

    const why = JSON.stringify(await call("cost.why", { target: "checkout", period: "7d" }));
    expect(why).toContain("github");
  });
});
