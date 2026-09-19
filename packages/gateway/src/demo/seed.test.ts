import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DAY } from "./corpus/types.ts";
import { DEMO_SEED_MARKER, DemoSeedRefusedError, seedDemoCorpus } from "./seed.ts";

let dbs: Database[] = [];
let roots: string[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

function fresh(): { db: Database; configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-seed-"));
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

function count(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...(params as [])) as { n: number } | null;
  return row?.n ?? 0;
}

describe("seedDemoCorpus", () => {
  test("seeds people, items, blame, deployments, and writes the demo nimbus.toml + marker", async () => {
    const { db, configDir, dataDir } = fresh();
    const nowMs = 5 * DAY * 365;
    const r = await seedDemoCorpus(db, { configDir, dataDir, nowMs });
    expect(r.counts.people).toBe(8);
    expect(count(db, "SELECT COUNT(*) AS n FROM item")).toBeGreaterThan(80);
    expect(count(db, "SELECT COUNT(*) AS n FROM git_blame_line")).toBeGreaterThan(40);
    expect(count(db, "SELECT COUNT(*) AS n FROM deployment_items")).toBe(r.counts.deployments);
    expect(r.tour).toEqual({ whyRef: "src/retry/backoff.ts:42", ownersPath: "src/retry" });

    // The files `why` needs on disk exist under the configured root, read back through the real loader.
    const [root] = loadNimbusFilesystemRootsFromConfigDir(configDir);
    expect(root?.path).toBe(r.workspaceRoot);
    expect(existsSync(join(r.workspaceRoot, "src", "retry", "backoff.ts"))).toBe(true);

    // The demo config parses through the REAL loaders (unknown keys would throw).
    const services = loadNimbusServiceConfigsFromConfigDir(configDir);
    expect([...services.keys()].sort()).toEqual([
      "checkout-web",
      "ledger-worker",
      "payment-service",
    ]);
    const toml = readFileSync(join(configDir, "nimbus.toml"), "utf8");
    expect(toml).toContain("me_person_id");
    expect(toml).toMatch(/\[embedding\][\s\S]*enabled = false/);

    const marker = JSON.parse(readFileSync(join(dataDir, DEMO_SEED_MARKER), "utf8")) as unknown;
    expect(marker).toEqual({ corpus: "acme", version: 1, seededAtMs: nowMs });
  });

  test("the paging incident is linked to the demo persona through the graph", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    const assigned = count(
      db,
      `SELECT COUNT(*) AS n FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id
         JOIN graph_entity ie ON ie.id = r.to_id
        WHERE r.type = 'assigned' AND pe.type = 'person' AND ie.external_id LIKE '%PDEMO412%'`,
    );
    expect(assigned).toBe(1);
  });

  test("refuses a non-empty index — it never truncates", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    await expect(
      seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 }),
    ).rejects.toBeInstanceOf(DemoSeedRefusedError);
  });

  test("windows rebase: a seed seven days later has the page inside oncall's 24h window of THAT now", async () => {
    for (const nowMs of [5 * DAY * 365, 5 * DAY * 365 + 7 * DAY]) {
      const { db, configDir, dataDir } = fresh();
      await seedDemoCorpus(db, { configDir, dataDir, nowMs });
      const recent = count(
        db,
        "SELECT COUNT(*) AS n FROM item WHERE service = 'pagerduty' AND modified_at >= ? AND modified_at <= ?",
        [nowMs - DAY, nowMs],
      );
      expect(recent).toBe(1);
    }
  });
});
