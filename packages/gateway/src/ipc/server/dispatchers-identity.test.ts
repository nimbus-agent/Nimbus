// dispatchers-identity.test.ts
// Unit coverage for `tryDispatchIdentityRpc` (mirrors the federation dispatcher unit-test shape in
// dispatchers.test.ts): the skip path, a normal hit, the scim.setToken Vault-write path, and the
// IdentityRpcError → RpcMethodError conversion.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { IdentityStore } from "../../identity/identity-store.ts";
import { readScimBearer } from "../../identity/identity-vault.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchIdentityRpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  openDbs.length = 0;
});

/** A V34 LocalIndex whose DB carries the identity_session/scim_user tables. */
function v34Index(): LocalIndex {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  openDbs.push(db);
  return new LocalIndex(db);
}

function makeCtx(overrides: Partial<ServerCtx["options"]> = {}): ServerCtx {
  const consentImpl = new ConsentCoordinatorImpl(() => undefined);
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...overrides,
    },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification() {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

/** A wired identity context: a V34 index + a seeded IdentityStore + the issuer. */
function wiredIdentityCtx(overrides: Partial<ServerCtx["options"]> = {}): {
  ctx: ServerCtx;
  store: IdentityStore;
} {
  const index = v34Index();
  const store = new IdentityStore(index.getDatabase());
  store.upsertSession({
    issuer: "https://acme",
    externalId: "sub-1",
    email: "a@acme.com",
    validatedAt: 0,
    expiresAt: 10,
    status: "active",
  });
  const ctx = makeCtx({
    localIndex: index,
    identityStore: store,
    identityIssuer: "https://acme",
    ...overrides,
  });
  return { ctx, store };
}

describe("tryDispatchIdentityRpc", () => {
  test("skips when identity is unconfigured (no identityStore/issuer)", async () => {
    const ctx = makeCtx({ localIndex: v34Index() });
    expect(await tryDispatchIdentityRpc(ctx, "identity.status", {})).toBe(phase4RpcSkipped);
  });

  test("skips when localIndex is missing even though store/issuer are present", async () => {
    const index = v34Index();
    const store = new IdentityStore(index.getDatabase());
    const ctx = makeCtx({ identityStore: store, identityIssuer: "https://acme" });
    expect(await tryDispatchIdentityRpc(ctx, "identity.status", {})).toBe(phase4RpcSkipped);
  });

  test("identity.status hits and reports the validated identity", async () => {
    const { ctx } = wiredIdentityCtx({ identityGraceSeconds: 1000 });
    const out = (await tryDispatchIdentityRpc(ctx, "identity.status", {})) as Record<
      string,
      unknown
    >;
    expect(out["loggedIn"]).toBe(true);
    expect(out["externalId"]).toBe("sub-1");
  });

  test("scim.setToken writes the bearer to the Vault and returns ok", async () => {
    const vault: NimbusVault = createMockVault();
    const { ctx } = wiredIdentityCtx({ identityVault: vault });
    const out = (await tryDispatchIdentityRpc(ctx, "scim.setToken", {
      token: "bearer-xyz",
    })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(await readScimBearer(vault)).toBe("bearer-xyz");
  });

  test("scim.setToken with a missing token throws RpcMethodError(-32602)", async () => {
    const vault: NimbusVault = createMockVault();
    const { ctx } = wiredIdentityCtx({ identityVault: vault });
    let caught: unknown;
    try {
      await tryDispatchIdentityRpc(ctx, "scim.setToken", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    if (caught instanceof RpcMethodError) expect(caught.rpcCode).toBe(-32602);
  });

  test("scim.setToken without an identityVault throws RpcMethodError(-32602)", async () => {
    const { ctx } = wiredIdentityCtx(); // no identityVault
    await expect(
      tryDispatchIdentityRpc(ctx, "scim.setToken", { token: "x" }),
    ).rejects.toBeInstanceOf(RpcMethodError);
  });

  test("an IdentityRpcError from the pure dispatcher is converted to RpcMethodError", async () => {
    // identity.bind for an unknown email throws IdentityRpcError(-32602) inside dispatchIdentityRpc;
    // tryDispatchIdentityRpc must re-wrap it as RpcMethodError with the same code.
    const { ctx } = wiredIdentityCtx();
    let caught: unknown;
    try {
      await tryDispatchIdentityRpc(ctx, "identity.bind", { email: "ghost@acme.com", peerId: "p" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    if (caught instanceof RpcMethodError) expect(caught.rpcCode).toBe(-32602);
  });

  test("identity.login throws when startLogin is not wired", async () => {
    const { ctx } = wiredIdentityCtx(); // no identityStartLogin
    await expect(tryDispatchIdentityRpc(ctx, "identity.login", {})).rejects.toBeInstanceOf(
      RpcMethodError,
    );
  });

  test("identity.login returns the jobId when startLogin is wired", async () => {
    const { ctx } = wiredIdentityCtx({ identityStartLogin: () => ({ jobId: "login-7" }) });
    const out = (await tryDispatchIdentityRpc(ctx, "identity.login", {})) as Record<
      string,
      unknown
    >;
    expect(out["jobId"]).toBe("login-7");
  });

  test("an unknown identity.* method falls through to the skip sentinel", async () => {
    const { ctx } = wiredIdentityCtx();
    expect(await tryDispatchIdentityRpc(ctx, "identity.bogus", {})).toBe(phase4RpcSkipped);
  });
});
