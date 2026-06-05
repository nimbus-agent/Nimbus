// identity-runtime.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { NimbusIdentityToml } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityRuntime } from "./identity-runtime.ts";
import { IdentityStore } from "./identity-store.ts";
import { isOperatorValid } from "./verifier.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    store: m,
    vault: {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
      listKeys: async () => [...m.keys()],
    },
  };
}
const CFG: NimbusIdentityToml = {
  enabled: true,
  issuer: "https://acme",
  clientId: "c1",
  flow: "device_code",
  scopes: ["openid"],
  sessionGraceSeconds: 1000,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdentityRuntime.login", () => {
  test("persists a session + stores tokens in the vault (never in DB)", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    const { vault, store: vaultMap } = fakeVault();
    const rt = new IdentityRuntime({
      cfg: CFG,
      store,
      vault,
      now: () => 1000,
      deps: {
        discover: async () => ({
          issuer: "https://acme",
          deviceAuthorizationEndpoint: "d",
          tokenEndpoint: "t",
          jwksUri: "j",
        }),
        requestDeviceCode: async () => ({
          deviceCode: "dc",
          userCode: "UC",
          verificationUri: "https://acme/act",
          interval: 1,
          expiresIn: 60,
        }),
        pollDeviceToken: async () => ({ idToken: "h.p.s", refreshToken: "rt", expiresIn: 3600 }),
        validateIdToken: async () => ({
          sub: "sub-1",
          email: "a@acme.com",
          iss: "https://acme",
          aud: "c1",
          exp: 2,
          raw: {},
        }),
      },
    });
    const begun = await rt.login(() => {});
    expect(begun.userCode).toBe("UC");
    expect(store.getSession("https://acme")?.externalId).toBe("sub-1");
    expect(vaultMap.get("identity.oidc.id_token")).toBe("h.p.s");
    expect(vaultMap.get("identity.oidc.refresh_token")).toBe("rt");
    // no token leaked into the DB:
    const dump = JSON.stringify(db.query("SELECT * FROM identity_session").all());
    expect(dump.includes("h.p.s")).toBe(false);
  });
});

describe("IdentityRuntime.revalidateSession", () => {
  test("refresh success resets expires_at", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({
      issuer: "https://acme",
      externalId: "s",
      email: null,
      validatedAt: 0,
      expiresAt: 1000,
      status: "active",
    });
    const { vault } = fakeVault();
    await vault.set("identity.oidc.refresh_token", "rt");
    let refreshed = false;
    const rt = new IdentityRuntime({
      cfg: CFG,
      store,
      vault,
      now: () => 5000,
      deps: {
        discover: async () => ({
          issuer: "https://acme",
          deviceAuthorizationEndpoint: "d",
          tokenEndpoint: "t",
          jwksUri: "j",
        }),
        requestDeviceCode: async () => {
          throw new Error("n/a");
        },
        pollDeviceToken: async () => {
          throw new Error("n/a");
        },
        validateIdToken: async () => ({
          sub: "s",
          iss: "https://acme",
          aud: "c1",
          exp: 9999,
          raw: {},
        }),
        refreshTokens: async () => {
          refreshed = true;
          return { idToken: "new", refreshToken: "rt2", expiresIn: 3600 };
        },
      },
    });
    await rt.revalidateSession();
    expect(refreshed).toBe(true);
    expect(store.getSession("https://acme")?.expiresAt).toBeGreaterThan(1000);
  });

  test("refresh failure: no throw, expires_at unchanged, status still active, warn logged (review P2)", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({
      issuer: "https://acme",
      externalId: "s",
      email: null,
      validatedAt: 0,
      expiresAt: 1000,
      status: "active",
    });
    const { vault } = fakeVault();
    await vault.set("identity.oidc.refresh_token", "rt");
    const warnings: string[] = [];
    const rt = new IdentityRuntime({
      cfg: CFG,
      store,
      vault,
      now: () => 5000,
      log: (m) => warnings.push(m),
      deps: {
        discover: async () => ({
          issuer: "https://acme",
          deviceAuthorizationEndpoint: "d",
          tokenEndpoint: "t",
          jwksUri: "j",
        }),
        requestDeviceCode: async () => {
          throw new Error("n/a");
        },
        pollDeviceToken: async () => {
          throw new Error("n/a");
        },
        validateIdToken: async () => {
          throw new Error("n/a");
        },
        refreshTokens: async () => {
          throw new Error("offline");
        },
      },
    });
    await rt.revalidateSession(); // must not throw
    const s = store.getSession("https://acme");
    expect(s?.expiresAt).toBe(1000); // NOT advanced
    expect(s?.status).toBe("active"); // NOT forced to expired — grace governs validity
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("relying on grace window");
    // Grace semantics (isOperatorValid): with grace=1s, valid until expires_at(1000ms)+1000ms=2000ms.
    expect(isOperatorValid(store, "https://acme", 1500, 1)).toBe(true);
    expect(isOperatorValid(store, "https://acme", 3000, 1)).toBe(false);
  });
});
