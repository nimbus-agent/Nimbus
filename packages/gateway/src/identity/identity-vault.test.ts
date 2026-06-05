// identity-vault.test.ts
import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  clearOidcTokens,
  IDENTITY_ID_TOKEN_KEY,
  IDENTITY_REFRESH_TOKEN_KEY,
  IDENTITY_SCIM_BEARER_KEY,
  readRefreshToken,
  readScimBearer,
  storeOidcTokens,
  writeScimBearer,
} from "./identity-vault.ts";

/** A Map-backed fake NimbusVault — no Vault backend, no key-format validation; round-trips raw bytes. */
function fakeVault(): { vault: NimbusVault; store: Map<string, string> } {
  const store = new Map<string, string>();
  const vault: NimbusVault = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async (prefix?: string) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
  return { vault, store };
}

describe("identity-vault key constants", () => {
  test("the three raw-token keys equal their expected literals", () => {
    expect(IDENTITY_ID_TOKEN_KEY).toBe("identity.oidc.id_token");
    expect(IDENTITY_REFRESH_TOKEN_KEY).toBe("identity.oidc.refresh_token");
    expect(IDENTITY_SCIM_BEARER_KEY).toBe("identity.scim.bearer");
  });
});

describe("storeOidcTokens", () => {
  test("with a refreshToken writes both the id-token and refresh-token keys", async () => {
    const { vault, store } = fakeVault();
    await storeOidcTokens(vault, { idToken: "id-tok", refreshToken: "ref-tok" });
    expect(store.get(IDENTITY_ID_TOKEN_KEY)).toBe("id-tok");
    expect(store.get(IDENTITY_REFRESH_TOKEN_KEY)).toBe("ref-tok");
  });

  test("without a refreshToken writes only the id-token key", async () => {
    const { vault, store } = fakeVault();
    await storeOidcTokens(vault, { idToken: "id-only" });
    expect(store.get(IDENTITY_ID_TOKEN_KEY)).toBe("id-only");
    expect(store.has(IDENTITY_REFRESH_TOKEN_KEY)).toBe(false);
  });
});

describe("readRefreshToken", () => {
  test("round-trips the stored refresh token", async () => {
    const { vault } = fakeVault();
    await storeOidcTokens(vault, { idToken: "id", refreshToken: "r1" });
    expect(await readRefreshToken(vault)).toBe("r1");
  });

  test("returns null when no refresh token is stored", async () => {
    const { vault } = fakeVault();
    expect(await readRefreshToken(vault)).toBeNull();
  });
});

describe("clearOidcTokens", () => {
  test("deletes both the id-token and refresh-token keys", async () => {
    const { vault, store } = fakeVault();
    await storeOidcTokens(vault, { idToken: "id", refreshToken: "r" });
    await writeScimBearer(vault, "bearer"); // unrelated key must survive
    await clearOidcTokens(vault);
    expect(store.has(IDENTITY_ID_TOKEN_KEY)).toBe(false);
    expect(store.has(IDENTITY_REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.get(IDENTITY_SCIM_BEARER_KEY)).toBe("bearer");
  });
});

describe("readScimBearer / writeScimBearer", () => {
  test("round-trips the SCIM bearer token", async () => {
    const { vault, store } = fakeVault();
    await writeScimBearer(vault, "scim-secret");
    expect(store.get(IDENTITY_SCIM_BEARER_KEY)).toBe("scim-secret");
    expect(await readScimBearer(vault)).toBe("scim-secret");
  });

  test("readScimBearer returns null when unset", async () => {
    const { vault } = fakeVault();
    expect(await readScimBearer(vault)).toBeNull();
  });
});
