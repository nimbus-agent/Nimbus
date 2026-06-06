import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchHitlRpc, type HitlRpcContext } from "./hitl-rpc.ts";

function ctx(db: Database): HitlRpcContext {
  return { db, now: () => 1000 };
}

describe("hitl-rpc", () => {
  it("delegate then listDelegations returns the active delegation", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const created = await dispatchHitlRpc(
      "hitl.delegate",
      { delegatePeer: "peer:bob", scopeKind: "service", scopeValue: "aws", expiresAt: 99999 },
      ctx(db),
    );
    expect(created.kind).toBe("hit");
    const listed = await dispatchHitlRpc("hitl.listDelegations", {}, ctx(db));
    expect(listed.kind).toBe("hit");
    if (listed.kind === "hit") {
      expect((listed.value as { delegations: unknown[] }).delegations.length).toBe(1);
    }
  });

  it("rejects an expiresAt in the past", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(
      dispatchHitlRpc(
        "hitl.delegate",
        { delegatePeer: "peer:bob", scopeKind: "service", scopeValue: "aws", expiresAt: 500 },
        ctx(db),
      ),
    ).rejects.toThrow(/expiresAt/i);
  });
});
