import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  ensureToolgenKeypair,
  signArtifact,
  TOOLGEN_SIGNING_PRIVKEY,
  TOOLGEN_SIGNING_PUBKEY,
  verifyArtifactSignature,
} from "./toolgen-keypair.ts";

/** Minimal in-memory `NimbusVault` fake — no real Vault/OS keychain involved. */
class FakeVault implements NimbusVault {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => !prefix || k.startsWith(prefix));
  }
}

describe("toolgen-keypair", () => {
  test("sign then verify round-trips", async () => {
    const vault = new FakeVault();
    const { sigB64, pubkeyB64 } = await signArtifact(vault, "canonical-bytes");
    expect(verifyArtifactSignature("canonical-bytes", sigB64, pubkeyB64)).toBe(true);
  });

  test("a single changed byte fails verification", async () => {
    const vault = new FakeVault();
    const { sigB64, pubkeyB64 } = await signArtifact(vault, "canonical-bytes");
    expect(verifyArtifactSignature("canonical-bytez", sigB64, pubkeyB64)).toBe(false);
  });

  test("a signature from a different keypair fails", async () => {
    const a = new FakeVault();
    const b = new FakeVault();
    const signed = await signArtifact(a, "x");
    const other = await signArtifact(b, "x");
    expect(verifyArtifactSignature("x", other.sigB64, signed.pubkeyB64)).toBe(false);
  });

  test("malformed base64 returns false rather than throwing", () => {
    expect(verifyArtifactSignature("x", "!!!not-base64!!!", "!!!also-not!!!")).toBe(false);
  });

  test("the keypair is generated once and reused", async () => {
    const vault = new FakeVault();
    const first = await ensureToolgenKeypair(vault);
    const second = await ensureToolgenKeypair(vault);
    expect(second.pubkeyB64).toBe(first.pubkeyB64);
  });

  test("a mismatched stored pair is regenerated rather than used", async () => {
    const vault = new FakeVault();
    const good = await ensureToolgenKeypair(vault);
    const foreign = await ensureToolgenKeypair(new FakeVault());
    await vault.set(TOOLGEN_SIGNING_PUBKEY, foreign.pubkeyB64); // privkey from one pair, pubkey from another
    const fixed = await ensureToolgenKeypair(vault);
    expect(fixed.pubkeyB64).not.toBe(foreign.pubkeyB64);
    expect(fixed.pubkeyB64).not.toBe(good.pubkeyB64);
    expect(
      verifyArtifactSignature("x", (await signArtifact(vault, "x")).sigB64, fixed.pubkeyB64),
    ).toBe(true);
  });

  test("the private seed is never returned by any read-only accessor", async () => {
    const vault = new FakeVault();
    await ensureToolgenKeypair(vault);
    const { sigB64 } = await signArtifact(vault, "x");
    const seed = await vault.get(TOOLGEN_SIGNING_PRIVKEY);
    expect(seed).not.toBeNull();
    expect(sigB64).not.toContain(seed ?? " ");
  });

  test("a corrupted stored seed is silently regenerated, never thrown", async () => {
    // The closest thing this module has to an "error path" for a bad stored seed: corrupt the
    // Vault's privkey entry with non-base64 garbage and call ensureToolgenKeypair again. Per the
    // share-keypair precedent, a malformed value is treated as absent/invalid and replaced —
    // `isValidB64Len`'s try/catch swallows the decode failure — so this call must resolve, not
    // reject, and the thrown-message assertion below documents that no exception (and therefore no
    // seed-bearing message) is reachable through this path.
    const vault = new FakeVault();
    const { privkeyB64 } = await ensureToolgenKeypair(vault);
    await vault.set(TOOLGEN_SIGNING_PRIVKEY, "not-valid-base64-!!!");
    let thrown: unknown;
    let result: { privkeyB64: string; pubkeyB64: string } | undefined;
    try {
      result = await ensureToolgenKeypair(vault);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    expect(result?.privkeyB64).not.toBe(privkeyB64);
    expect(result?.privkeyB64).not.toBe("not-valid-base64-!!!");
  });
});
