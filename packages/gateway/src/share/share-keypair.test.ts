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
    expect(Buffer.from(kp.pubkeyB64, "base64")).toHaveLength(32);
    expect(v.store.get(SHARE_SIGNING_PRIVKEY)).toBe(kp.privkeyB64);
    expect(v.store.get(SHARE_SIGNING_PUBKEY)).toBe(kp.pubkeyB64);
  });
  test("reuses persisted material on subsequent calls", async () => {
    const v = fakeVault();
    const a = await ensureShareKeypair(v.vault);
    const b = await ensureShareKeypair(v.vault);
    expect(b).toEqual(a);
  });
  test("regenerates when the persisted pubkey does not match the persisted privkey", async () => {
    const v = fakeVault();
    const a = await ensureShareKeypair(v.vault);
    // Corrupt the Vault: keep a's privkey but replace the pubkey with a DIFFERENT valid 32-byte key.
    const other = await ensureShareKeypair(fakeVault().vault);
    await v.vault.set(SHARE_SIGNING_PUBKEY, other.pubkeyB64);
    const b = await ensureShareKeypair(v.vault);
    // The mismatched pair is rejected and a fresh, self-consistent keypair is generated + stored.
    expect(b.privkeyB64).not.toBe(a.privkeyB64);
    expect(v.store.get(SHARE_SIGNING_PRIVKEY)).toBe(b.privkeyB64);
    expect(v.store.get(SHARE_SIGNING_PUBKEY)).toBe(b.pubkeyB64);
  });
});
