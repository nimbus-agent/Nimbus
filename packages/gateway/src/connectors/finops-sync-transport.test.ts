import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DAY_MS } from "../finops/cost-item-contract.ts";
import type { SyncContext } from "../sync/types.ts";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import {
  __setFinopsSessionRunnerForTest,
  createFinopsSyncable,
  drainWithArgs,
  lastOkMsFromCursor,
  windowFor,
} from "./finops-sync-transport.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  createVantageSyncable,
  VANTAGE_COST_PAGE_LIMIT,
  VANTAGE_RECOMMENDATION_PAGE_LIMIT,
} from "./vantage-sync.ts";

afterEach(() => {
  __setFinopsSessionRunnerForTest(undefined);
});

function page(items: unknown[], nextCursor: string | null) {
  return { content: [{ type: "text", text: JSON.stringify({ items, nextCursor }) }] };
}

describe("drainWithArgs", () => {
  test("sends the caller's arguments plus the cursor and follows nextCursor to null", async () => {
    const calls: unknown[] = [];
    const pages = [page([1], "2"), page([2], "3"), page([3], null)];
    const session: ConnectorToolSession = {
      call: async (toolId, args) => {
        calls.push({ toolId, args });
        return pages[calls.length - 1];
      },
    };
    const items = await drainWithArgs(session, "t", { limit: 7, sinceMs: 5 });
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      { toolId: "t", args: { limit: 7, sinceMs: 5, cursor: null } },
      { toolId: "t", args: { limit: 7, sinceMs: 5, cursor: "2" } },
      { toolId: "t", args: { limit: 7, sinceMs: 5, cursor: "3" } },
    ]);
  });

  test("a mid-way throw rejects the whole drain", async () => {
    let n = 0;
    const session: ConnectorToolSession = {
      call: async () => {
        n += 1;
        if (n === 2) throw new Error("Vantage 429: rate limited");
        return page([n], "next");
      },
    };
    await expect(drainWithArgs(session, "t", {})).rejects.toThrow("rate limited");
  });

  test("a cursor that does not advance is an error", async () => {
    const session: ConnectorToolSession = { call: async () => page([1], "same") };
    // First page: cursor null -> "same"; second page returns "same" again.
    await expect(drainWithArgs(session, "t", {})).rejects.toThrow("did not advance");
  });

  test("a drain that never ends is refused, not truncated", async () => {
    let n = 0;
    const session: ConnectorToolSession = {
      call: async () => {
        n += 1;
        return page([n], String(n));
      },
    };
    await expect(drainWithArgs(session, "t", {})).rejects.toThrow("refusing a partial read");
  });
});

describe("the window and the cursor", () => {
  const now = Date.UTC(2026, 10, 12, 9, 30);

  test("no cursor reads 45 days", () => {
    expect(windowFor(null, now)).toEqual({ sinceMs: now - 45 * DAY_MS, untilMs: now });
  });

  test("a cursor re-reads from three UTC days before the last success", () => {
    const last = Date.UTC(2026, 10, 12, 3, 15);
    expect(windowFor(last, now).sinceMs).toBe(Date.UTC(2026, 10, 9));
  });

  test("a cursor from the future never asks for a window after now", () => {
    expect(windowFor(now + 30 * DAY_MS, now).sinceMs).toBe(now);
  });

  test("lastOkMsFromCursor reads only a well-formed cursor of its own prefix", () => {
    const good = encodeNimbusJsonCursor("p1:", { lastOkMs: 123456 });
    expect(lastOkMsFromCursor(good, "p1:")).toBe(123456);
    expect(lastOkMsFromCursor(good, "p2:")).toBeNull();
    expect(lastOkMsFromCursor(null, "p1:")).toBeNull();
    expect(lastOkMsFromCursor(encodeNimbusJsonCursor("p1:", { lastOkMs: "x" }), "p1:")).toBeNull();
    expect(lastOkMsFromCursor(encodeNimbusJsonCursor("p1:", { lastOkMs: -5 }), "p1:")).toBeNull();
  });
});

describe("createFinopsSyncable", () => {
  test("a team credential pin throws before any session is opened", async () => {
    let opened = 0;
    __setFinopsSessionRunnerForTest(async (_req, body) => {
      opened += 1;
      return body({ call: async () => page([], null) });
    });
    const syncable = createVantageSyncable();
    const ctx = {
      credentialFor: () => ({ credential: "team", teamEntry: "e" }),
    } as unknown as SyncContext;
    await expect(syncable.sync(ctx, null)).rejects.toThrow("not supported for cost data");
    expect(opened).toBe(0);
  });

  test("declares the 6 hour cadence and the 45 day first window", () => {
    const syncable = createVantageSyncable();
    expect(syncable.serviceId).toBe("vantage");
    expect(syncable.defaultIntervalMs).toBe(6 * 60 * 60 * 1000);
    expect(syncable.initialSyncDepthDays).toBe(45);
    expect(createFinopsSyncable).toBeDefined();
  });
});

describe("the arguments match the connector's real zod bounds", () => {
  // The installed connectors package is the source of truth for the two tools' input schemas. Its `src`
  // is not importable under the gateway's dependency rules, so the two shapes are copied here and the
  // limits are pinned to the package's own source text: a change upstream fails this test first.
  const costSchema = z.object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    sinceMs: z.number().int().min(0).max(253_402_300_799_999).optional(),
    untilMs: z.number().int().min(0).max(253_402_300_799_999).optional(),
  });
  const recommendationSchema = z.object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  });

  function connectorsSource(file: string): string {
    // The package exports `./vantage` as connectors/vantage/src/server.ts; its root is three levels up.
    const server = Bun.resolveSync("@nimbus-dev/connectors/vantage", import.meta.dir);
    const root = dirname(dirname(dirname(dirname(server))));
    return readFileSync(join(root, file), "utf8");
  }

  test("the copied shapes still say what the installed package says", () => {
    const tools = connectorsSource("connectors/vantage/src/tools.ts");
    expect(tools).toContain("const COSTS_PAGE_LIMIT = 5000;");
    expect(tools).toContain("const RECOMMENDATIONS_PAGE_LIMIT = 1000;");
    expect(tools).toContain("limit: z.number().int().min(1).max(COSTS_PAGE_LIMIT).optional(),");
    expect(tools).toContain("cursorListInputSchema(RECOMMENDATIONS_PAGE_LIMIT)");
    expect(tools).toContain("sinceMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),");
    expect(connectorsSource("shared/cursor-list-tool.ts")).toContain(
      "limit: z.number().int().min(1).max(maxLimit).optional(),",
    );
  });

  test("the real syncable sends arguments both schemas accept; a 5000 limit on recommendations would not parse", async () => {
    const sent: { toolId: string; args: unknown }[] = [];
    __setFinopsSessionRunnerForTest(async (_req, body) =>
      body({
        call: async (toolId, args) => {
          sent.push({ toolId, args });
          return page([], null);
        },
      }),
    );
    const syncable = createVantageSyncable();
    const ctx = {
      credentialFor: () => ({ credential: "personal" }),
      getSecret: async () => null,
      scopedVaultView: () => ({}),
      sandboxCwd: "x",
      listIndexedMetadataValues: () => [],
      writeBatch: <T>(fn: () => T) => fn(),
      upsertItem: () => {},
      logger: { warn: () => {} },
    } as unknown as SyncContext;
    await syncable.sync(ctx, null);
    const cost = sent.find((s) => s.toolId === "vantage_cost_list");
    const rec = sent.find((s) => s.toolId === "vantage_recommendation_list");
    expect(costSchema.safeParse(cost?.args).success).toBe(true);
    expect(recommendationSchema.safeParse(rec?.args).success).toBe(true);
    expect(cost?.args).toMatchObject({ limit: VANTAGE_COST_PAGE_LIMIT, cursor: null });
    expect(Object.keys(rec?.args as object).sort()).toEqual(["cursor", "limit"]);
    expect(rec?.args).toMatchObject({ limit: VANTAGE_RECOMMENDATION_PAGE_LIMIT });
    expect(recommendationSchema.safeParse({ limit: VANTAGE_COST_PAGE_LIMIT }).success).toBe(false);
  });
});
