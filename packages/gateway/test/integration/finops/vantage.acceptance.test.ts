// Phase 10 FO2 acceptance (spec section 1), over real SQLite, the real SyncScheduler and a fake
// connector session. The reply rows are documentation-shaped fixtures: nothing here calls the real
// Vantage API and the "token" is a made-up string.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { runDataDelete } from "../../../src/commands/data-delete.ts";
import { clearConnectorVaultSecretKeys } from "../../../src/connectors/connector-secrets-manifest.ts";
import { __setFinopsSessionRunnerForTest } from "../../../src/connectors/finops-sync-transport.ts";
import { createVantageSyncable } from "../../../src/connectors/vantage-sync.ts";
import { SqliteEmbeddingPipeline } from "../../../src/embedding/pipeline.ts";
import { DAY_MS, seriesKeyOf, startOfUtcDay } from "../../../src/finops/cost-item-contract.ts";
import { pruneCostRows } from "../../../src/finops/cost-retention.ts";
import { readCostSeries } from "../../../src/finops/cost-series.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../../src/index/sqlite-vec-load.ts";
import { SyncScheduler } from "../../../src/sync/scheduler.ts";
import type { SyncRuntimeContext } from "../../../src/sync/types.ts";
import { createMemoryVault, createSyncTestContext } from "../../../src/testing/bun-test-support.ts";

const TOKEN = "vantage-acceptance-token-not-real";

afterEach(() => {
  __setFinopsSessionRunnerForTest(undefined);
});

function dayStr(offset: number): string {
  return new Date(startOfUtcDay(Date.now()) + offset * DAY_MS).toISOString().slice(0, 10);
}

function costRows(services: readonly string[], days: number, amount: number): unknown[] {
  const rows: unknown[] = [];
  for (const service of services) {
    for (let d = days; d >= 1; d -= 1) {
      rows.push({ accrued_at: dayStr(-d), amount: String(amount), currency: "USD", service });
    }
  }
  return rows;
}

const REC = {
  token: "rec_1",
  type: "aws:ec2:co-rightsizing",
  description: "Rightsize an EC2 instance in account 123456789012",
  potential_savings: "100.00",
  currency_code: "USD",
  created_at: "2026-11-01T00:00:00Z",
};

function fakeConnector(replies: () => { costs: unknown[]; recommendations: unknown[] }) {
  const seen: { toolId: string; args: Record<string, unknown> }[] = [];
  __setFinopsSessionRunnerForTest(async (_req, body) =>
    body({
      call: async (toolId, args) => {
        seen.push({ toolId, args: args as Record<string, unknown> });
        const r = replies();
        const items = toolId === "vantage_cost_list" ? r.costs : r.recommendations;
        return { content: [{ type: "text", text: JSON.stringify({ items, nextCursor: null }) }] };
      },
    }),
  );
  return seen;
}

async function harness(options: { maxSeries?: number; vaultExtra?: Record<string, string> } = {}) {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const index = new LocalIndex(db);
  const vault = createMemoryVault();
  await vault.set("vantage.api_token", TOKEN);
  for (const [k, v] of Object.entries(options.vaultExtra ?? {})) await vault.set(k, v);
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, {
    write: (line: string) => void logs.push(line),
  } as unknown as pino.DestinationStream);
  const syncCtx: SyncRuntimeContext = {
    ...createSyncTestContext(db, vault, "vantage"),
    logger,
    db,
    vault,
  };
  const egress: { destination: string; sourceType: string; method: string }[] = [];
  const scheduler = new SyncScheduler(syncCtx, undefined, {
    isOnline: async () => true,
    initialOnline: true,
    appendSyncEgress: (row) => void egress.push(row),
  });
  scheduler.register(
    createVantageSyncable(
      options.maxSeries === undefined ? {} : { maxSeries: () => options.maxSeries as number },
    ),
  );
  return { db, index, vault, scheduler, egress, logs };
}

const itemRows = (db: Database) =>
  db
    .query(
      "SELECT id, type, title, modified_at, metadata FROM item WHERE service = 'vantage' ORDER BY id",
    )
    .all();

describe("Vantage acceptance (spec section 1)", () => {
  test("1. a first sync indexes 45 days; the series reads gap-free with the last 3 days provisional", async () => {
    const seen = fakeConnector(() => ({
      costs: costRows(["EC2"], 45, 10),
      recommendations: [REC],
    }));
    const h = await harness({ vaultExtra: { "vantage.group_by": "service" } });
    try {
      await h.scheduler.forceSync("vantage");
      const cost = seen.find((s) => s.toolId === "vantage_cost_list");
      expect(Date.now() - (cost?.args["sinceMs"] as number)).toBeGreaterThan(44 * DAY_MS);
      const today = startOfUtcDay(Date.now());
      const series = readCostSeries(h.db, {
        seriesKey: seriesKeyOf("vantage", "default", "service", null, "EC2"),
        fromMs: today - 45 * DAY_MS,
        toMs: today,
      });
      expect(series.points).toHaveLength(45);
      expect(series.gaps).toEqual([]);
      expect(series.points.filter((p) => !p.finalized)).toHaveLength(3);
      expect(series.points.slice(-3).every((p) => !p.finalized)).toBe(true);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("2. a second sync over unchanged replies upserts the same ids and changes no row", async () => {
    fakeConnector(() => ({ costs: costRows(["EC2", "S3"], 12, 5), recommendations: [REC] }));
    const h = await harness({ vaultExtra: { "vantage.group_by": "service" } });
    try {
      await h.scheduler.forceSync("vantage");
      const before = itemRows(h.db);
      await h.scheduler.forceSync("vantage");
      expect(itemRows(h.db)).toEqual(before);
      expect(before).toHaveLength(2 * 12 + 1);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("3. six series with maxSeries 3: three named, the rest in __other__, and a later sync moves none", async () => {
    let replies = {
      costs: [
        ...costRows(["a"], 5, 100),
        ...costRows(["b"], 5, 90),
        ...costRows(["c"], 5, 80),
        ...costRows(["d"], 5, 4),
        ...costRows(["e"], 5, 3),
        ...costRows(["f"], 5, 2),
      ],
      recommendations: [] as unknown[],
    };
    fakeConnector(() => replies);
    const h = await harness({ maxSeries: 3, vaultExtra: { "vantage.group_by": "service" } });
    try {
      await h.scheduler.forceSync("vantage");
      const names = () =>
        (
          h.db
            .query(
              "SELECT DISTINCT json_extract(metadata,'$.dimensionValue') AS v FROM item WHERE type='cost_allocation'",
            )
            .all() as { v: string }[]
        )
          .map((r) => r.v)
          .sort();
      expect(names()).toEqual(["__other__", "a", "b", "c"]);
      const other = h.db
        .query(
          "SELECT json_extract(metadata,'$.rowCount') AS n FROM item WHERE json_extract(metadata,'$.dimensionValue') = '__other__' LIMIT 1",
        )
        .get() as { n: number };
      expect(other.n).toBe(3);
      // "a" shrinks, "g" is new and huge: the named set does not move.
      replies = {
        costs: [...costRows(["a"], 1, 0.01), ...costRows(["g"], 1, 9999)],
        recommendations: [],
      };
      await h.scheduler.forceSync("vantage");
      expect(names()).toEqual(["__other__", "a", "b", "c"]);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("4. retention with retainDays 30 deletes only older cost_allocation rows and leaves recommendations", async () => {
    fakeConnector(() => ({ costs: costRows(["EC2"], 45, 10), recommendations: [REC] }));
    const h = await harness({ vaultExtra: { "vantage.group_by": "service" } });
    try {
      await h.scheduler.forceSync("vantage");
      const deleted = pruneCostRows(h.db, { retainDays: 30, nowMs: Date.now() });
      expect(deleted).toBeGreaterThan(10);
      expect(deleted).toBeLessThan(18);
      const left = h.db
        .query(
          "SELECT type, COUNT(*) AS n FROM item WHERE service='vantage' GROUP BY type ORDER BY type",
        )
        .all() as { type: string; n: number }[];
      expect(left.find((r) => r.type === "cost_recommendation")?.n).toBe(1);
      const oldest = h.db
        .query(
          "SELECT MIN(json_extract(metadata,'$.periodEndMs')) AS m FROM item WHERE type='cost_allocation'",
        )
        .get() as { m: number };
      expect(oldest.m).toBeGreaterThanOrEqual(Date.now() - 30 * DAY_MS);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("5. a backfill over the populated database embeds nothing from cost_allocation and terminates", async () => {
    fakeConnector(() => ({ costs: costRows(["EC2"], 10, 10), recommendations: [REC] }));
    const h = await harness({ vaultExtra: { "vantage.group_by": "service" } });
    try {
      await h.scheduler.forceSync("vantage");
      const vecDb = new Database(":memory:");
      tryLoadSqliteVec(vecDb);
      const vecOk = isVecLoaded(vecDb);
      vecDb.close();
      if (!vecOk) return; // sqlite-vec is not loadable on this machine: nothing to embed into
      tryLoadSqliteVec(h.db);
      let embeddedTexts = 0;
      const pipeline = new SqliteEmbeddingPipeline({
        db: h.db,
        embedder: {
          model: "acceptance-local",
          dims: 384,
          isLocal: true,
          async embed(texts: string[]) {
            embeddedTexts += texts.length;
            return texts.map(() => new Float32Array(384).fill(0.01));
          },
        },
        backfillBatchSize: 3,
      });
      await Promise.race([
        pipeline.backfillAll(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("backfill did not terminate")), 5000),
        ),
      ]);
      const costChunks = h.db
        .query(
          "SELECT COUNT(*) AS n FROM embedding_chunk c JOIN item i ON i.id = c.item_id WHERE i.type = 'cost_allocation'",
        )
        .get() as { n: number };
      expect(costChunks.n).toBe(0);
      // Only the recommendation was a candidate.
      expect(embeddedTexts).toBe(1);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("6. the ledger gains only the scheduler's sync rows; the reader and retention add none; the token never leaks", async () => {
    fakeConnector(() => ({ costs: costRows(["EC2"], 8, 10), recommendations: [REC] }));
    const h = await harness({ vaultExtra: { "vantage.group_by": "service" } });
    try {
      const ledgerCount = () =>
        (h.db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
      const before = ledgerCount();
      await h.scheduler.forceSync("vantage");
      await h.scheduler.forceSync("vantage");
      expect(h.egress).toHaveLength(2);
      expect(h.egress.every((r) => r.sourceType === "sync" && r.destination === "vantage")).toBe(
        true,
      );
      const afterSync = ledgerCount();
      const today = startOfUtcDay(Date.now());
      readCostSeries(h.db, {
        seriesKey: seriesKeyOf("vantage", "default", "service", null, "EC2"),
        fromMs: today - 8 * DAY_MS,
        toMs: today,
      });
      pruneCostRows(h.db, { retainDays: 30, nowMs: Date.now() });
      expect(ledgerCount()).toBe(afterSync);
      expect(afterSync).toBe(before); // the test scheduler's closure is the only sink here
      // The token is in no log line, no item row and no ledger row.
      const everything = JSON.stringify([
        h.logs,
        itemRows(h.db),
        h.db.query("SELECT * FROM egress_ledger").all(),
        h.egress,
      ]);
      expect(everything).not.toContain(TOKEN);
    } finally {
      await h.scheduler.stop();
    }
  });

  test("7. connector remove clears the four keys; data delete empties the index, and the next sync reads 45 days again even though the scheduler cursor survives", async () => {
    const seen = fakeConnector(() => ({ costs: costRows(["EC2"], 6, 10), recommendations: [] }));
    const h = await harness({
      vaultExtra: {
        "vantage.group_by": "service",
        "vantage.cost_report_token": "rprt_x",
        "vantage.workspace_token": "wrkspc_x",
      },
    });
    try {
      await h.scheduler.forceSync("vantage");
      await h.scheduler.forceSync("vantage");
      const second = seen.filter((s) => s.toolId === "vantage_cost_list")[1];
      expect(Date.now() - (second?.args["sinceMs"] as number)).toBeLessThan(5 * DAY_MS);
      expect(await h.vault.listKeys("vantage.")).toHaveLength(4 + 0);

      await runDataDelete({ service: "vantage", dryRun: false, vault: h.vault, index: h.index });
      expect(itemRows(h.db)).toEqual([]);
      expect(
        (
          h.db
            .query("SELECT COUNT(*) AS n FROM sync_state WHERE connector_id = 'vantage'")
            .get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      await clearConnectorVaultSecretKeys(h.vault, "vantage");
      expect(await h.vault.listKeys("vantage.")).toEqual([]);

      // Re-authenticate: with the cursor gone the next sync reads the first window again.
      await h.vault.set("vantage.api_token", TOKEN);
      seen.length = 0;
      await h.scheduler.forceSync("vantage");
      const first = seen.find((s) => s.toolId === "vantage_cost_list");
      expect(Date.now() - (first?.args["sinceMs"] as number)).toBeGreaterThan(44 * DAY_MS);
    } finally {
      await h.scheduler.stop();
    }
  });
});
