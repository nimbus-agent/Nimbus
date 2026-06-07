import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as never,
    pairing: { listPeers: () => [] } as never,
    teamVault: {
      quorumFor: () => undefined,
      runTool: async () => ({ ok: 1 }),
    },
  };
}

describe("federation.invoke dispatch", () => {
  it("returns no_grant when no grant exists (peerId forced by caller)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    new TeamVaultStore(db).createEntry("prod-aws", "aws", "owner", 1);
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.lambda.invoke", purpose: "x" },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ kind: "error", error: "no_grant" });
    }
  });

  it("runs the tool and returns ok for a granted (entry,peer,tool)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1);
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.ec2.instance.stop", purpose: "x" },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ kind: "ok", result: { ok: 1 } });
    }
  });

  it("federation.quorumRespond feeds the coordinator (no live request → matched false)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const out = await dispatchFederationRpc(
      "federation.quorumRespond",
      { requestId: "nope", peerId: "peer:a", approved: true },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ ok: true, matched: false });
    }
  });
});
