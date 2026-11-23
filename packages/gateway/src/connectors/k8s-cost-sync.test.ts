// Real SQLite, a fake connector session. The rows the fake session returns have the shape the
// `opencost` / `kubecost` connectors' `<service>_allocation_list` tool documents (documentation-shaped,
// never a live recording).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DAY_MS, startOfUtcDay, utcDateString } from "../finops/cost-item-contract.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { __setFinopsSessionRunnerForTest, lastOkMsFromCursor } from "./finops-sync-transport.ts";
import { createK8sCostSyncable } from "./k8s-cost-sync.ts";

afterEach(() => {
  __setFinopsSessionRunnerForTest(undefined);
});

interface Seen {
  toolId: string;
  args: Record<string, unknown>;
}

function dayString(offsetFromToday: number): string {
  return utcDateString(startOfUtcDay(Date.now()) + offsetFromToday * DAY_MS);
}

function rows(keys: readonly string[], days: number, totalCost = 10): unknown[] {
  const out: unknown[] = [];
  for (const key of keys) {
    for (let d = days; d >= 1; d -= 1) {
      out.push({
        date: dayString(-d),
        key,
        name: key,
        start: `${dayString(-d)}T00:00:00Z`,
        end: `${dayString(-d + 1)}T00:00:00Z`,
        minutes: 1440,
        properties: { namespace: key },
        cpuCost: 1,
        ramCost: 1,
        gpuCost: 0,
        pvCost: 0,
        networkCost: 0,
        loadBalancerCost: 0,
        sharedCost: 0,
        externalCost: 0,
        totalCost,
      });
    }
  }
  return out;
}

/** A session that answers the allocation tool with `pages` in order, recording each call. */
function fakeSession(pages: unknown[][], seen: Seen[] = []) {
  __setFinopsSessionRunnerForTest(async (_req, body) =>
    body({
      call: async (toolId, args) => {
        const a = args as Record<string, unknown>;
        seen.push({ toolId, args: a });
        const index = a["cursor"] === null ? 0 : Number(a["cursor"]);
        const items = pages[index] ?? [];
        const next = index + 1 < pages.length ? String(index + 1) : null;
        return {
          content: [
            { type: "text", text: JSON.stringify({ items, nextCursor: next, skipped: 0 }) },
          ],
        };
      },
    }),
  );
  return seen;
}

function setup(
  service: "opencost" | "kubecost",
  entries: Record<string, string> = {},
): { db: Database; ctx: SyncContext } {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ [`${service}.url`]: "http://x.svc:9003", ...entries });
  return { db, ctx: syncTestContext(db, vault, service) };
}

const rowsOf = (db: Database, service: string) =>
  db
    .query("SELECT id, type, title, modified_at, metadata FROM item WHERE service = ? ORDER BY id")
    .all(service);

for (const service of ["opencost", "kubecost"] as const) {
  const tool = `${service}_allocation_list`;
  describe(`createK8sCostSyncable(${service})`, () => {
    test("a first sync asks for 45 days by namespace, drains every page and writes cost_allocation rows", async () => {
      const seen = fakeSession([rows(["default"], 45), rows(["kube-system"], 45)]);
      const { db, ctx } = setup(service);
      const before = Date.now();
      const r = await createK8sCostSyncable(service).sync(ctx, null);
      expect(seen.map((s) => s.toolId)).toEqual([tool, tool]);
      const first = seen[0]?.args ?? {};
      expect(Object.keys(first).sort()).toEqual([
        "aggregate",
        "cursor",
        "limit",
        "sinceMs",
        "untilMs",
      ]);
      expect(first["aggregate"]).toBe("namespace");
      expect(first["limit"]).toBe(5000);
      expect(Math.abs((first["sinceMs"] as number) - (before - 45 * DAY_MS))).toBeLessThan(5000);
      expect(seen[1]?.args["cursor"]).toBe("1");
      expect(r.itemsUpserted).toBe(90);
      expect(r.hasMore).toBe(false);
      expect(lastOkMsFromCursor(r.cursor, `nimbus-${service}1:`)).toBeGreaterThanOrEqual(before);
      expect(
        db
          .query("SELECT type, COUNT(*) AS n FROM item WHERE service = ? GROUP BY type")
          .all(service),
      ).toEqual([{ type: "cost_allocation", n: 90 }]);
      const meta = db.query("SELECT metadata FROM item WHERE service = ? LIMIT 1").get(service) as {
        metadata: string;
      };
      expect(JSON.parse(meta.metadata)).toMatchObject({
        dimensionKind: "namespace",
        groupings: ["namespace"],
        scopeId: "default",
        currency: null,
        costKind: "unknown",
      });
    });

    test("the controller aggregate and a cluster label are sent and scope the series", async () => {
      const seen = fakeSession([rows(["default/deployment:web"], 3)]);
      const { db, ctx } = setup(service, {
        [`${service}.aggregate`]: "controller",
        [`${service}.cluster`]: "prod-eu",
      });
      await createK8sCostSyncable(service).sync(ctx, null);
      expect(seen[0]?.args["aggregate"]).toBe("controller");
      const meta = db.query("SELECT metadata FROM item WHERE service = ? LIMIT 1").get(service) as {
        metadata: string;
      };
      expect(JSON.parse(meta.metadata)).toMatchObject({
        dimensionKind: "controller",
        scopeId: "prod-eu",
        dimensionValue: "default/deployment:web",
      });
    });

    test("an aggregate the sync does not offer is refused before any session", async () => {
      const seen = fakeSession([]);
      const { ctx } = setup(service, { [`${service}.aggregate`]: "pod" });
      await expect(createK8sCostSyncable(service).sync(ctx, null)).rejects.toThrow(
        "the aggregate setting must be",
      );
      expect(seen).toEqual([]);
    });

    test("a second sync asks from three days before the last success day", async () => {
      const seen = fakeSession([rows(["default"], 5)]);
      const { ctx } = setup(service);
      const first = await createK8sCostSyncable(service).sync(ctx, null);
      seen.length = 0;
      await createK8sCostSyncable(service).sync(ctx, first.cursor);
      const lastOk = lastOkMsFromCursor(first.cursor, `nimbus-${service}1:`) ?? 0;
      expect(seen[0]?.args["sinceMs"]).toBe(startOfUtcDay(lastOk) - 3 * DAY_MS);
    });

    test("re-running over unchanged replies changes no row, and the last days are provisional", async () => {
      fakeSession([rows(["default", "web"], 10)]);
      const { db, ctx } = setup(service);
      await createK8sCostSyncable(service).sync(ctx, null);
      const before = rowsOf(db, service);
      await createK8sCostSyncable(service).sync(ctx, null);
      expect(rowsOf(db, service)).toEqual(before);
      expect(before).toHaveLength(20);
      const flags = db
        .query(
          "SELECT json_extract(metadata,'$.periodStartMs') AS d, json_extract(metadata,'$.finalized') AS f FROM item WHERE service = ? ORDER BY d",
        )
        .all(service) as { d: number; f: number }[];
      expect(flags[0]?.f).toBe(1);
      expect(flags.at(-1)?.f).toBe(0);
    });

    test("a row with no usable day, key or amount is dropped and counted, not logged by value", async () => {
      const bad = [
        null,
        "x",
        { date: "yesterday", key: "a", totalCost: 1 },
        { date: dayString(-1), key: "", totalCost: 1 },
        { date: dayString(-1), key: "a", totalCost: "9" },
      ];
      fakeSession([[...bad, ...rows(["ok"], 1)]]);
      const { db, ctx } = setup(service);
      const warnings: unknown[] = [];
      const original = ctx.logger.warn.bind(ctx.logger);
      (ctx.logger as { warn: unknown }).warn = (...a: unknown[]) => {
        warnings.push(a);
        return original(...(a as Parameters<typeof original>));
      };
      const r = await createK8sCostSyncable(service).sync(ctx, null);
      expect(r.itemsUpserted).toBe(1);
      expect(rowsOf(db, service)).toHaveLength(1);
      expect(JSON.stringify(warnings)).toContain('"dropped":5');
      expect(JSON.stringify(warnings)).not.toContain("yesterday");
    });

    test("the named set: maxSeries 2 over 4 namespaces names 2 and folds 2 into __other__", async () => {
      fakeSession([
        [
          ...rows(["big1"], 3, 100),
          ...rows(["big2"], 3, 90),
          ...rows(["s1"], 3, 2),
          ...rows(["s2"], 3, 1),
        ],
      ]);
      const { db, ctx } = setup(service);
      await createK8sCostSyncable(service, { maxSeries: () => 2 }).sync(ctx, null);
      const series = db
        .query(
          "SELECT json_extract(metadata,'$.dimensionValue') AS v, SUM(json_extract(metadata,'$.rowCount')) AS rc FROM item WHERE service = ? GROUP BY v ORDER BY v",
        )
        .all(service);
      expect(series).toEqual([
        { v: "__other__", rc: 6 },
        { v: "big1", rc: 3 },
        { v: "big2", rc: 3 },
      ]);
    });

    test("a drain that throws indexes nothing and the sync rejects", async () => {
      __setFinopsSessionRunnerForTest(async (_req, body) =>
        body({
          call: async () => {
            throw new Error("down");
          },
        }),
      );
      const { db, ctx } = setup(service);
      await expect(createK8sCostSyncable(service).sync(ctx, null)).rejects.toThrow("down");
      expect(rowsOf(db, service)).toEqual([]);
    });

    test("a page without nextCursor is refused rather than indexed as complete", async () => {
      __setFinopsSessionRunnerForTest(async (_req, body) =>
        body({
          call: async () => ({
            content: [{ type: "text", text: JSON.stringify({ items: rows(["a"], 1) }) }],
          }),
        }),
      );
      const { db, ctx } = setup(service);
      await expect(createK8sCostSyncable(service).sync(ctx, null)).rejects.toThrow("partial read");
      expect(rowsOf(db, service)).toEqual([]);
    });

    test("a team credential is refused before any session", async () => {
      const seen = fakeSession([]);
      const { ctx } = setup(service);
      const teamCtx = {
        ...ctx,
        credentialFor: () => ({ credential: "team" }),
      } as unknown as SyncContext;
      await expect(createK8sCostSyncable(service).sync(teamCtx, null)).rejects.toThrow("team");
      expect(seen).toEqual([]);
    });
  });
}
