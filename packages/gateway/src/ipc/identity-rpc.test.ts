import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { IdentityStore } from "../identity/identity-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchIdentityRpc } from "./identity-rpc.ts";

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
    if (list.kind === "hit") expect((list.value as { users: unknown[] }).users.length).toBe(1);
  });
  test("identity.login returns a jobId (long-running)", async () => {
    const out = await dispatchIdentityRpc("identity.login", {}, freshCtx());
    if (out.kind === "hit") expect((out.value as { jobId: string }).jobId).toBe("login-1");
  });
  test("unknown method is a miss", async () => {
    expect((await dispatchIdentityRpc("identity.bogus", {}, freshCtx())).kind).toBe("miss");
  });
});
