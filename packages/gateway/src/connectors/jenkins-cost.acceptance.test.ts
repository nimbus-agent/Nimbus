// Phase 7 slice 10 acceptance: a fake Jenkins (documentation-shaped remote API, no network). Two jobs with 100 and 40
// build minutes and no rate, so `cost.products` shows 140 unpriced minutes under the source and no money; then
// `[cost.jenkins] rate_per_minute = 0.01` with an agent rate prices the stored month with no new fetch of its own; a
// re-sync changes nothing; an http base shows its gap. The real config parse, syncable, capabilities, store and cost
// RPC run; one clock serves syncs and views.
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
import { createJenkinsCostSyncable } from "./jenkins-cost-sync.ts";

const DAY = 86_400_000;
const DAY1 = Date.UTC(2026, 10, 19, 9);
const DAY2 = DAY1 + DAY;
const BUILD_AT = Date.UTC(2026, 10, 18, 9);

let db: Database;
let dir: string;
const toml = (body: string) =>
  `[cost.jenkins]\n${body}\n\n[[cost.rule]]\nmatch = { provider = "jenkins" }\nset = { product = "platform" }\n`;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-jenkins-billing-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const JOBS = [
  { name: "web", minutes: 100, builtOn: "linux-1" },
  { name: "api", minutes: 40, builtOn: "" },
];

function jenkinsFake() {
  return (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/api/json") {
      return new Response(JSON.stringify({ jobs: JOBS.map((j) => ({ name: j.name })) }), {
        status: 200,
      });
    }
    const name = url.pathname.replace("/job/", "").replace("/api/json", "");
    const job = JOBS.find((j) => j.name === name);
    const builds = [
      {
        number: 1,
        timestamp: BUILD_AT,
        duration: (job?.minutes ?? 0) * 60_000,
        builtOn: job?.builtOn ?? "",
        result: "SUCCESS",
        building: false,
      },
    ];
    return new Response(JSON.stringify({ builds }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function syncAt(now: number, cursor: string | null, base = "https://ci.acme.test") {
  const vault = createMockVault();
  await vault.set("jenkins.base_url", base);
  await vault.set("jenkins.username", "robot");
  await vault.set("jenkins.api_token", "tok");
  upsertSchedulerRegistration(db, "jenkins_billing", DAY, now, false);
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "jenkins_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      jenkins: { requestsPerMinute: 600_000, burstSize: 100 },
    }),
    depth: "full",
  } as SyncContext;
  const out = await createJenkinsCostSyncable({
    jenkins: () => loadNimbusCostFromConfigDir(dir).jenkins,
    now: () => now,
    fetch: (u, i) => jenkinsFake()(u, i) as ReturnType<typeof fetch>,
  }).sync(ctx, cursor);
  // The scheduler stores the cursor; the cost views read the gaps from there.
  updateSchedulerState(db, {
    serviceId: "jenkins_billing",
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
  byCurrency: Record<string, { total: number; rows: { key: string; amount: number }[] }>;
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

describe("acceptance: Jenkins build minutes as cost lines", () => {
  test("unpriced minutes, then a rate and an agent rate price the month; a re-sync changes nothing", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml(""));
    const c1 = await syncAt(DAY1, null);
    const v1 = await products(DAY1);
    const j1 = v1.freshness.find((f) => f.source === "jenkins_billing");
    expect(j1?.unpriced).toEqual([{ unit: "minute", quantity: 140, lines: 2 }]);
    expect(j1?.gap).toBeUndefined();
    expect(v1.byCurrency["USD"]?.total ?? 0).toBe(0);

    writeFileSync(
      join(dir, "nimbus.toml"),
      toml('rate_per_minute = 0.01\nagent_rates = { "linux-1" = 0.02 }'),
    );
    const c2 = await syncAt(DAY2, c1);
    const v2 = await products(DAY2);
    const platform = v2.byCurrency["USD"]?.rows.filter((r) => r.key === "platform") ?? [];
    // 100 min on linux-1 at 0.02, 40 min on the built-in node at the default 0.01.
    expect(platform.reduce((a, r) => a + r.amount, 0)).toBeCloseTo(2.4, 9);
    expect(v2.freshness.find((f) => f.source === "jenkins_billing")?.unpriced).toBeUndefined();

    await syncAt(DAY2, c2);
    expect((await products(DAY2)).byCurrency["USD"]?.rows).toEqual(v2.byCurrency["USD"]?.rows);
  });

  test("a plain http base is named as a gap and nothing is stored", async () => {
    writeFileSync(join(dir, "nimbus.toml"), toml(""));
    await syncAt(DAY1, null, "http://ci.acme.test");
    const v = await products(DAY1);
    expect(v.freshness.find((f) => f.source === "jenkins_billing")?.gap).toContain("plain http");
    expect(db.query("SELECT COUNT(*) AS n FROM cost_line").get()).toEqual({ n: 0 });
  });
});
