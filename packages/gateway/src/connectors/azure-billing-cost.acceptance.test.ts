// Phase 7 slice 12a acceptance: a fake Blob Storage account holding a gzipped FOCUS export, the real config parse, syncable,
// capabilities, store and cost RPC. The same bill is ALSO imported as a `[cost.focus]` file: the views count it once
// (the file import is set aside, with its reason), and `[cost] authoritative` can choose the file instead. With no
// `[cost.azure]` export the freshness shows the stated gap.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { loadNimbusCostFromConfigDir } from "../config/cost-toml.ts";
import { importFocusPath } from "../finops/cost-import.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { AzureFetch } from "./_lib/azure-token.ts";
import { createAzureBillingCostSyncable } from "./azure-billing-cost-sync.ts";
import { AZURE_COST_GAPS } from "./azure-billing-export.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 9);
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart,ProviderName,Tags";
const CSV = `${HEADER}
111,40,USD,2026-11-18T00:00:00Z,Storage,2026-11-01T00:00:00Z,Microsoft,"{""product"":""checkout""}"
111,60,USD,2026-11-19T00:00:00Z,Virtual Machines,2026-11-01T00:00:00Z,Microsoft,"{""product"":""checkout""}"
`;

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-azure-billing-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const AZ =
  '[cost.azure]\nexport = { account = "acmecost", container = "exports", path = "focus/monthly" }';
const toml = (azure: string, cost = "") =>
  `${azure}\n[cost]\n${cost}\n[[cost.rule]]\nmatch = { tag = { product = "*" } }\nset = { product = "{tag.product}" }\n`;

const objects = new Map<string, Uint8Array>();
const fakeFetch: AzureFetch = async (url) => {
  const u = new URL(url);
  if (u.host === "login.microsoftonline.com") {
    return new Response(JSON.stringify({ access_token: "T" }));
  }
  if (u.searchParams.get("comp") === "list") {
    const blobs = [...objects.keys()]
      .map(
        (k) =>
          `<Blob><Name>${k}</Name><Properties><Last-Modified>Thu, 19 Nov 2026 10:00:00 GMT</Last-Modified></Properties></Blob>`,
      )
      .join("");
    return new Response(
      `<EnumerationResults><Blobs>${blobs}</Blobs><NextMarker /></EnumerationResults>`,
    );
  }
  const b = objects.get(decodeURIComponent(u.pathname.replace("/exports/", "")));
  return b === undefined ? new Response("", { status: 404 }) : new Response(b);
};

async function syncAzure(cursor: string | null) {
  const vault = createMockVault();
  await vault.set("azure.tenant_id", "11111111-2222-3333-4444-555555555555");
  await vault.set("azure.client_id", "app");
  await vault.set("azure.client_secret", "secret");
  upsertSchedulerRegistration(db, "azure_billing", DAY, NOW, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
  const out = await createAzureBillingCostSyncable({
    azure: () => loadNimbusCostFromConfigDir(dir).azure,
    now: () => NOW,
    fetch: fakeFetch,
  }).sync(ctx, cursor);
  updateSchedulerState(db, {
    serviceId: "azure_billing",
    cursor: out.cursor,
    intervalMs: DAY,
    lastSyncAt: NOW,
    nextSyncAt: NOW + DAY,
    status: "ok",
    errorMsg: null,
    consecutiveFailures: 0,
    paused: false,
  });
  return out.cursor;
}

type Products = {
  byCurrency: Record<string, { total: number }>;
  excludedSources: { source: string; provider: string; reason: string }[];
  freshness: { source: string; gap?: string }[];
};
async function products(): Promise<Products> {
  const out = await dispatchCostRpc(
    "cost.products",
    { period: "month" },
    { db, configDir: dir, caller: { kind: "cli" }, now: () => NOW },
  );
  if (out.kind !== "hit") throw new Error("cost.products was not routed");
  return out.value as Products;
}

describe("acceptance: Azure cost from a FOCUS export in Blob Storage", () => {
  test("synced once, the file import of the same bill is set aside, and authoritative chooses", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml(AZ));
    objects.clear();
    objects.set(
      "focus/monthly/20261101-20261130/run-1/manifest.json",
      new TextEncoder().encode(
        JSON.stringify({
          blobs: [{ blobName: "focus/monthly/20261101-20261130/run-1/part_1.csv.gz" }],
        }),
      ),
    );
    objects.set(
      "focus/monthly/20261101-20261130/run-1/part_1.csv.gz",
      Bun.gzipSync(new TextEncoder().encode(CSV)),
    );
    const c1 = await syncAzure(null);
    expect((await products()).byCurrency["USD"]?.total).toBe(100);

    // The same bill, imported from a file (a copy someone downloaded by hand).
    const file = join(dir, "export.csv");
    writeFileSync(file, CSV);
    expect(importFocusPath(db, file, { dryRun: false, now: () => NOW }).files[0]?.status).toBe(
      "imported",
    );
    const v = await products();
    expect(v.byCurrency["USD"]?.total).toBe(100); // not 200
    expect(v.excludedSources).toEqual([
      {
        source: "focus",
        provider: "azure",
        reason:
          "cloud sync active for this provider on 2 days (set [cost] authoritative to choose)",
      },
    ]);

    writeFileSync(join(dir, "nimbus.toml"), toml(AZ, 'authoritative = { azure = "focus" }'));
    const f = await products();
    expect(f.byCurrency["USD"]?.total).toBe(100);
    expect(f.excludedSources.map((e) => e.source)).toEqual(["azure_billing"]);

    // A re-sync changes nothing.
    await syncAzure(c1);
    expect((await products()).byCurrency["USD"]?.total).toBe(100);
  });

  test("with no export, the freshness line states the gap", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml("[cost.azure]\nscopes = []"));
    objects.clear();
    await syncAzure(null);
    const az = (await products()).freshness.find((f) => f.source === "azure_billing");
    expect(az?.gap).toBe(AZURE_COST_GAPS.notConfigured);
  });
});
