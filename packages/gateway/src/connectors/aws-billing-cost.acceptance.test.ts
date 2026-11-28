// Phase 7 slice 11a acceptance: a fake S3 bucket holding a gzipped FOCUS export, the real config parse, syncable,
// capabilities, store and cost RPC. The same bill is ALSO imported as a `[cost.focus]` file: the views count it once
// (the file import is set aside, with its reason), and `[cost] authoritative` can choose the file instead. With no
// `[cost.aws]` export the freshness shows the stated gap.
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
import { createAwsBillingCostSyncable } from "./aws-billing-cost-sync.ts";
import { AWS_COST_GAPS, type AwsBillingCli } from "./aws-billing-export.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 9);
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart,ProviderName,Tags";
const CSV = `${HEADER}
111,40,USD,2026-11-18T00:00:00Z,Amazon S3,2026-11-01T00:00:00Z,AWS,"{""product"":""checkout""}"
111,60,USD,2026-11-19T00:00:00Z,Amazon EC2,2026-11-01T00:00:00Z,AWS,"{""product"":""checkout""}"
`;

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-aws-billing-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const toml = (aws: string, cost = "") =>
  `${aws}\n[cost]\n${cost}\n[[cost.rule]]\nmatch = { tag = { product = "*" } }\nset = { product = "{tag.product}" }\n`;

const objects = new Map<string, Uint8Array>();
const fakeCli: AwsBillingCli = {
  list: async () => ({
    ok: true,
    text: JSON.stringify({
      Contents: [...objects.keys()].map((Key) => ({
        Key,
        LastModified: "2026-11-19T10:00:00+00:00",
      })),
    }),
  }),
  download: async (url) => {
    const b = objects.get(url.replace("s3://acme-cost/", ""));
    return b === undefined ? { ok: false } : { ok: true, bytes: b };
  },
};

async function syncAws(cursor: string | null) {
  const vault = createMockVault();
  await vault.set("aws.profile", "default");
  upsertSchedulerRegistration(db, "aws_billing", DAY, NOW, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "aws_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
  const out = await createAwsBillingCostSyncable({
    aws: () => loadNimbusCostFromConfigDir(dir).aws,
    now: () => NOW,
    cli: fakeCli,
  }).sync(ctx, cursor);
  updateSchedulerState(db, {
    serviceId: "aws_billing",
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

describe("acceptance: AWS cost from a FOCUS export in S3", () => {
  test("synced once, the file import of the same bill is set aside, and authoritative chooses", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml('[cost.aws]\nexport = "s3://acme-cost/focus"'));
    objects.clear();
    objects.set(
      "focus/daily/metadata/BILLING_PERIOD=2026-11/daily-Manifest.json",
      new TextEncoder().encode(
        JSON.stringify({
          dataFiles: ["s3://acme-cost/focus/daily/data/BILLING_PERIOD=2026-11/daily-00001.csv.gz"],
        }),
      ),
    );
    objects.set(
      "focus/daily/data/BILLING_PERIOD=2026-11/daily-00001.csv.gz",
      Bun.gzipSync(new TextEncoder().encode(CSV)),
    );
    const c1 = await syncAws(null);
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
        provider: "aws",
        reason:
          "cloud sync active for this provider on 2 days (set [cost] authoritative to choose)",
      },
    ]);

    writeFileSync(
      join(dir, "nimbus.toml"),
      toml('[cost.aws]\nexport = "s3://acme-cost/focus"', 'authoritative = { aws = "focus" }'),
    );
    const f = await products();
    expect(f.byCurrency["USD"]?.total).toBe(100);
    expect(f.excludedSources.map((e) => e.source)).toEqual(["aws_billing"]);

    // A re-sync changes nothing.
    await syncAws(c1);
    expect((await products()).byCurrency["USD"]?.total).toBe(100);
  });

  test("with no export, the freshness line states the gap", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml("[cost.aws]\ncost_explorer = false"));
    objects.clear();
    await syncAws(null);
    const aws = (await products()).freshness.find((f) => f.source === "aws_billing");
    expect(aws?.gap).toBe(AWS_COST_GAPS.notConfigured);
  });
});
