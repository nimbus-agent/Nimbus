// Switching an Azure cost source from the Query API to an export must not count a month twice: the query's lines
// carry the scope as billing account, the export's carry the FOCUS BillingAccountId, so the export clears the same
// month of every scope the query recorded.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAzureConfig } from "../config/cost-azure-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { AZURE_FAKE_PATH, AzureFakeStorage } from "../testing/azure-blob-fake.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { AzureFetch } from "./_lib/azure-token.ts";
import { createAzureBillingCostSyncable } from "./azure-billing-cost-sync.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.azure_billing;
const SUB = "/subscriptions/11111111-2222-3333-4444-555555555555";
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
const QUERY_COLUMNS = ["Cost", "UsageDate", "ServiceName", "ResourceGroupName", "Currency"].map(
  (name) => ({ name, type: "String" }),
);

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("azure.tenant_id", "11111111-2222-3333-4444-555555555555");
  await vault.set("azure.client_id", "app");
  await vault.set("azure.client_secret", "secret");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "azure_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
}

const stored = () =>
  readCostLines(db, { fromDay: "2026-10-01", toDay: "2026-11-30" }).filter(
    (l) => l.source === "azure_billing",
  );

async function sync(cfg: NimbusCostAzureConfig, fetchFn: AzureFetch, cursor: string | null) {
  const out = await createAzureBillingCostSyncable({
    azure: () => cfg,
    now: () => NOW,
    fetch: fetchFn,
  }).sync(ctx(), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor) };
}

function bothFetch(s: AzureFakeStorage): AzureFetch {
  return async (url, init) =>
    new URL(url).host === "management.azure.com"
      ? new Response(
          JSON.stringify({
            properties: {
              columns: QUERY_COLUMNS,
              rows: [[10, 20261103, "Storage", "rg1", "USD"]],
            },
          }),
        )
      : s.fetch(url, init);
}

const exportCfg = (scopes: readonly string[]): NimbusCostAzureConfig => ({
  export: { account: "acmecost", container: "exports", path: AZURE_FAKE_PATH },
  scopes,
});

test("a month first written by the query, then by the export, holds only the export's lines", async () => {
  const s = new AzureFakeStorage();
  const fetchFn = bothFetch(s);
  const viaQuery = await sync({ export: null, scopes: [SUB] }, fetchFn, null);
  expect(stored().map((l) => l.billingAccountId)).toEqual([SUB.slice(1)]);
  expect(Object.keys(viaQuery.cursor.synced)).toEqual([SUB.slice(1)]);

  const row = "ACCT-1,7,USD,2026-11-03T00:00:00Z,Storage,2026-11-01T00:00:00Z";
  s.deliver(
    "2026-11",
    [Bun.gzipSync(new TextEncoder().encode(`${HEADER}\n${row}\n`))],
    "Thu, 19 Nov 2026 10:00:00 GMT",
  );
  const viaExport = await sync(exportCfg([SUB]), fetchFn, viaQuery.out.cursor);
  expect(stored().map((l) => [l.billingAccountId, l.billedCost])).toEqual([["ACCT-1", 7]]);
  // The scope is dropped from the cursor once the export ran clean.
  expect(Object.keys(viaExport.cursor.synced).every((k) => k.startsWith("azure://"))).toBe(true);
});

test("the earlier scopes stay recorded while the export has a gap", async () => {
  const s = new AzureFakeStorage();
  const fetchFn = bothFetch(s);
  const viaQuery = await sync({ export: null, scopes: [SUB] }, fetchFn, null);
  // Nothing is delivered yet: a stated gap, so the query's lines and its record stay.
  const r = await sync(exportCfg([]), fetchFn, viaQuery.out.cursor);
  expect(stored()).toHaveLength(1);
  expect(Object.keys(r.cursor.synced)).toContain(SUB.slice(1));
});
