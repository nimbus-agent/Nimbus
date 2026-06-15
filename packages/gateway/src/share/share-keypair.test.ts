import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  ensureShareKeypair,
  SHARE_SIGNING_PRIVKEY,
  SHARE_SIGNING_PUBKEY,
} from "./share-keypair.ts";

function fakeVault() {
  const m = new Map<string, string>();
  const vault: NimbusVault = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    listKeys: async () => [...m.keys()],
  };
  return { store: m, vault };
}

describe("ensureShareKeypair", () => {
  test("generates and persists a 32-byte keypair on first call", async () => {
    const v = fakeVault();
    const kp = await ensureShareKeypair(v.vault);
    expect(Buffer.from(kp.pubkeyB64, "base64").length).toBe(32);
    expect(v.store.get(SHARE_SIGNING_PRIVKEY)).toBe(kp.privkeyB64);
    expect(v.store.get(SHARE_SIGNING_PUBKEY)).toBe(kp.pubkeyB64);
  });
  test("reuses persisted material on subsequent calls", async () => {
    const v = fakeVault();
    const a = await ensureShareKeypair(v.vault);
    const b = await ensureShareKeypair(v.vault);
    expect(b).toEqual(a);
  });
});
