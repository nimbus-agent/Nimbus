import { describe, expect, it } from "bun:test";
import nacl from "tweetnacl";
import type { VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";
import { encodeBase64 } from "./base64.ts";
import { ensureVaultEd25519Keypair, generateEd25519Keypair } from "./ed25519.ts";

describe("generateEd25519Keypair", () => {
  it("returns a 32-byte seed and a 32-byte public key", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    expect(privkey).toHaveLength(32);
    expect(pubkey).toHaveLength(32);
  });

  it("returns a fresh keypair each call", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(Buffer.from(a.privkey).toString("hex")).not.toBe(Buffer.from(b.privkey).toString("hex"));
  });

  it("emits a seed tweetnacl expands to the SAME public key", () => {
    // The seed/pubkey pairing is the load-bearing property: the Vault stores the seed, and
    // `nacl.sign.keyPair.fromSeed` is what every signing site re-derives the pair from.
    const { privkey, pubkey } = generateEd25519Keypair();
    const derived = nacl.sign.keyPair.fromSeed(privkey);
    expect(Buffer.from(derived.publicKey).toString("hex")).toBe(
      Buffer.from(pubkey).toString("hex"),
    );
  });

  it("produces a keypair that round-trips a detached signature", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const pair = nacl.sign.keyPair.fromSeed(privkey);
    const msg = new TextEncoder().encode("nimbus");
    const sig = nacl.sign.detached(msg, pair.secretKey);
    expect(nacl.sign.detached.verify(msg, sig, pubkey)).toBe(true);
  });
});

const PRIV = "test.signing.privkey";
const PUB = "test.signing.pubkey";

/**
 * In-memory Vault holding only the two capabilities the resolver is typed against. `store` is
 * `unknown`-valued so a test can plant a value of the wrong TYPE, which a real Vault never
 * returns but a corrupted one is exactly what the resolver must survive.
 */
function memoryVault(): { vault: VaultReader & VaultWriter; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const vault: VaultReader & VaultWriter = {
    get: async (k) => (store.get(k) ?? null) as string | null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
  return { vault, store };
}

/** A stored pair is consistent when the pubkey is the one the seed derives. */
function derivesPubkey(privkeyB64: string, pubkeyB64: string): boolean {
  const seed = Buffer.from(privkeyB64, "base64");
  return encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey) === pubkeyB64;
}

describe("ensureVaultEd25519Keypair", () => {
  it("generates, stores under the GIVEN names and returns a consistent pair on first use", async () => {
    const { vault, store } = memoryVault();
    const kp = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    expect(Buffer.from(kp.privkeyB64, "base64")).toHaveLength(32);
    expect(Buffer.from(kp.pubkeyB64, "base64")).toHaveLength(32);
    expect(derivesPubkey(kp.privkeyB64, kp.pubkeyB64)).toBe(true);
    // Exactly the two caller-named keys and nothing else: the names are the caller's, never ours.
    expect([...store.keys()].sort()).toEqual([PRIV, PUB].sort());
    expect(store.get(PRIV)).toBe(kp.privkeyB64);
    expect(store.get(PUB)).toBe(kp.pubkeyB64);
  });

  it("reuses a stored consistent pair without rewriting it", async () => {
    const { vault, store } = memoryVault();
    const first = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    let writes = 0;
    const counting: VaultReader & VaultWriter = {
      get: vault.get,
      set: async (k, v) => {
        writes += 1;
        await vault.set(k, v);
      },
    };
    expect(await ensureVaultEd25519Keypair(counting, PRIV, PUB)).toEqual(first);
    expect(writes).toBe(0);
    expect(store.get(PRIV)).toBe(first.privkeyB64);
  });

  it("keeps two key-name pairs in one Vault independent", async () => {
    const { vault } = memoryVault();
    const a = await ensureVaultEd25519Keypair(vault, "a.privkey", "a.pubkey");
    const b = await ensureVaultEd25519Keypair(vault, "b.privkey", "b.pubkey");
    expect(b.privkeyB64).not.toBe(a.privkeyB64);
    expect(await ensureVaultEd25519Keypair(vault, "a.privkey", "a.pubkey")).toEqual(a);
    expect(await ensureVaultEd25519Keypair(vault, "b.privkey", "b.pubkey")).toEqual(b);
  });

  it("regenerates a mismatched pair (a seed from one keypair beside a pubkey from another)", async () => {
    const { vault, store } = memoryVault();
    const good = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    const foreign = await ensureVaultEd25519Keypair(memoryVault().vault, PRIV, PUB);
    store.set(PUB, foreign.pubkeyB64); // both halves are well-formed 32-byte keys
    const fixed = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    expect(fixed.privkeyB64).not.toBe(good.privkeyB64);
    expect(fixed.pubkeyB64).not.toBe(foreign.pubkeyB64);
    expect(derivesPubkey(fixed.privkeyB64, fixed.pubkeyB64)).toBe(true);
    expect(store.get(PRIV)).toBe(fixed.privkeyB64);
    expect(store.get(PUB)).toBe(fixed.pubkeyB64);
  });

  it.each([
    ["the privkey is missing", PRIV, null],
    ["the pubkey is missing", PUB, null],
    ["the privkey decodes to the wrong length", PRIV, encodeBase64(new Uint8Array(31))],
    ["the pubkey decodes to the wrong length", PUB, encodeBase64(new Uint8Array(33))],
    ["the privkey is not base64 at all", PRIV, "not-valid-base64-!!!"],
    ["the stored value is not even a string", PRIV, 12345],
  ])("regenerates instead of throwing when %s", async (_label, key, planted) => {
    const { vault, store } = memoryVault();
    const before = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    if (planted === null) store.delete(key);
    else store.set(key, planted);
    const after = await ensureVaultEd25519Keypair(vault, PRIV, PUB);
    expect(after.privkeyB64).not.toBe(before.privkeyB64);
    expect(derivesPubkey(after.privkeyB64, after.pubkeyB64)).toBe(true);
    expect(store.get(PRIV)).toBe(after.privkeyB64);
    expect(store.get(PUB)).toBe(after.pubkeyB64);
  });

  it("propagates a Vault read failure rather than minting over an unreadable entry", async () => {
    let wrote = false;
    const broken: VaultReader & VaultWriter = {
      get: async () => {
        throw new Error("keychain locked");
      },
      set: async () => {
        wrote = true;
      },
    };
    await expect(ensureVaultEd25519Keypair(broken, PRIV, PUB)).rejects.toThrow("keychain locked");
    expect(wrote).toBe(false);
  });
});
