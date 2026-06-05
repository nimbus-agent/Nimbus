// identity-boot.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { NimbusIdentityToml, NimbusScimToml } from "../config/nimbus-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildIdentityBoot } from "./identity-boot.ts";
import { IDENTITY_SCIM_BEARER_KEY } from "./identity-vault.ts";

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
const SCIM: NimbusScimToml = { enabled: true };

function freshIndex(): LocalIndex {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return new LocalIndex(db);
}

function fakeVault(): { vault: NimbusVault; store: Map<string, string> } {
  const m = new Map<string, string>();
  const vault: NimbusVault = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    listKeys: async () => [...m.keys()],
  };
  return { vault, store: m };
}

describe("buildIdentityBoot", () => {
  test("exposes config-derived fields", () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(boot.enabled).toBe(true);
    expect(boot.issuer).toBe("https://acme");
    expect(boot.graceSeconds).toBe(1000);
  });

  test("resolveScimToken returns '' when no bearer is stored", async () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(await boot.resolveScimToken()).toBe("");
  });

  test("resolveScimToken returns the stored bearer when set", async () => {
    const { vault, store } = fakeVault();
    store.set(IDENTITY_SCIM_BEARER_KEY, "scim-secret");
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(await boot.resolveScimToken()).toBe("scim-secret");
  });

  test("startLogin returns a string jobId synchronously (background failure is isolated)", () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    const handle = boot.startLogin();
    expect(typeof handle.jobId).toBe("string");
    expect(handle.jobId.startsWith("identity-login")).toBe(true);
  });

  test("bindLoginNotify is a no-op-safe binder", () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(() => boot.bindLoginNotify(() => {})).not.toThrow();
  });
});
