// Phase 7 acceptance 1 (slice 2): on the demo, `nimbus cost why checkout` names the seeded spike, the story
// deploy (run 7412, PR acme/payments#412) and the owning service, from the local index alone.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { seedDemoCorpus } from "./seed.ts";

let roots: string[] = [];
let dbs: Database[] = [];
let realFetch: typeof fetch | undefined;
afterEach(() => {
  if (realFetch !== undefined) globalThis.fetch = realFetch;
  realFetch = undefined;
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  roots = [];
  dbs = [];
});

type Why = {
  empty: boolean;
  target: { kind: string; name: string };
  byCurrency: Record<string, { spikeDay: string | null; change: number }>;
  services: string[];
  context: {
    serviceId: string;
    deploys: {
      sha: string;
      url: string | null;
      nearSpike: boolean;
      pr: { repo: string | null; number: number | null } | null;
    }[];
    owners: { label: string }[];
    gaps: string[];
  }[];
};

describe("demo: nimbus cost why checkout (acceptance 1)", () => {
  test("names the spike day, payment-service, its story deploy and PR, with no network", async () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-demo-cost-why-"));
    roots.push(root);
    const configDir = join(root, "config");
    const dataDir = join(root, "data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    dbs.push(db);
    const nowMs = Date.now();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs });

    let fetchCalls = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("cost.why must not reach the network");
    }) as unknown as typeof fetch;

    const out = await dispatchCostRpc(
      "cost.why",
      { target: "checkout" },
      { db, configDir, now: () => nowMs, caller: { kind: "cli" } },
    );
    if (out.kind !== "hit") throw new Error("cost.why was not routed");
    const w = out.value as Why;

    const today = new Date(nowMs).toISOString().slice(0, 10);
    const yesterday = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
    expect(w.empty).toBe(false);
    expect(w.target).toEqual({ kind: "product", name: "checkout" });
    expect([today, yesterday]).toContain(w.byCurrency["USD"]?.spikeDay ?? "none");
    expect(w.byCurrency["USD"]?.change).toBeGreaterThan(0);
    expect(w.services[0]).toBe("payment-service");
    const pay = w.context[0];
    expect(pay?.serviceId).toBe("payment-service");
    const story = pay?.deploys.find((d) => d.pr?.repo === "acme/payments" && d.pr.number === 412);
    expect(story).toBeDefined();
    expect(story?.nearSpike).toBe(true);
    expect(story?.runId).toBe("7412");
    // Spec acceptance 1 names the owning SERVICE. The demo's ownership pass runs without git, so no repo is bound to
    // a service and the brief says so rather than guessing owners.
    expect(pay?.owners).toEqual([]);
    expect(pay?.gaps.some((g) => g.includes("no ownership entry"))).toBe(true);

    const egress = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };
    expect(egress.n).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
