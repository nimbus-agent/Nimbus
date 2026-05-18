import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

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
    writeFileSync(file, encodeBase64(fileKey) + "\n");
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
});
