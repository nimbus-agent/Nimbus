import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const CSV =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName\n2.5,111,USD,2026-11-01T00:00:00Z,AWS,Amazon S3\n";

let db: Database;
let dir: string;
let file: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-rpc-"));
  file = join(dir, "a.csv");
  writeFileSync(file, CSV);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: string,
  params: unknown,
  kind?: ClientKind,
  demo = false,
): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    now: () => 1,
    ...(kind === undefined ? {} : { caller: { kind } }),
    ...(demo ? { demo: true } : {}),
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

describe("cost.import", () => {
  test("a cli connection imports and the report carries the totals", async () => {
    const r = (await call("cost.import", { path: file }, "cli")) as {
      files: { status: string; totals: Record<string, number> }[];
    };
    expect(r.files[0]).toMatchObject({ status: "imported", totals: { USD: 2.5 } });
  });

  test("every other declared kind, and an undeclared one, is refused before anything is read", async () => {
    for (const kind of ["ui", "mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      const e = await rpcError(call("cost.import", { path: file }, kind));
      expect(e.message).toContain("ERR_COST_FORBIDDEN_CLIENT");
    }
    const none = await rpcError(call("cost.import", { path: file }));
    expect(none.message).toContain("ERR_COST_FORBIDDEN_CLIENT");
    expect((db.query("SELECT COUNT(*) AS n FROM cost_line").get() as { n: number }).n).toBe(0);
  });

  test("a demo gateway refuses", async () => {
    const e = await rpcError(call("cost.import", { path: file }, "cli", true));
    expect(e.message).toContain("ERR_COST_DEMO");
  });

  test("bad params are -32602; a bad path is ERR_COST_IMPORT", async () => {
    expect((await rpcError(call("cost.import", { path: file, nope: 1 }, "cli"))).rpcCode).toBe(
      -32602,
    );
    expect(
      (await rpcError(call("cost.import", { path: file, provider: "oci" }, "cli"))).rpcCode,
    ).toBe(-32602);
    expect(
      (await rpcError(call("cost.import", { path: file, dryRun: "yes" }, "cli"))).rpcCode,
    ).toBe(-32602);
    expect((await rpcError(call("cost.import", [], "cli"))).rpcCode).toBe(-32602);
    const rel = await rpcError(call("cost.import", { path: "a.csv" }, "cli"));
    expect(rel.message).toContain("ERR_COST_IMPORT");
  });
});

describe("cost.importRemove", () => {
  test("removes one import for a cli connection; refuses other kinds", async () => {
    const r = (await call("cost.import", { path: file }, "cli")) as {
      files: { importId: string }[];
    };
    const importId = r.files[0]?.importId ?? "";
    expect((await rpcError(call("cost.importRemove", { importId }, "ui"))).message).toContain(
      "ERR_COST_FORBIDDEN_CLIENT",
    );
    expect(await call("cost.importRemove", { importId }, "cli")).toEqual({ importId, removed: 1 });
    expect((await rpcError(call("cost.importRemove", { importId: "x" }, "cli"))).rpcCode).toBe(
      -32602,
    );
  });
});

describe("the Phase 7 cost methods over LAN (I5)", () => {
  test.each([
    "cost.import",
    "cost.importRemove",
    "cost.products",
    "cost.internal",
    "cost.why",
    "cost.rulesCheck",
  ])("%s is refused over LAN regardless of grant-write", (method) => {
    for (const writeAllowed of [true, false]) {
      expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed })).toThrow(LanError);
    }
  });
});
