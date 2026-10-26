import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import { MockVault } from "../vault/mock.ts";
import {
  evictPublisherKey,
  listTrustedPublisherKeys,
  PUBLISHER_KEY_FP_VAULT_PREFIX,
  PUBLISHER_KEY_VAULT_PREFIX,
  PublisherKeyRequired,
  readPublisherKey,
  readPublisherKeyFor,
  resolvePublisherKey,
  writePublisherKey,
  writePublisherKeyFor,
} from "./publisher-keys.ts";
import { decodeBase64, encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

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

  it("vault keys live under the documented prefix", () => {
    expect(PUBLISHER_KEY_VAULT_PREFIX).toBe("extension.publisher_key.");
  });

  it("rejects writing a non-32-byte pubkey", async () => {
    const vault = new MockVault();
    await expect(writePublisherKey(vault, "test-pub", new Uint8Array(31))).rejects.toThrow();
  });
});

describe("resolvePublisherKey", () => {
  it("priority 1: --publisher-key path takes precedence", async () => {
    const vault = new MockVault();
    const fileKey = generateEd25519Keypair().pubkey;
    const cachedKey = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "test-pub", cachedKey);

    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    writeFileSync(file, `${encodeBase64(fileKey)}\n`);
    try {
      const out = await resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: file,
        vault,
      });
      expect(out).toEqual(fileKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("priority 2: vault cache used when no --publisher-key", async () => {
    const vault = new MockVault();
    const cachedKey = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "test-pub", cachedKey);
    const out = await resolvePublisherKey({
      publisherId: "test-pub",
      explicitKeyPath: undefined,
      vault,
    });
    expect(out).toEqual(cachedKey);
  });

  it("no flag + no cache throws PublisherKeyRequired naming --publisher-key (nothing is fetched)", async () => {
    const vault = new MockVault();
    const err = await resolvePublisherKey({
      publisherId: "test-pub",
      explicitKeyPath: undefined,
      vault,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublisherKeyRequired);
    expect((err as Error).message).toContain("--publisher-key");
    expect((err as Error).message).toContain('"test-pub"');
  });
  it("explicit key path with malformed body surfaces clear error", async () => {
    const vault = new MockVault();
    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    writeFileSync(file, "not-base64-of-32-bytes");
    try {
      await expect(
        resolvePublisherKey({
          publisherId: "test-pub",
          explicitKeyPath: file,
          vault,
        }),
      ).rejects.toThrow(/publisher key file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // lines 89-90: readFileSync throws → "could not be read" error (both instanceof Error branch)
  it("explicit key path that does not exist throws 'could not be read'", async () => {
    const vault = new MockVault();
    const nonExistentPath = join(tmpdir(), "nimbus-no-such-file-12345.key");
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: nonExistentPath,
        vault,
      }),
    ).rejects.toThrow(/could not be read/);
  });

  // lines 93-97: trimmed length !== 44 → "must contain exactly 44 base64 chars"
  it("explicit key path with wrong trimmed length throws length error", async () => {
    const vault = new MockVault();
    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    // 10 chars — well under 44
    writeFileSync(file, "AAAAAAAAAA");
    try {
      await expect(
        resolvePublisherKey({
          publisherId: "test-pub",
          explicitKeyPath: file,
          vault,
        }),
      ).rejects.toThrow(/must contain exactly 44 base64 chars/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // lines 99-100: 44-char base64 that decodes to 33 bytes (not 32) → "did not decode to 32 bytes"
  // encodeBase64(33-byte buffer) produces exactly 44 chars with no padding (33 = 11*3 → 44 base64 chars)
  it("explicit key path with 44-char base64 decoding to 33 bytes throws decode error", async () => {
    const vault = new MockVault();
    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    const thirtyThreeBytes = new Uint8Array(33);
    const b64 = encodeBase64(thirtyThreeBytes);
    // Verify our premise: exactly 44 base64 chars (no padding) that decode to 33 bytes.
    expect(b64).toHaveLength(44);
    expect(decodeBase64(b64)).toHaveLength(33);
    writeFileSync(file, b64);
    try {
      await expect(
        resolvePublisherKey({
          publisherId: "test-pub",
          explicitKeyPath: file,
          vault,
        }),
      ).rejects.toThrow(/did not decode to 32 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // lines 113-116: registry_error kind → RegistryUnreachable with statusCode in message
});

describe("readPublisherKey branch: non-32-byte cached value", () => {
  // line 20: bytes.length !== 32 → returns undefined
  it("returns undefined when cached base64 decodes to non-32 bytes", async () => {
    const vault = new MockVault();
    // Store a base64 of a 16-byte buffer directly (bypassing writePublisherKey which enforces 32)
    const sixteenBytes = new Uint8Array(16);
    await vault.set(`${PUBLISHER_KEY_VAULT_PREFIX}test-pub`, encodeBase64(sixteenBytes));
    const result = await readPublisherKey(vault, "test-pub");
    expect(result).toBeUndefined();
  });
});

describe("per-fingerprint publisher keys (rotation)", () => {
  const fpOf = (k: Uint8Array): string => publisherKeyFingerprint(encodeBase64(k));

  it("writes under the fingerprint, and as the legacy key only when there was none", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    const x = generateEd25519Keypair().pubkey;
    expect(await writePublisherKeyFor(vault, "acme", k)).toBe(fpOf(k));
    await writePublisherKeyFor(vault, "acme", x);
    // A rotation never overwrites the legacy key that older rows verify with.
    expect(await readPublisherKey(vault, "acme")).toEqual(k);
    expect(await readPublisherKeyFor(vault, "acme", fpOf(x))).toEqual(x);
    expect(await readPublisherKeyFor(vault, "acme", fpOf(k))).toEqual(k);
    expect(await readPublisherKeyFor(vault, "acme", null)).toEqual(k);
  });

  it("falls back to the legacy key only when it has the asked fingerprint", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "acme", k); // a pre-rotation install: legacy only
    expect(await readPublisherKeyFor(vault, "acme", fpOf(k))).toEqual(k);
    expect(await readPublisherKeyFor(vault, "acme", "0".repeat(32))).toBeUndefined();
    expect(await readPublisherKeyFor(vault, "acme", "not-a-fingerprint")).toBeUndefined();
  });

  it("refuses a per-fingerprint entry whose bytes have another fingerprint", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    const other = generateEd25519Keypair().pubkey;
    await vault.set(`${PUBLISHER_KEY_FP_VAULT_PREFIX}${fpOf(k)}.acme`, encodeBase64(other));
    expect(await readPublisherKeyFor(vault, "acme", fpOf(k))).toBeUndefined();
  });

  it("lists every trusted key for a publisher, a dotted id kept apart from its prefix", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    const x = generateEd25519Keypair().pubkey;
    const y = generateEd25519Keypair().pubkey;
    await writePublisherKeyFor(vault, "acme", k);
    await writePublisherKeyFor(vault, "acme", x);
    await writePublisherKeyFor(vault, "acme.labs", y);
    expect(await listTrustedPublisherKeys(vault, "acme")).toEqual(
      [encodeBase64(k), encodeBase64(x)].sort((a, b) => a.localeCompare(b)),
    );
    expect(await listTrustedPublisherKeys(vault, "acme.labs")).toEqual([encodeBase64(y)]);
    expect(await listTrustedPublisherKeys(vault, "nobody")).toEqual([]);
  });

  it("evict removes the legacy key and every per-fingerprint key, nobody else's", async () => {
    const vault = new MockVault();
    await writePublisherKeyFor(vault, "acme", generateEd25519Keypair().pubkey);
    await writePublisherKeyFor(vault, "acme", generateEd25519Keypair().pubkey);
    await writePublisherKeyFor(vault, "acme.labs", generateEd25519Keypair().pubkey);
    await evictPublisherKey(vault, "acme");
    expect(await listTrustedPublisherKeys(vault, "acme")).toEqual([]);
    expect(await listTrustedPublisherKeys(vault, "acme.labs")).toHaveLength(1);
  });

  it("a local install with no key file finds the cached key with the DECLARED fingerprint", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    const x = generateEd25519Keypair().pubkey;
    await writePublisherKeyFor(vault, "acme", k);
    await writePublisherKeyFor(vault, "acme", x);
    expect(
      await resolvePublisherKey({
        publisherId: "acme",
        explicitKeyPath: undefined,
        vault,
        declaredKey: encodeBase64(x),
      }),
    ).toEqual(x);
  });
});
