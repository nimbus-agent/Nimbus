import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  _addTestKdfProfile,
  decryptVaultManifest,
  encryptVaultManifest,
} from "./data-vault-crypto.ts";

const PLAINTEXT = '[{"key":"github.pat","value":"secret_value_xyz"}]';
const PASSPHRASE = "correct horse battery staple";
const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const FAST_KDF = { t: 1, m: 1024, p: 1 } as const;

describe("envelope encryption", () => {
  let restoreKdf: () => void;
  beforeAll(() => {
    restoreKdf = _addTestKdfProfile({ ...FAST_KDF });
  });
  afterAll(() => {
    restoreKdf();
  });

  test("round-trips plaintext via passphrase", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    const out = decryptVaultManifest(blob, { passphrase: PASSPHRASE });
    expect(out).toBe(PLAINTEXT);
  });

  test("round-trips plaintext via seed", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    const out = decryptVaultManifest(blob, { seed: SEED });
    expect(out).toBe(PLAINTEXT);
  });

  test("wrong passphrase fails to decrypt", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    expect(() => decryptVaultManifest(blob, { passphrase: "wrong" })).toThrow();
  });

  test("tampered ciphertext is rejected by AES-GCM auth tag", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    const tampered = {
      ...blob,
      ciphertext: blob.ciphertext.replace(/^./, (c) => (c === "a" ? "b" : "a")),
    };
    expect(() => decryptVaultManifest(tampered, { passphrase: PASSPHRASE })).toThrow();
  });

  test("rejects when neither passphrase nor seed is provided", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    expect(() => decryptVaultManifest(blob, {})).toThrow(
      /either passphrase or seed must be provided/i,
    );
  });
});

describe("decryptVaultManifest — KDF allowlist (S2-F10)", () => {
  let restoreKdf: () => void;
  beforeAll(() => {
    restoreKdf = _addTestKdfProfile({ ...FAST_KDF });
  });
  afterAll(() => {
    restoreKdf();
  });

  test("rejects bundles with attacker-substituted weak KDF parameters", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    const tampered = { ...blob, kdf: { t: 1, m: 8, p: 1 } };
    expect(() => decryptVaultManifest(tampered, { passphrase: PASSPHRASE })).toThrow(
      /kdf params not in allowlist/i,
    );
  });

  test("rejects bundles with deeply weak KDF parameters", () => {
    const blob = encryptVaultManifest({
      plaintext: PLAINTEXT,
      passphrase: PASSPHRASE,
      seed: SEED,
      kdfParams: FAST_KDF,
    });
    const tampered = { ...blob, kdf: { t: 1, m: 1, p: 1 } };
    expect(() => decryptVaultManifest(tampered, { passphrase: PASSPHRASE })).toThrow(
      /kdf params not in allowlist/i,
    );
  });

  test("accepts the DEFAULT_KDF profile (production)", () => {
    const blob = encryptVaultManifest({
      plaintext: "x",
      passphrase: PASSPHRASE,
      seed: SEED,
    });
    const out = decryptVaultManifest(blob, { passphrase: PASSPHRASE });
    expect(out).toBe("x");
  }, 30_000);
});
