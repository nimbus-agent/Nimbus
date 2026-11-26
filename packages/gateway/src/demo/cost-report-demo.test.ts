// Phase 7 slice 3 acceptance: the demo's `checkout-weekly` report renders for Slack and an Outlook draft from
// the seeded cost lines, with no network call, no egress row and nothing the send door would refuse.
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

type Rendered = {
  model: {
    range: { fromDay: string; toDay: string };
    byCurrency: Record<string, { total: number; topMovers: { part: string }[] }>;
  };
  channels: {
    kind: string;
    subject: string | null;
    body: string | null;
    error: string | null;
    doorRefusal: string | null;
  }[];
};

describe("demo: nimbus cost report checkout-weekly", () => {
  test("renders the Slack and Outlook channels for the previous full week, with no network", async () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-demo-cost-report-"));
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
      throw new Error("a cost report render must not reach the network");
    }) as unknown as typeof fetch;

    const list = await dispatchCostRpc(
      "cost.reportList",
      {},
      {
        db,
        configDir,
        now: () => nowMs,
        caller: { kind: "cli" },
        chatops: () => ({ channels: new Map(), ownership: new Map() }),
      },
    );
    if (list.kind !== "hit") throw new Error("cost.reportList was not routed");
    expect((list.value as { reports: { name: string }[] }).reports.map((r) => r.name)).toEqual([
      "checkout-weekly",
    ]);

    const out = await dispatchCostRpc(
      "cost.reportRender",
      { name: "checkout-weekly" },
      {
        db,
        configDir,
        now: () => nowMs,
        caller: { kind: "cli" },
        chatops: () => ({ channels: new Map(), ownership: new Map() }),
      },
    );
    if (out.kind !== "hit") throw new Error("cost.reportRender was not routed");
    const r = out.value as Rendered;

    const usd = r.model.byCurrency["USD"];
    expect(usd?.total).toBeGreaterThan(0);
    expect(r.channels.map((c) => [c.kind, c.error, c.doorRefusal])).toEqual([
      ["slack", null, null],
      ["outlook", null, null],
    ]);
    const [slack, outlook] = r.channels;
    expect(slack?.body).toContain(`${(usd?.total ?? 0).toFixed(2)} USD`);
    expect(slack?.body).toContain(r.model.range.fromDay);
    expect(outlook?.subject).toBe(`Checkout cost, week of ${r.model.range.fromDay}`);
    expect(outlook?.body).toStartWith("<p>");
    expect(outlook?.body).not.toContain("<script");

    const egress = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };
    expect(egress.n).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
