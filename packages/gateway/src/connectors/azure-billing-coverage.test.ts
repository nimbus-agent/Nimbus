// Direct tests for the routing and cursor branches of the Azure sync: the defaults when no test seam is passed, the
// credential-less and unreadable-config paths with a recorded cursor, and the switch from the Query API to an export
// (what stays recorded, what is cleared, and what a refused clear does).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAzureConfig } from "../config/cost-azure-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
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
const ACCT = SUB.slice(1);
const WHERE = `azure://acmecost/exports/${AZURE_FAKE_PATH}`;
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
const COLS = ["Cost", "UsageDate", "ServiceName", "ResourceGroupName", "Currency"].map((name) => ({
  name,
  type: "String",
}));

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

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  upsertSchedulerRegistration(db, "azure_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
    ...over,
  } as SyncContext;
}

const stored = () =>
  readCostLines(db, { fromDay: "2026-10-01", toDay: "2026-11-30" }).filter(
    (l) => l.source === "azure_billing",
  );

const exportCfg = (scopes: readonly string[] = []): NimbusCostAzureConfig => ({
  export: { account: "acmecost", container: "exports", path: AZURE_FAKE_PATH },
  scopes,
});

function queryFetch(s: AzureFakeStorage): AzureFetch {
  return async (url, init) =>
    new URL(url).host === "management.azure.com"
      ? new Response(
          JSON.stringify({
            properties: { columns: COLS, rows: [[10, 20261103, "Storage", "rg1", "USD"]] },
          }),
        )
      : s.fetch(url, init);
}

async function sync(
  cfg: NimbusCostAzureConfig | null,
  fetchFn: AzureFetch,
  cursor: string | null,
  over: Partial<SyncContext> = {},
) {
  const out = await createAzureBillingCostSyncable({
    azure: () => cfg,
    now: () => NOW,
    fetch: fetchFn,
  }).sync(ctx(over), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor) };
}

const cursorOf = (c: Parameters<typeof encodeCostSyncCursor>[1]) => encodeCostSyncCursor(PREFIX, c);

test("with no seam passed the sync uses the global fetch and the clock (query and export modes)", async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: Request | string | URL) => {
    const u = new URL(String(input));
    seen.push(u.host);
    if (u.host === "login.microsoftonline.com") {
      return new Response(JSON.stringify({ access_token: "T" }));
    }
    return u.host === "management.azure.com"
      ? new Response(null, { status: 204 })
      : new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const q = await createAzureBillingCostSyncable({
      azure: () => ({ export: null, scopes: [SUB] }),
    }).sync(ctx(), null);
    expect(decodeCostSyncCursor(PREFIX, q.cursor).gaps).toEqual({});
    expect(seen).toContain("management.azure.com");
    const e = await createAzureBillingCostSyncable({ azure: () => exportCfg() }).sync(ctx(), null);
    expect(Object.keys(decodeCostSyncCursor(PREFIX, e.cursor).gaps)).toEqual([WHERE]);
    expect(seen).toContain("acmecost.blob.core.windows.net");
  } finally {
    globalThis.fetch = real;
  }
});

test("no credentials: only the configured accounts' recorded cursor entries are kept", async () => {
  await vault.delete("azure.client_secret");
  const s = new AzureFakeStorage();
  const recorded = cursorOf({
    gaps: { [ACCT]: "old gap", elsewhere: "x" },
    synced: { [ACCT]: "2026-11-01", elsewhere: "2026-11-01" },
    pending: { [ACCT]: ["2026-10"], elsewhere: ["2026-10"] },
  });
  const q = await sync({ export: null, scopes: [SUB] }, s.fetch, recorded);
  expect(q.cursor).toEqual({
    gaps: { [ACCT]: "old gap" },
    synced: { [ACCT]: "2026-11-01" },
    pending: { [ACCT]: ["2026-10"] },
  });
  expect(s.tokenCalls).toBe(0);
  const withExport = cursorOf({ gaps: { [WHERE]: "e" }, synced: {}, pending: {} });
  expect((await sync(exportCfg(), s.fetch, withExport)).cursor.gaps).toEqual({ [WHERE]: "e" });
});

test("an unreadable cost config keeps a recorded cursor and writes an empty one when there is none", async () => {
  const s = new AzureFakeStorage();
  const recorded = cursorOf({ gaps: { [ACCT]: "g" }, synced: {}, pending: {} });
  expect((await sync(null, s.fetch, recorded)).out.cursor).toBe(recorded);
  expect((await sync(null, s.fetch, null)).cursor).toEqual({ gaps: {}, synced: {}, pending: {} });
});

test("no export and only an unusable scope is the configuration gap", async () => {
  const s = new AzureFakeStorage();
  const r = await sync({ export: null, scopes: ["not a scope"] }, s.fetch, null);
  expect(Object.values(r.cursor.gaps)).toHaveLength(1);
  expect(Object.values(r.cursor.gaps)[0]).toContain("not configured");
});

test("an export with a gap keeps the query scopes (even one with no synced day); a scope with no stored lines is skipped", async () => {
  const s = new AzureFakeStorage();
  const fetchFn = queryFetch(s);
  const viaQuery = await sync({ export: null, scopes: [SUB] }, fetchFn, null);
  const other = "subscriptions/99999999-2222-3333-4444-555555555555";
  const recorded = decodeCostSyncCursor(PREFIX, viaQuery.out.cursor);
  const mixed = cursorOf({
    gaps: { ...recorded.gaps, [other]: "refused", azure: "config gap", [WHERE]: "old" },
    synced: { ...recorded.synced, "azure://old/export/path": "2026-11-01" },
    pending: recorded.pending,
  });
  // Nothing is delivered yet: the export has a stated gap, so nothing is cleared and the scopes stay recorded.
  const r = await sync(exportCfg(), fetchFn, mixed);
  expect(stored()).toHaveLength(1);
  expect(Object.keys(r.cursor.synced).sort()).toEqual([ACCT, other].sort());
  expect(r.cursor.synced[other]).toBe("1970-01-01");
  expect(r.cursor.synced[ACCT]).toBe("2026-11-20");

  // A delivery: the export writes, the scope with lines is cleared, the one with none is skipped, both dropped.
  const row = "ACCT-1,7,USD,2026-11-03T00:00:00Z,Storage,2026-11-01T00:00:00Z";
  s.deliver(
    "2026-11",
    [Bun.gzipSync(new TextEncoder().encode(`${HEADER}\n${row}\n`))],
    "Thu, 19 Nov 2026 10:00:00 GMT",
  );
  const done = await sync(exportCfg(), fetchFn, r.out.cursor);
  expect(stored().map((l) => l.billingAccountId)).toEqual(["ACCT-1"]);
  expect(Object.keys(done.cursor.synced)).toEqual([WHERE]);
});

test("a refused clear of the earlier query lines is a retry: nothing is dropped and the next run clears", async () => {
  const s = new AzureFakeStorage();
  const fetchFn = queryFetch(s);
  const viaQuery = await sync({ export: null, scopes: [SUB] }, fetchFn, null);
  const row = "ACCT-1,7,USD,2026-11-03T00:00:00Z,Storage,2026-11-01T00:00:00Z";
  s.deliver(
    "2026-11",
    [Bun.gzipSync(new TextEncoder().encode(`${HEADER}\n${row}\n`))],
    "Thu, 19 Nov 2026 10:00:00 GMT",
  );
  const base = buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing");
  for (const thrown of [new Error("disk"), "plain text"]) {
    const refusing: Partial<SyncContext> = {
      replaceCostLinesForMonth: (target, lines) => {
        if (target.billingAccountId === ACCT) throw thrown;
        return base.replaceCostLinesForMonth(target, lines);
      },
    };
    const r = await sync(exportCfg(), fetchFn, viaQuery.out.cursor, refusing);
    expect(stored().some((l) => l.billingAccountId === ACCT)).toBe(true);
    expect(r.cursor.pending[WHERE]?.length).toBeGreaterThan(0);
    expect(Object.keys(r.cursor.synced)).toContain(ACCT);
  }
  const ok = await sync(exportCfg(), fetchFn, viaQuery.out.cursor);
  expect(stored().map((l) => l.billingAccountId)).toEqual(["ACCT-1"]);
  expect(Object.keys(ok.cursor.synced)).toEqual([WHERE]);
});
