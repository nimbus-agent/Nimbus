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

  // lines 68-71: hitl.revokeDelegation body
  it("revokeDelegation removes the delegation from the active list", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    // Create a delegation using action_type scopeKind (exercises that valid branch too)
    const created = await dispatchHitlRpc(
      "hitl.delegate",
      {
        delegatePeer: "peer:carol",
        scopeKind: "action_type",
        scopeValue: "shell.run",
        expiresAt: 99999,
      },
      ctx(db),
    );
    expect(created.kind).toBe("hit");
    if (created.kind !== "hit") return;
    const delegationId = (created.value as { delegationId: string }).delegationId;

    // Revoke it — lines 68-71
    const revoked = await dispatchHitlRpc("hitl.revokeDelegation", { delegationId }, ctx(db));
    expect(revoked.kind).toBe("hit");
    if (revoked.kind === "hit") {
      expect(revoked.value).toEqual({ ok: true });
    }

    // Confirm it no longer appears in the active list
    const listed = await dispatchHitlRpc("hitl.listDelegations", {}, ctx(db));
    expect(listed.kind).toBe("hit");
    if (listed.kind === "hit") {
      const { delegations } = listed.value as { delegations: unknown[] };
      expect(delegations.length).toBe(0);
    }
  });

  // line 77: hitl.pendingQueue body
  it("pendingQueue returns an empty array when no delegated approvals are in flight", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const result = await dispatchHitlRpc("hitl.pendingQueue", {}, ctx(db));
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      const { pending } = result.value as { pending: unknown[] };
      expect(Array.isArray(pending)).toBe(true);
    }
  });

  // line 21, block 0, branch 0: rec() null/non-object path
  it("rejects null params with ERR_INVALID_PARAMS: object expected", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(dispatchHitlRpc("hitl.revokeDelegation", null, ctx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS: object expected/,
    );
  });

  // line 28, block 2, branch 0: str() missing/empty-string path
  it("rejects delegate with missing delegatePeer (empty string) with ERR_INVALID_PARAMS", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(
      dispatchHitlRpc(
        "hitl.delegate",
        { delegatePeer: "", scopeKind: "service", scopeValue: "aws", expiresAt: 99999 },
        ctx(db),
      ),
    ).rejects.toThrow(/ERR_INVALID_PARAMS/);
  });

  // line 35, block 4, branch 0: num() non-number path
  // scopeKind str check runs first, then scopeKind validity, then expiresAt num()
  it("rejects delegate with non-number expiresAt with 'must be a number'", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(
      dispatchHitlRpc(
        "hitl.delegate",
        { delegatePeer: "peer:dave", scopeKind: "service", scopeValue: "gcp", expiresAt: "soon" },
        ctx(db),
      ),
    ).rejects.toThrow(/must be a number/);
  });

  // line 52, block 7, branch 0: bad scopeKind path
  it("rejects delegate with unrecognised scopeKind with 'bad scopeKind'", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(
      dispatchHitlRpc(
        "hitl.delegate",
        { delegatePeer: "peer:eve", scopeKind: "bogus", scopeValue: "anything", expiresAt: 99999 },
        ctx(db),
      ),
    ).rejects.toThrow(/bad scopeKind/);
  });
});
