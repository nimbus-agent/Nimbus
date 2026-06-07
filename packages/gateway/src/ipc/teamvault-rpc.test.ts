import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { dispatchTeamVaultRpc, type TeamVaultRpcContext } from "./teamvault-rpc.ts";

function ctx(db: Database, vault: Map<string, string>): TeamVaultRpcContext {
  return {
    db,
    vault: {
      set: async (k, v) => void vault.set(k, v),
      delete: async (k) => void vault.delete(k),
    },
    operator: "owner",
  };
}

describe("teamvault-rpc", () => {
  it("put writes per-connector secret keys to the vault + creates the entry", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    const out = await dispatchTeamVaultRpc(
      "teamvault.put",
      {
        entry: "prod-aws",
        service: "aws",
        secrets: { "aws.access_key_id": "AKIA...", "aws.secret_access_key": "shh" },
      },
      ctx(db, vault),
    );
    expect(out.kind).toBe("hit");
    expect(vault.get(teamVaultKey("prod-aws", "aws.access_key_id"))).toBe("AKIA...");
    expect(vault.get(teamVaultKey("prod-aws", "aws.secret_access_key"))).toBe("shh");
    const listed = await dispatchTeamVaultRpc("teamvault.list", {}, ctx(db, vault));
    expect(listed.kind).toBe("hit");
    if (listed.kind === "hit") {
      expect(listed.value).toMatchObject({ entries: [{ entry: "prod-aws", service: "aws" }] });
    }
  });

  it("grant returns ok (RBAC surfaced via store)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    await dispatchTeamVaultRpc(
      "teamvault.put",
      { entry: "prod-aws", service: "aws", secrets: { "aws.access_key_id": "x" } },
      ctx(db, vault),
    );
    const g = await dispatchTeamVaultRpc(
      "teamvault.grant",
      { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
      ctx(db, vault),
    );
    expect(g.kind).toBe("hit");
    if (g.kind === "hit") expect(g.value).toEqual({ ok: true });
  });

  it("delete removes the named secret keys from the vault, leaving others", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    await dispatchTeamVaultRpc(
      "teamvault.put",
      {
        entry: "prod-aws",
        service: "aws",
        secrets: { "aws.access_key_id": "x", "aws.secret_access_key": "y" },
      },
      ctx(db, vault),
    );

    const out = await dispatchTeamVaultRpc(
      "teamvault.delete",
      { entry: "prod-aws", keys: ["aws.access_key_id", 123] }, // non-string keys are skipped
      ctx(db, vault),
    );

    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect(out.value).toEqual({ ok: true });
    expect(vault.has(teamVaultKey("prod-aws", "aws.access_key_id"))).toBe(false);
    expect(vault.has(teamVaultKey("prod-aws", "aws.secret_access_key"))).toBe(true);
  });

  it("revoke returns ok after a grant", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    await dispatchTeamVaultRpc(
      "teamvault.put",
      { entry: "prod-aws", service: "aws", secrets: { "aws.access_key_id": "x" } },
      ctx(db, vault),
    );
    await dispatchTeamVaultRpc(
      "teamvault.grant",
      { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
      ctx(db, vault),
    );

    const r = await dispatchTeamVaultRpc(
      "teamvault.revoke",
      { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
      ctx(db, vault),
    );

    expect(r.kind).toBe("hit");
    if (r.kind === "hit") expect(r.value).toEqual({ ok: true });
  });

  it("rejects invalid params with a TeamVaultRpcError (-32602)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    await expect(dispatchTeamVaultRpc("teamvault.put", null, ctx(db, vault))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
  });
});
