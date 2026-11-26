import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { seedDemoCorpus } from "./seed.ts";
import { DEMO_COST_DAYS, demoFocusCsv, seedDemoCost } from "./seed-cost.ts";

const NOW = Date.UTC(2026, 10, 26, 9);
let roots: string[] = [];
let dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  roots = [];
  dbs = [];
});

function fresh(): { db: Database; configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-cost-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return { db, configDir, dataDir };
}

type Block = {
  total: number;
  rows: { key: string; secondary: string | null; part: string; amount: number }[];
  unassigned: number;
};
type View = { empty: boolean; byCurrency: Record<string, Block>; configError: string | null };

async function view(method: string, db: Database, configDir: string): Promise<View> {
  const out = await dispatchCostRpc(
    method,
    { period: "30d" },
    { db, configDir, now: () => NOW, caller: { kind: "cli" } },
  );
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as View;
}

describe("demo cost (Phase 7)", () => {
  test("the demo export is 30 days, USD only, with the spike on the last two days", () => {
    const rows = demoFocusCsv(NOW).trimEnd().split("\n").slice(1);
    expect(rows).toHaveLength(DEMO_COST_DAYS * 8);
    expect(rows.every((r) => r.includes(",USD,"))).toBe(true);
    expect(rows.filter((r) => r.startsWith("380.00,"))).toHaveLength(2);
  });

  test("a seeded demo lists the three products, the internal envs and the unassigned share", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: NOW });
    const p = await view("cost.products", db, configDir);
    expect(p.configError).toBeNull();
    expect(p.empty).toBe(false);
    expect(Object.keys(p.byCurrency)).toEqual(["USD"]);
    const usd = p.byCurrency["USD"] as Block;
    expect([...new Set(usd.rows.map((r) => r.key))]).toEqual([
      "checkout",
      "internal-tools",
      "search",
    ]);
    expect(
      usd.rows.find((r) => r.part === "payment-service" && r.secondary === "prod")?.amount,
    ).toBe(120 * 28 + 380 * 2 + 60 * 30);
    expect(usd.unassigned).toBe(3 * 30);
    const i = await view("cost.internal", db, configDir);
    expect([...new Set((i.byCurrency["USD"] as Block).rows.map((r) => r.key))]).toEqual([
      "ci",
      "dev",
    ]);
  });

  test("an empty real install says no cost data imported (Review Focus 5)", async () => {
    const { db, configDir } = fresh();
    const p = await view("cost.products", db, configDir);
    expect(p.empty).toBe(true);
    expect(p.byCurrency).toEqual({});
  });
  test("seedDemoCost writes the export under <demoRoot>/cost and imports it", () => {
    const { db, dataDir } = fresh();
    const r = seedDemoCost(db, dataDir, NOW);
    expect(r.files.map((f) => [f.name, f.status])).toEqual([["acme-focus.csv", "imported"]]);
    expect(r.files[0]?.path).toBe(join(dataDir, "cost", "acme-focus.csv"));
    expect(r.files[0]?.lines).toBe(DEMO_COST_DAYS * 8);
    // A second seed of the same export is an accepted replay, not a refusal.
    expect(seedDemoCost(db, dataDir, NOW).files[0]?.status).toBe("unchanged");
  });

  test("a refused demo export throws with the refusal rather than seeding a partial demo", () => {
    const { dataDir } = fresh();
    const bare = new Database(":memory:");
    dbs.push(bare);
    expect(() => seedDemoCost(bare, dataDir, NOW)).toThrow(
      /demo seed: the demo cost export was refused: .*no such table/,
    );
  });
});
