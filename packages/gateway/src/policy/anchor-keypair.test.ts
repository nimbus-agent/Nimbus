import { beforeEach, describe, expect, it } from "bun:test";
import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  ensureAnchorKeypair,
  POLICY_SIGNING_PRIVKEY,
  POLICY_SIGNING_PUBKEY,
} from "./anchor-keypair.ts";

/**
 * Minimal in-memory NimbusVault. `ensureAnchorKeypair` only calls `get`/`set`;
 * `delete`/`listKeys` are stubbed to satisfy the interface and assert they are never used.
 */
class FakeVault implements NimbusVault {
  readonly store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(_key: string): Promise<void> {
    throw new Error("delete must not be called by ensureAnchorKeypair");
  }

  listKeys(_prefix?: string): Promise<string[]> {
    throw new Error("listKeys must not be called by ensureAnchorKeypair");
  }
}

describe("ensureAnchorKeypair", () => {
  let vault: FakeVault;

  beforeEach(() => {
    vault = new FakeVault();
  });

  it("generates and persists a fresh 32-byte keypair on first call (empty vault)", async () => {
    const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);

    // Both keys were persisted under the canonical vault keys.
    expect(vault.store.get(POLICY_SIGNING_PRIVKEY)).toBe(privkeyB64);
    expect(vault.store.get(POLICY_SIGNING_PUBKEY)).toBe(pubkeyB64);

    // Returned base64 values decode to exactly 32 bytes each (Ed25519 seed/pubkey).
    expect(decodeBase64(privkeyB64)).toHaveLength(32);
    expect(decodeBase64(pubkeyB64)).toHaveLength(32);
  });

  it("returns the same persisted values on a second call (no regeneration)", async () => {
    const first = await ensureAnchorKeypair(vault);
    const second = await ensureAnchorKeypair(vault);

    expect(second.privkeyB64).toBe(first.privkeyB64);
    expect(second.pubkeyB64).toBe(first.pubkeyB64);

    // Stored values are unchanged across the two calls.
    expect(vault.store.get(POLICY_SIGNING_PRIVKEY)).toBe(first.privkeyB64);
    expect(vault.store.get(POLICY_SIGNING_PUBKEY)).toBe(first.pubkeyB64);
  });

  it("regenerates a valid 32-byte pair when a persisted privkey is the wrong length", async () => {
    const badPriv = encodeBase64(new Uint8Array(10));
    const goodPub = encodeBase64(new Uint8Array(32).fill(7));
    await vault.set(POLICY_SIGNING_PRIVKEY, badPriv);
    await vault.set(POLICY_SIGNING_PUBKEY, goodPub);

    const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);

    expect(privkeyB64).not.toBe(badPriv);
    expect(decodeBase64(privkeyB64)).toHaveLength(32);
    expect(decodeBase64(pubkeyB64)).toHaveLength(32);
    expect(vault.store.get(POLICY_SIGNING_PRIVKEY)).toBe(privkeyB64);
    expect(vault.store.get(POLICY_SIGNING_PUBKEY)).toBe(pubkeyB64);
  });

  it("regenerates when a persisted pubkey is the wrong length (priv valid)", async () => {
    const goodPriv = encodeBase64(new Uint8Array(32).fill(3));
    const badPub = encodeBase64(new Uint8Array(5));
    await vault.set(POLICY_SIGNING_PRIVKEY, goodPriv);
    await vault.set(POLICY_SIGNING_PUBKEY, badPub);

    const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);

    expect(pubkeyB64).not.toBe(badPub);
    expect(decodeBase64(privkeyB64)).toHaveLength(32);
    expect(decodeBase64(pubkeyB64)).toHaveLength(32);
  });

  it("regenerates when a persisted value is not valid base64", async () => {
    await vault.set(POLICY_SIGNING_PRIVKEY, "!!! not base64 !!!");
    await vault.set(POLICY_SIGNING_PUBKEY, encodeBase64(new Uint8Array(32)));

    const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);

    expect(decodeBase64(privkeyB64)).toHaveLength(32);
    expect(decodeBase64(pubkeyB64)).toHaveLength(32);
    expect(vault.store.get(POLICY_SIGNING_PRIVKEY)).toBe(privkeyB64);
  });
});
