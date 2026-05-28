import { describe, expect, it } from "bun:test";

import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { MockVault } from "../vault/mock.ts";
import { readPublisherKey, writePublisherKey } from "./publisher-keys.ts";
import { AirGapEnforcementError, syncPublisherKeys } from "./sync.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

describe("syncPublisherKeys", () => {
  it("unchanged: cached key equals registry key → publishersUnchanged++", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
      enforceAirGap: false,
    });
    expect(result.publishersChecked).toBe(1);
    expect(result.publishersUnchanged).toBe(1);
    expect(result.publishersUpdated).toEqual([]);
  });

  it("updated: registry serves new key → cache rewritten + reverify runs", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const old = generateEd25519Keypair().pubkey;
    const fresh = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "pub-a", old);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey: old });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: fresh }) },
      enforceAirGap: false,
    });
    expect(result.publishersUpdated).toHaveLength(1);
    expect(result.publishersUpdated[0]!.id).toBe("pub-a");
    expect(result.publishersUpdated[0]!.reverifyResult).toBe("failed");
  });

  it("evicted: registry 404 → cache deleted", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "not_found" }) },
      enforceAirGap: false,
    });
    expect(result.publishersEvicted).toEqual(["pub-a"]);
  });

  it("failed: registry transient → recorded but cache untouched", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "transient", message: "ECONNREFUSED" }) },
      enforceAirGap: false,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("pub-a");
  });

  it("dry-run: no vault writes, no audit", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const old = generateEd25519Keypair().pubkey;
    const fresh = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "pub-a", old);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey: old });

    await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: fresh }) },
      enforceAirGap: false,
      dryRun: true,
    });
    const cached = await readPublisherKey(vault, "pub-a");
    expect(cached).toBeDefined();
    expect(encodeBase64(cached!)).toBe(encodeBase64(old));
  });

  it("air-gap: throws AirGapEnforcementError", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    await expect(
      syncPublisherKeys({
        vault,
        db,
        fetcher: { fetch: async () => ({ kind: "ok", pubkey: new Uint8Array(32) }) },
        enforceAirGap: true,
      }),
    ).rejects.toThrow(AirGapEnforcementError);
  });

  it("no installed extensions with publishers → empty result", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: new Uint8Array(32) }) },
      enforceAirGap: false,
    });
    expect(result.publishersChecked).toBe(0);
  });
});
