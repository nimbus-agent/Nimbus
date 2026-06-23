import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusVault } from "../vault/index.ts";
import { MockVault } from "../vault/mock.ts";
import {
  AirGapNoPublisherKey,
  evictPublisherKey,
  listCachedPublisherIds,
  PUBLISHER_KEY_VAULT_PREFIX,
  PublisherNotRegistered,
  RegistryUnreachable,
  readPublisherKey,
  resolvePublisherKey,
  writePublisherKey,
} from "./publisher-keys.ts";
import { decodeBase64, encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

const fakeFetcher = (result: import("./registry-client.ts").PublisherKeyFetchResult) => ({
  fetch: async () => result,
});

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
        fetcher: fakeFetcher({ kind: "ok", pubkey: generateEd25519Keypair().pubkey }),
        enforceAirGap: false,
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
      fetcher: fakeFetcher({ kind: "not_found" }),
      enforceAirGap: false,
    });
    expect(out).toEqual(cachedKey);
  });

  it("priority 3: registry fetch when neither flag nor cache", async () => {
    const vault = new MockVault();
    const regKey = generateEd25519Keypair().pubkey;
    const out = await resolvePublisherKey({
      publisherId: "test-pub",
      explicitKeyPath: undefined,
      vault,
      fetcher: fakeFetcher({ kind: "ok", pubkey: regKey }),
      enforceAirGap: false,
    });
    expect(out).toEqual(regKey);
  });

  it("air-gap: throws AirGapNoPublisherKey when no flag + no cache", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "ok", pubkey: generateEd25519Keypair().pubkey }),
        enforceAirGap: true,
      }),
    ).rejects.toThrow(AirGapNoPublisherKey);
  });

  it("registry 404 surfaces PublisherNotRegistered", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "not_found" }),
        enforceAirGap: false,
      }),
    ).rejects.toThrow(PublisherNotRegistered);
  });

  it("registry unreachable surfaces RegistryUnreachable", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "transient", message: "ECONNREFUSED" }),
        enforceAirGap: false,
      }),
    ).rejects.toThrow(RegistryUnreachable);
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
          fetcher: fakeFetcher({ kind: "not_found" }),
          enforceAirGap: false,
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
        fetcher: fakeFetcher({ kind: "not_found" }),
        enforceAirGap: false,
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
          fetcher: fakeFetcher({ kind: "not_found" }),
          enforceAirGap: false,
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
          fetcher: fakeFetcher({ kind: "not_found" }),
          enforceAirGap: false,
        }),
      ).rejects.toThrow(/did not decode to 32 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // lines 113-116: registry_error kind → RegistryUnreachable with statusCode in message
  it("fetcher registry_error throws RegistryUnreachable with statusCode", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({
          kind: "registry_error",
          statusCode: 429,
          message: "Too Many Requests",
        }),
        enforceAirGap: false,
      }),
    ).rejects.toThrow(RegistryUnreachable);
  });

  it("fetcher registry_error message includes statusCode", async () => {
    const vault = new MockVault();
    let caughtErr: unknown;
    try {
      await resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({
          kind: "registry_error",
          statusCode: 429,
          message: "Too Many Requests",
        }),
        enforceAirGap: false,
      });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(RegistryUnreachable);
    expect((caughtErr as RegistryUnreachable).message).toContain("429");
  });
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

describe("listCachedPublisherIds: prefix filter FALSE arm", () => {
  // line 43: k.startsWith(PREFIX) === false → key is filtered out
  // MockVault.listKeys already filters by prefix, so we need a custom vault that returns
  // a non-prefixed key alongside prefixed ones to exercise the defensive branch.
  it("filters out keys that do not start with the publisher key prefix", async () => {
    // Build a custom NimbusVault that returns one non-prefixed key plus one prefixed key
    const innerVault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await innerVault.set(`${PUBLISHER_KEY_VAULT_PREFIX}alpha`, encodeBase64(pubkey));

    const customVault: NimbusVault = {
      get: (k) => innerVault.get(k),
      set: (k, v) => innerVault.set(k, v),
      delete: (k) => innerVault.delete(k),
      // Returns both the valid prefixed key AND a foreign key that should be filtered out
      listKeys: async (_prefix?: string) => [
        `${PUBLISHER_KEY_VAULT_PREFIX}alpha`,
        "some.other.key.that.has.no.prefix",
      ],
    };

    const result = await listCachedPublisherIds(customVault);
    // Only the prefixed key contributes; the foreign key must be absent
    expect(result).toEqual(["alpha"]);
    expect(result).not.toContain("some.other.key.that.has.no.prefix");
  });

  it("returns sorted ids when multiple prefixed keys are present", async () => {
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "zed", pubkey);
    await writePublisherKey(vault, "alice", pubkey);
    await writePublisherKey(vault, "bob", pubkey);
    const result = await listCachedPublisherIds(vault);
    expect(result).toEqual(["alice", "bob", "zed"]);
  });
});
