// Phase 7 slice 13 acceptance: a fake BigQuery export table, the real config parse, syncable, capabilities, store and
// cost RPC. The same bill is ALSO imported as a `[cost.focus]` file: the views count it once (C4), and with no
// `[cost.gcp] export_table` the freshness shows the stated gap.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { bqRow, FakeBigQuery } from "../../test/helpers/gcp-billing-fake.ts";
import { loadNimbusCostFromConfigDir } from "../config/cost-toml.ts";
import { importFocusPath } from "../finops/cost-import.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import { createGcpBillingCostSyncable } from "./gcp-billing-cost-sync.ts";
import { GCP_COST_GAPS } from "./gcp-billing-query.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 9);
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart,ProviderName";
const CSV = `${HEADER}
01AB23-CD45EF-6789AB,40,USD,2026-11-18T00:00:00Z,Compute Engine,2026-11-01T00:00:00Z,Google Cloud
01AB23-CD45EF-6789AB,60,USD,2026-11-19T00:00:00Z,Cloud Storage,2026-11-01T00:00:00Z,Google Cloud
`;
const TOML = (gcp: string, cost = "") => `${gcp}\n[cost]\n${cost}\n`;

let db: Database;
let dir: string;
let bq: FakeBigQuery;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-gcp-billing-"));
  bq = new FakeBigQuery();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function syncGcp(cursor: string | null) {
  const vault = createMockVault();
  await vault.set("gcp.auth_source", "gcloud");
  await vault.set("gcp.project_id", "run-proj");
  upsertSchedulerRegistration(db, "gcp_billing", DAY, NOW, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "gcp_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      gcp_billing: { requestsPerMinute: 100000, burstSize: 1000 },
    }),
    depth: "full",
  } as SyncContext;
  const out = await createGcpBillingCostSyncable({
    gcp: () => loadNimbusCostFromConfigDir(dir).gcp,
    now: () => NOW,
    fetch: bq.fetch,
    mintAccessToken: async () => "tok",
  }).sync(ctx, cursor);
  updateSchedulerState(db, {
    serviceId: "gcp_billing",
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

describe("acceptance: GCP cost from the BigQuery billing export", () => {
  test("synced once, the file import of the same bill is set aside, and authoritative chooses", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      TOML(
        '[cost.gcp]\nexport_table = "my-proj.billing.gcp_billing_export_v1_01AB23_CD45EF_6789AB"',
      ),
    );
    bq.rows.set("2026-11-01", [
      bqRow({ day: "2026-11-18", cost: "50", credits: "-10", service: "Compute Engine" }),
      bqRow({
        day: "2026-11-19",
        cost: "60",
        credits: "0",
        service: "Cloud Storage",
        sku_id: "S2",
      }),
    ]);
    const c1 = await syncGcp(null);
    expect((await products()).byCurrency["USD"]?.total).toBe(100);

    const file = join(dir, "export.csv");
    writeFileSync(file, CSV);
    expect(importFocusPath(db, file, { dryRun: false, now: () => NOW }).files[0]?.status).toBe(
      "imported",
    );
    const v = await products();
    expect(v.byCurrency["USD"]?.total).toBe(100); // not 200
    expect(v.excludedSources.map((e) => e.source)).toEqual(["focus"]);

    writeFileSync(
      join(dir, "nimbus.toml"),
      TOML(
        '[cost.gcp]\nexport_table = "my-proj.billing.gcp_billing_export_v1_01AB23_CD45EF_6789AB"',
        'authoritative = { gcp = "focus" }',
      ),
    );
    const f = await products();
    expect(f.byCurrency["USD"]?.total).toBe(100);
    expect(f.excludedSources.map((e) => e.source)).toEqual(["gcp_billing"]);

    await syncGcp(c1);
    expect((await products()).byCurrency["USD"]?.total).toBe(100);
  });

  test("with no export_table, the freshness line states the gap", async () => {
    writeFileSync(join(dir, "nimbus.toml"), TOML("[cost.gcp]\nmax_bytes_billed = 2147483648"));
    await syncGcp(null);
    const gcp = (await products()).freshness.find((f) => f.source === "gcp_billing");
    expect(gcp?.gap).toBe(GCP_COST_GAPS.notConfigured);
  });
});
