import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const CSV = [
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags",
  '10,111,USD,2026-11-20T00:00:00Z,AWS,Amazon S3,"{""product"":""checkout"",""env"":""prod""}"',
  '4,111,USD,2026-11-20T00:00:00Z,AWS,Amazon EC2,"{""product"":""tools"",""env"":""ci""}"',
].join("\n");

let db: Database;
let dir: string;
beforeEach(async () => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-views-rpc-"));
  writeFileSync(join(dir, "a.csv"), CSV);
  writeFileSync(
    join(dir, "nimbus.toml"),
    '[[cost.rule]]\nmatch = { tag = { product = "*" } }\nset = { product = "{tag.product}", env = "{tag.env}" }\n',
  );
  await call("cost.import", { path: join(dir, "a.csv") }, "cli");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, params: unknown, kind?: ClientKind): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    configDir: dir,
    now: () => NOW,
    ...(kind === undefined ? {} : { caller: { kind } }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<CostRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CostRpcError) return e;
    throw e;
  }
  throw new Error("expected a CostRpcError");
}

type View = { byCurrency: Record<string, { total: number; rows: { key: string }[] }> };

describe("cost.products and cost.internal", () => {
  test("cli and ui connections are served from the local lines and the owner's rules", async () => {
    for (const kind of ["cli", "ui"] as const) {
      const v = (await call("cost.products", { period: "30d" }, kind)) as View;
      expect(v.byCurrency["USD"]?.rows.map((r) => r.key)).toEqual(["checkout", "tools"]);
    }
    const i = (await call("cost.internal", {}, "cli")) as View;
    expect(i.byCurrency["USD"]?.rows.map((r) => r.key)).toEqual(["ci"]);
  });

  test("other kinds are refused", async () => {
    for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      expect((await rpcError(call("cost.products", {}, kind))).message).toContain(
        "ERR_COST_FORBIDDEN_CLIENT",
      );
      expect((await rpcError(call("cost.internal", {}, kind))).message).toContain(
        "ERR_COST_FORBIDDEN_CLIENT",
      );
    }
    expect((await rpcError(call("cost.products", {}))).message).toContain(
      "ERR_COST_FORBIDDEN_CLIENT",
    );
  });

  test("bad params are -32602", async () => {
    expect((await rpcError(call("cost.products", { period: "year" }, "cli"))).rpcCode).toBe(-32602);
    expect((await rpcError(call("cost.products", { allocation: "x" }, "cli"))).rpcCode).toBe(
      -32602,
    );
    expect((await rpcError(call("cost.internal", { allocation: "cluster" }, "cli"))).rpcCode).toBe(
      -32602,
    );
    expect((await rpcError(call("cost.internal", [], "cli"))).rpcCode).toBe(-32602);
  });

  test("allocation cluster is its own view", async () => {
    expect(await call("cost.products", { allocation: "cluster" }, "cli")).toMatchObject({
      view: "cluster",
      rows: [],
    });
  });

  test("the views add no egress row", async () => {
    await call("cost.products", {}, "cli");
    await call("cost.internal", {}, "cli");
    expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
  });
});
