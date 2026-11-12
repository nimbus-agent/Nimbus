// Real SQLite, a fake connector session. The rows the fake session returns have the shape of the
// documented Vantage example row (documentation-shaped, never a live recording, never a real token).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DAY_MS, startOfUtcDay } from "../finops/cost-item-contract.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { __setFinopsSessionRunnerForTest, lastOkMsFromCursor } from "./finops-sync-transport.ts";
import { createVantageSyncable } from "./vantage-sync.ts";

const TOKEN = "vantage-secret-token-do-not-leak";

afterEach(() => {
  __setFinopsSessionRunnerForTest(undefined);
});

interface Seen {
  toolId: string;
  args: Record<string, unknown>;
}

function day(offsetFromToday: number): string {
  return new Date(startOfUtcDay(Date.now()) + offsetFromToday * DAY_MS).toISOString().slice(0, 10);
}

function costRows(services: readonly string[], days: number, amount = 10): unknown[] {
  const rows: unknown[] = [];
  for (const service of services) {
    for (let d = days; d >= 1; d -= 1) {
      rows.push({
        accrued_at: day(-d),
        amount: String(amount),
        currency: "USD",
        service,
      });
    }
  }
  return rows;
}

const REC = {
  token: "rec_example_1",
  type: "aws:ec2:co-rightsizing",
  category: "ec2_compute_optimizer_recommender",
  provider: "aws",
  provider_account_id: "123456789012",
  service: "Amazon EC2",
  description: "Rightsize an over-provisioned EC2 instance",
  documentation_url: null,
  potential_savings: "100.00",
  resources_affected_count: 3,
  currency_code: "USD",
  created_at: "2026-11-01T00:00:00Z",
};

function fakeSession(
  replies: { costs: unknown[]; recommendations: unknown[] },
  seen: Seen[] = [],
  failOn?: string,
) {
  __setFinopsSessionRunnerForTest(async (_req, body) =>
    body({
      call: async (toolId, args) => {
        seen.push({ toolId, args: args as Record<string, unknown> });
        if (toolId === failOn) throw new Error("Vantage 429: rate limited");
        const items = toolId === "vantage_cost_list" ? replies.costs : replies.recommendations;
        return { content: [{ type: "text", text: JSON.stringify({ items, nextCursor: null }) }] };
      },
    }),
  );
  return seen;
}

function setup(vaultEntries: Record<string, string> = {}): { db: Database; ctx: SyncContext } {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(
    db,
    createStubVault({ "vantage.api_token": TOKEN, ...vaultEntries }),
    "vantage",
  );
  return { db, ctx };
}

const rowsOf = (db: Database) =>
  db
    .query(
      "SELECT id, type, title, modified_at, metadata FROM item WHERE service = 'vantage' ORDER BY id",
    )
    .all();

describe("createVantageSyncable", () => {
  test("a first sync with no cursor asks for 45 days, writes rows and returns a lastOkMs cursor", async () => {
    const seen = fakeSession({ costs: costRows(["EC2", "S3"], 45), recommendations: [REC] });
    const { db, ctx } = setup({ "vantage.group_by": "service" });
    const before = Date.now();
    const r = await createVantageSyncable().sync(ctx, null);
    const cost = seen.find((s) => s.toolId === "vantage_cost_list");
    expect(Math.abs((cost?.args["sinceMs"] as number) - (before - 45 * DAY_MS))).toBeLessThan(5000);
    expect(r.itemsUpserted).toBe(2 * 45 + 1);
    expect(r.hasMore).toBe(false);
    expect(lastOkMsFromCursor(r.cursor, "nimbus-vantage1:")).toBeGreaterThanOrEqual(before);
    const types = db
      .query("SELECT type, COUNT(*) AS n FROM item WHERE service='vantage' GROUP BY type")
      .all();
    expect(types).toEqual([
      { type: "cost_allocation", n: 90 },
      { type: "cost_recommendation", n: 1 },
    ]);
  });

  test("a second sync asks for the start of the last success day minus 3 days", async () => {
    const seen = fakeSession({ costs: costRows(["EC2"], 5), recommendations: [] });
    const { ctx } = setup();
    const first = await createVantageSyncable().sync(ctx, null);
    seen.length = 0;
    await createVantageSyncable().sync(ctx, first.cursor);
    const lastOk = lastOkMsFromCursor(first.cursor, "nimbus-vantage1:") ?? 0;
    const cost = seen.find((s) => s.toolId === "vantage_cost_list");
    expect(cost?.args["sinceMs"]).toBe(startOfUtcDay(lastOk) - 3 * DAY_MS);
  });

  test("the cost drain sends sinceMs, untilMs and limit 5000; the recommendation drain only limit 1000 and a cursor", async () => {
    const seen = fakeSession({ costs: [], recommendations: [] });
    const { ctx } = setup();
    await createVantageSyncable().sync(ctx, null);
    const cost = seen.find((s) => s.toolId === "vantage_cost_list");
    const rec = seen.find((s) => s.toolId === "vantage_recommendation_list");
    expect(Object.keys(cost?.args ?? {}).sort()).toEqual(["cursor", "limit", "sinceMs", "untilMs"]);
    expect(cost?.args["limit"]).toBe(5000);
    expect(rec?.args).toEqual({ limit: 1000, cursor: null });
  });

  test("re-running over unchanged replies changes no row", async () => {
    const replies = { costs: costRows(["EC2", "S3"], 10), recommendations: [REC] };
    fakeSession(replies);
    const { db, ctx } = setup();
    await createVantageSyncable().sync(ctx, null);
    const before = rowsOf(db);
    await createVantageSyncable().sync(ctx, null);
    expect(rowsOf(db)).toEqual(before);
    expect(before.length).toBe(21);
  });

  test("a day inside the restate window is provisional and an old day is final", async () => {
    fakeSession({ costs: costRows(["EC2"], 10), recommendations: [] });
    const { db, ctx } = setup();
    await createVantageSyncable().sync(ctx, null);
    const flags = db
      .query(
        "SELECT json_extract(metadata,'$.periodStartMs') AS d, json_extract(metadata,'$.finalized') AS f FROM item WHERE type='cost_allocation' ORDER BY d",
      )
      .all() as { d: number; f: number }[];
    expect(flags[0]?.f).toBe(1);
    expect(flags.at(-1)?.f).toBe(0);
  });

  test("a drain that throws indexes nothing and the sync rejects, so the cursor stays", async () => {
    fakeSession(
      { costs: costRows(["EC2"], 5), recommendations: [REC] },
      [],
      "vantage_recommendation_list",
    );
    const { db, ctx } = setup();
    await expect(createVantageSyncable().sync(ctx, null)).rejects.toThrow("rate limited");
    expect(rowsOf(db)).toEqual([]);
  });

  test("the named set: maxSeries 2 over 4 series names 2 and folds 2 into __other__", async () => {
    const rows = [
      ...costRows(["big1"], 3, 100),
      ...costRows(["big2"], 3, 90),
      ...costRows(["small1"], 3, 2),
      ...costRows(["small2"], 3, 1),
    ];
    fakeSession({ costs: rows, recommendations: [] });
    const { db, ctx } = setup({ "vantage.group_by": "service" });
    await createVantageSyncable({ maxSeries: () => 2 }).sync(ctx, null);
    const series = db
      .query(
        "SELECT json_extract(metadata,'$.dimensionValue') AS v, SUM(json_extract(metadata,'$.rowCount')) AS rc FROM item WHERE type='cost_allocation' GROUP BY v ORDER BY v",
      )
      .all();
    expect(series).toEqual([
      { v: "__other__", rc: 6 },
      { v: "big1", rc: 3 },
      { v: "big2", rc: 3 },
    ]);
  });

  test("a later sync does not move a named series even when it is now the smaller one", async () => {
    const first = { costs: costRows(["a", "b"], 3, 50), recommendations: [] };
    fakeSession(first);
    const { db, ctx } = setup({ "vantage.group_by": "service" });
    const r = await createVantageSyncable({ maxSeries: () => 2 }).sync(ctx, null);
    // "a" is tiny today, "c" is new and big: "c" must NOT take a slot (the set is full).
    fakeSession({
      costs: [...costRows(["a"], 1, 0.01), ...costRows(["c"], 1, 999)],
      recommendations: [],
    });
    await createVantageSyncable({ maxSeries: () => 2 }).sync(ctx, r.cursor);
    const names = (
      db
        .query(
          "SELECT DISTINCT json_extract(metadata,'$.dimensionValue') AS v FROM item WHERE type='cost_allocation'",
        )
        .all() as { v: string }[]
    )
      .map((x) => x.v)
      .sort();
    expect(names).toEqual(["__other__", "a", "b"]);
  });

  test("recommendation rows are indexed with their metadata", async () => {
    fakeSession({ costs: [], recommendations: [REC] });
    const { db, ctx } = setup();
    await createVantageSyncable().sync(ctx, null);
    const row = db
      .query("SELECT external_id, metadata FROM item WHERE type='cost_recommendation'")
      .get() as { external_id: string; metadata: string };
    expect(row.external_id).toBe("rec_example_1");
    expect(JSON.parse(row.metadata).estimatedMonthlySavings).toBe(100);
  });

  test("ctx.upsertItem is the only write path", async () => {
    fakeSession({ costs: costRows(["EC2"], 4), recommendations: [REC] });
    const { db, ctx } = setup();
    let writes = 0;
    const spying: SyncContext = {
      ...ctx,
      upsertItem: (row) => {
        writes += 1;
        ctx.upsertItem(row);
      },
    };
    const r = await createVantageSyncable().sync(spying, null);
    expect(writes).toBe(r.itemsUpserted);
    expect(rowsOf(db)).toHaveLength(writes);
  });

  test("a tag: grouping is refused with a fixed message before any session, and no secret is in it", async () => {
    let opened = 0;
    __setFinopsSessionRunnerForTest(async (_req, body) => {
      opened += 1;
      return body({ call: async () => ({ content: [] }) });
    });
    const { ctx } = setup({ "vantage.group_by": "provider, tag:team" });
    let message = "";
    try {
      await createVantageSyncable().sync(ctx, null);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("tag: grouping is not supported");
    expect(message).not.toContain(TOKEN);
    expect(opened).toBe(0);
  });

  test("the cost report token becomes the scope of every series", async () => {
    fakeSession({ costs: costRows(["EC2"], 2), recommendations: [] });
    const { db, ctx } = setup({ "vantage.cost_report_token": "rprt_abc123" });
    await createVantageSyncable().sync(ctx, null);
    const ids = db.query("SELECT external_id FROM item WHERE type='cost_allocation'").all() as {
      external_id: string;
    }[];
    expect(ids.every((r) => r.external_id.startsWith("rprt_abc123:"))).toBe(true);
  });

  test("dropped cost rows are counted in a warning that carries no row content", async () => {
    fakeSession({
      costs: [...costRows(["EC2"], 2), { accrued_at: "garbage", amount: "SECRET-AMOUNT" }, 7],
      recommendations: [],
    });
    const { ctx } = setup();
    const warnings: unknown[] = [];
    const logging: SyncContext = {
      ...ctx,
      logger: {
        warn: (...args: unknown[]) => warnings.push(args),
      } as unknown as SyncContext["logger"],
    };
    await createVantageSyncable().sync(logging, null);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain('"dropped":2');
    expect(JSON.stringify(warnings)).not.toContain("SECRET-AMOUNT");
  });
});
