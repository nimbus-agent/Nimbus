import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchIdentityRpc, IdentityRpcError } from "./identity-rpc.ts";

function freshCtx() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  const store = new IdentityStore(db);
  store.upsertSession({
    issuer: "https://acme",
    externalId: "sub-1",
    email: "a@acme.com",
    validatedAt: 0,
    expiresAt: 10,
    status: "active",
  });
  store.upsertScimUser(
    { externalId: "u1", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
    1,
  );
  return {
    db,
    issuer: "https://acme",
    identityStore: store,
    notify: () => {},
    now: () => 5,
    startLogin: () => ({ jobId: "login-1" }),
  };
}

describe("dispatchIdentityRpc", () => {
  test("identity.status returns the validated identity (no token)", async () => {
    const out = await dispatchIdentityRpc("identity.status", {}, freshCtx());
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as Record<string, unknown>;
      expect(v["externalId"]).toBe("sub-1");
      expect(JSON.stringify(v).toLowerCase().includes("token")).toBe(false);
    }
  });
  test("identity.bind binds email→peer and scim.listUsers returns the roster", async () => {
    const ctx = freshCtx();
    const bind = await dispatchIdentityRpc(
      "identity.bind",
      { email: "a@acme.com", peerId: "peer:alice" },
      ctx,
    );
    expect(bind.kind).toBe("hit");
    expect(ctx.identityStore.activePeerIdsFor("u1")).toEqual(["peer:alice"]);
    const list = await dispatchIdentityRpc("scim.listUsers", {}, ctx);
    if (list.kind === "hit") expect((list.value as { users: unknown[] }).users).toHaveLength(1);
  });
  test("identity.login returns a jobId (long-running)", async () => {
    const out = await dispatchIdentityRpc("identity.login", {}, freshCtx());
    if (out.kind === "hit") expect((out.value as { jobId: string }).jobId).toBe("login-1");
  });
  test("unknown method is a miss", async () => {
    expect((await dispatchIdentityRpc("identity.bogus", {}, freshCtx())).kind).toBe("miss");
  });

  test("identity.logout clears the session (status then reports loggedOut)", async () => {
    const ctx = freshCtx();
    const out = await dispatchIdentityRpc("identity.logout", {}, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { ok: boolean }).ok).toBe(true);
    // The session row is gone; status now reports loggedIn:false.
    const status = await dispatchIdentityRpc("identity.status", {}, ctx);
    if (status.kind === "hit") expect((status.value as { loggedIn: boolean }).loggedIn).toBe(false);
  });

  test("identity.bind for an unknown email throws IdentityRpcError(-32602)", async () => {
    const ctx = freshCtx();
    let caught: unknown;
    try {
      await dispatchIdentityRpc("identity.bind", { email: "nobody@acme.com", peerId: "p" }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IdentityRpcError);
    if (caught instanceof IdentityRpcError) expect(caught.rpcCode).toBe(-32602);
  });

  test("identity.unbind revokes the active binding for a peer", async () => {
    const ctx = freshCtx();
    await dispatchIdentityRpc("identity.bind", { email: "a@acme.com", peerId: "peer:x" }, ctx);
    expect(ctx.identityStore.activePeerIdsFor("u1")).toEqual(["peer:x"]);
    const out = await dispatchIdentityRpc("identity.unbind", { peerId: "peer:x" }, ctx);
    expect(out.kind).toBe("hit");
    expect(ctx.identityStore.activePeerIdsFor("u1")).toEqual([]);
  });

  test("identity.listBindings: known email → peers, unknown email → empty", async () => {
    const ctx = freshCtx();
    await dispatchIdentityRpc("identity.bind", { email: "a@acme.com", peerId: "peer:y" }, ctx);
    const known = await dispatchIdentityRpc("identity.listBindings", { email: "a@acme.com" }, ctx);
    if (known.kind === "hit")
      expect((known.value as { peers: string[] }).peers).toEqual(["peer:y"]);
    const unknown = await dispatchIdentityRpc(
      "identity.listBindings",
      { email: "ghost@acme.com" },
      ctx,
    );
    if (unknown.kind === "hit") expect((unknown.value as { peers: string[] }).peers).toEqual([]);
  });

  test("scim.status reports the SCIM user count", async () => {
    const out = await dispatchIdentityRpc("scim.status", {}, freshCtx());
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { users: number }).users).toBe(1);
  });

  test("scim.deprovision revokes the bound peer's grants and removes the binding", async () => {
    const ctx = freshCtx();
    // Seed a published namespace + an active grant to a peer that we bind to the SCIM user.
    const ns = new NamespaceStore(ctx.db);
    ns.publish("work", [{ kind: "type", value: "email" }], 1);
    ns.grant("work", "peer:deprovision", "viewer", true, 1);
    expect(ns.getActiveGrant("work", "peer:deprovision")).not.toBeUndefined();
    ctx.identityStore.bind("u1", "peer:deprovision", "admin", 1);

    const out = await dispatchIdentityRpc("scim.deprovision", { email: "a@acme.com" }, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { ok: boolean; revokedPeers: string[] };
      expect(v.ok).toBe(true);
      expect(v.revokedPeers).toEqual(["peer:deprovision"]);
    }
    // The federation grant is gone and the binding is revoked.
    expect(ns.getActiveGrant("work", "peer:deprovision")).toBeUndefined();
    expect(ctx.identityStore.activePeerIdsFor("u1")).toEqual([]);
  });

  test("scim.deprovision for an unknown email throws IdentityRpcError(-32602)", async () => {
    const ctx = freshCtx();
    let caught: unknown;
    try {
      await dispatchIdentityRpc("scim.deprovision", { email: "ghost@acme.com" }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IdentityRpcError);
    if (caught instanceof IdentityRpcError) expect(caught.rpcCode).toBe(-32602);
  });
});
