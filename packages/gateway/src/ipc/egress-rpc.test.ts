import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendEgressEntry } from "../egress/egress-ledger.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchEgressRpc, type EgressRpcCtx } from "./egress-rpc.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

let db: Database;
function ctx(over: Partial<EgressRpcCtx> = {}): EgressRpcCtx {
  return {
    db,
    // biome-ignore lint/suspicious/noExplicitAny: test stand-in
    vault: fakeVault() as any,
    now: () => 12345,
    requestPruneApproval: async () => true,
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  appendEgressEntry(db, {
    timestamp: 100,
    sourceType: "task",
    sourceId: "s",
    destination: "email",
    method: "email.send",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
  });
});
afterEach(() => db.close());

describe("dispatchEgressRpc", () => {
  test("unknown method misses", async () => {
    expect(await dispatchEgressRpc("egress.nope", {}, ctx())).toEqual({ kind: "miss" });
  });
  test("egress.head returns the head + count", async () => {
    const out = await dispatchEgressRpc("egress.head", {}, ctx());
    expect(out.kind).toBe("hit");
    const v = (out as { kind: "hit"; value: { head: string; count: number } }).value;
    expect(v.count).toBe(1);
  });
  test("egress.list returns rows", async () => {
    const out = await dispatchEgressRpc("egress.list", {}, ctx());
    const v = (out as { kind: "hit"; value: { rows: unknown[] } }).value;
    expect(v.rows).toHaveLength(1);
  });
  test("egress.verify returns ok on a clean chain", async () => {
    const out = await dispatchEgressRpc("egress.verify", {}, ctx());
    const v = (out as { kind: "hit"; value: { ok: boolean } }).value;
    expect(v.ok).toBe(true);
  });
  test("egress.proveWindow includes completeness + verify, and a receipt only when sign:true", async () => {
    const noSign = await dispatchEgressRpc("egress.proveWindow", { since: 0, until: 1000 }, ctx());
    const nv = (noSign as { kind: "hit"; value: Record<string, unknown> }).value;
    expect(nv["receipt"]).toBeUndefined();
    const signed = await dispatchEgressRpc(
      "egress.proveWindow",
      { since: 0, until: 1000, sign: true },
      ctx(),
    );
    const sv = (signed as { kind: "hit"; value: { receipt: { sigB64: string } } }).value;
    expect(typeof sv.receipt.sigB64).toBe("string");
  });
  test("egress.prune routes through the approval broker (denied → not pruned)", async () => {
    const denied = await dispatchEgressRpc(
      "egress.prune",
      { beforeTs: 9999 },
      ctx({ requestPruneApproval: async () => false }),
    );
    const dv = (denied as { kind: "hit"; value: { prunedCount: number; approved: boolean } }).value;
    expect(dv.approved).toBe(false);
    expect(dv.prunedCount).toBe(0);
  });
  test("egress.prune with approval prunes and reports the count", async () => {
    const out = await dispatchEgressRpc("egress.prune", { beforeTs: 9999 }, ctx());
    const v = (out as { kind: "hit"; value: { prunedCount: number; approved: boolean } }).value;
    expect(v.approved).toBe(true);
    expect(v.prunedCount).toBe(1);
  });
  test("egress.prune rejects a non-integer beforeTs", async () => {
    await expect(dispatchEgressRpc("egress.prune", { beforeTs: "x" }, ctx())).rejects.toThrow(
      /beforeTs/,
    );
  });
});
