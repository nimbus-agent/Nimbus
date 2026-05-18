import { describe, expect, it } from "bun:test";

import { MockVault } from "../vault/mock.ts";
import {
  evictPublisherKey,
  listCachedPublisherIds,
  PUBLISHER_KEY_VAULT_PREFIX,
  readPublisherKey,
  writePublisherKey,
} from "./publisher-keys.ts";
import { generateEd25519Keypair } from "./verify-signature.ts";

describe("publisher-keys vault cache", () => {
  it("write then read returns the same 32-byte pubkey", async () => {
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const out = await readPublisherKey(vault, "test-pub");
    expect(out).toEqual(pubkey);
  });

  it("read returns undefined when no entry", async () => {
    const vault = new MockVault();
    expect(await readPublisherKey(vault, "absent")).toBeUndefined();
  });

  it("evict removes the entry", async () => {
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    await evictPublisherKey(vault, "test-pub");
    expect(await readPublisherKey(vault, "test-pub")).toBeUndefined();
  });

  it("list returns sorted publisher ids", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "b-pub", k);
    await writePublisherKey(vault, "a-pub", k);
    await writePublisherKey(vault, "c-pub", k);
    const out = await listCachedPublisherIds(vault);
    expect(out).toEqual(["a-pub", "b-pub", "c-pub"]);
  });

  it("vault keys live under the documented prefix", () => {
    expect(PUBLISHER_KEY_VAULT_PREFIX).toBe("extension.publisher_key.");
  });

  it("rejects writing a non-32-byte pubkey", async () => {
    const vault = new MockVault();
    await expect(writePublisherKey(vault, "test-pub", new Uint8Array(31))).rejects.toThrow();
  });
});
