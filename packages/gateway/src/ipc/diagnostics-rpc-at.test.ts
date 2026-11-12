import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { openMigratedDb } from "../index/migrated-db-template.ts";
import { type DiagnosticsRpcContext, dispatchDiagnosticsRpc } from "./diagnostics-rpc.ts";

const BASE = Date.UTC(2026, 0, 1);
const AT = "2026-01-01T00:00:01Z"; // BASE + 1000 ms

function withCtx(fn: (ctx: DiagnosticsRpcContext, db: Database) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-at-"));
  const db = openMigratedDb(join(dir, "nimbus.db"));
  const ctx: DiagnosticsRpcContext = {
    dataDir: dir,
    configDir: dir,
    consent: { pendingCount: () => 0 } as never,
    gatewayVersion: "0.0.0-test",
    startedAtMs: Date.now() - 5000,
    localIndex: new LocalIndex(db),
  };
  return fn(ctx, db).finally(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* best-effort */
    }
  });
}

function seed(db: Database): void {
  const put = (ext: string, title: string, opened: number, at: number): void =>
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: ext,
      title,
      modifiedAt: at,
      syncedAt: at,
      metadata: { state: "open", opened_at_ms: opened },
    });
  put("seed", "unrelated", BASE - 10, BASE);
  put("old", "payment-service retry", BASE + 100, BASE + 200);
  put("late", "payment-service rewrite", BASE + 1200, BASE + 1300);
  // An untracked-type row modified after T: it cannot be placed.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
     VALUES ('github:gap', 'github', 'review', 'gap', 'g', ?, 1, '{}')`,
    [BASE + 1100],
  );
}

async function call(ctx: DiagnosticsRpcContext, params: unknown): Promise<unknown> {
  const r = await dispatchDiagnosticsRpc("index.queryItems", params, ctx);
  return (r as { value: unknown }).value;
}

describe("index.queryItems - at (Phase 10 IC1)", () => {
  test("returns the admitted items, asOf with the disclosure, and the exact gap count", () =>
    withCtx(async (ctx, db) => {
      seed(db);
      const v = (await call(ctx, { services: ["github"], at: AT, explain: true })) as {
        items: Array<{ id: string; asOf: { basis: string } }>;
        gaps: { excludedUnplaceable: number };
        asOf: { atMs: number; zone: string; historyStartMs: number; disclosure: string[] };
        meta: { total: number };
        explain: { sql: string };
      };
      expect(v.items.map((i) => i.id).sort()).toEqual(["old", "seed"]);
      expect(v.items[0]?.asOf.basis).toBe("current");
      expect(v.gaps).toEqual({ excludedUnplaceable: 1 });
      expect(v.asOf.atMs).toBe(BASE + 1000);
      expect(v.asOf.historyStartMs).toBe(BASE);
      expect(v.asOf.disclosure[0]).toContain("As of 2026-01-01T00:00:01.000Z");
      expect(v.asOf.disclosure.join("\n")).toContain("1 item could not be placed");
      expect(v.meta.total).toBe(2);
      expect(v.explain.sql).toContain("item_history");
    }));

  test("a type filter scopes the gap count too; no service filter reads every service's history", () =>
    withCtx(async (ctx, db) => {
      seed(db);
      const scoped = (await call(ctx, { services: ["github"], types: ["pr"], at: AT })) as {
        gaps: { excludedUnplaceable: number };
        items: unknown[];
      };
      expect(scoped.gaps.excludedUnplaceable).toBe(0);
      expect(scoped.items).toHaveLength(2);
      const all = (await call(ctx, { at: AT })) as {
        asOf: { historyStartMs: number };
        gaps: { excludedUnplaceable: number };
      };
      expect(all.asOf.historyStartMs).toBe(BASE);
      expect(all.gaps.excludedUnplaceable).toBe(1);
    }));

  test.each([
    ["a non-string", { at: 5 }],
    ["an empty string", { at: "" }],
    ["an unparseable string", { at: "soon" }],
    ["a future instant", { at: "2999-01-01T00:00Z" }],
    ["notTouching", { at: "-1h", notTouching: "src/**" }],
    ["noDownstreamIncident", { at: "-1h", noDownstreamIncident: true }],
    ["sinceMs", { at: "-1h", sinceMs: 1 }],
    ["untilMs", { at: "-1h", untilMs: 1 }],
  ])("%s is refused with -32602", (_label, params) =>
    withCtx(async (ctx) => {
      await expect(
        (async () => dispatchDiagnosticsRpc("index.queryItems", params, ctx))(),
      ).rejects.toMatchObject({ rpcCode: -32602 });
    }),
  );

  test("a null at is ignored, and the plain response has no asOf", () =>
    withCtx(async (ctx, db) => {
      seed(db);
      const v = (await call(ctx, { services: ["github"], at: null })) as Record<string, unknown>;
      expect(v["asOf"]).toBeUndefined();
      expect(v["gaps"]).toBeUndefined();
    }));

  test("index.querySql refuses a present at and is unchanged without it", () =>
    withCtx(async (ctx) => {
      await expect(
        (async () =>
          dispatchDiagnosticsRpc("index.querySql", { sql: "SELECT 1", at: "-1h" }, ctx))(),
      ).rejects.toMatchObject({ rpcCode: -32602 });
      const ok = await dispatchDiagnosticsRpc(
        "index.querySql",
        { sql: "SELECT 1 AS n", at: null },
        ctx,
      );
      expect(ok.kind).toBe("hit");
    }));
});
