import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import { readPublisherKey, writePublisherKey } from "../../../src/extensions/publisher-keys.ts";
import { createPublisherKeyFetcher } from "../../../src/extensions/registry-client.ts";
import { AirGapEnforcementError, syncPublisherKeys } from "../../../src/extensions/sync.ts";
import { encodeBase64, generateEd25519Keypair } from "../../../src/extensions/verify-signature.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb, stageSignedExtensionOnDisk } from "../../fixtures/extension.ts";

describe("syncPublisherKeys end-to-end with mock HTTP registry (T2 PR 2 Task 23)", () => {
  const publishers = new Map<string, string>();
  let server: Server;
  let baseUrl = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const m = /^\/publishers\/([a-z0-9._-]+)\.key$/.exec(u.pathname);
        if (m === null) return new Response("not found", { status: 404 });
        const key = publishers.get(m[1] ?? "");
        if (key === undefined) return new Response("not found", { status: 404 });
        return new Response(key, { status: 200 });
      },
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("registry serves the cached key → publishersUnchanged", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "registry-pub", pubkey);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "registry-pub",
      pubkey,
      privkey,
    });
    publishers.set("registry-pub", encodeBase64(pubkey));

    const fetcher = createPublisherKeyFetcher({ baseUrl });
    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher,
      enforceAirGap: false,
    });
    expect(result.publishersChecked).toBe(1);
    expect(result.publishersUnchanged).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("registry serves rotated key → cache rewritten + re-verify fails on old signature", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey: oldPub } = generateEd25519Keypair();
    const newPub = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "rotated-pub", oldPub);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "rotated-pub",
      pubkey: oldPub,
      privkey,
    });
    publishers.set("rotated-pub", encodeBase64(newPub));

    const fetcher = createPublisherKeyFetcher({ baseUrl });
    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher,
      enforceAirGap: false,
    });
    expect(result.publishersUpdated).toHaveLength(1);
    expect(result.publishersUpdated[0]!.id).toBe("rotated-pub");
    expect(result.publishersUpdated[0]!.reverifyResult).toBe("failed");
    const cached = await readPublisherKey(vault, "rotated-pub");
    expect(cached).toEqual(newPub);
  });

  test("registry 404 → cache evicted", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "deleted-pub", pubkey);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "deleted-pub",
      pubkey,
      privkey,
    });

    const fetcher = createPublisherKeyFetcher({ baseUrl });
    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher,
      enforceAirGap: false,
    });
    expect(result.publishersEvicted).toEqual(["deleted-pub"]);
    expect(await readPublisherKey(vault, "deleted-pub")).toBeUndefined();
  });

  test("air-gap enforced → AirGapEnforcementError thrown", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    const fetcher = createPublisherKeyFetcher({ baseUrl });
    await expect(syncPublisherKeys({ vault, db, fetcher, enforceAirGap: true })).rejects.toThrow(
      AirGapEnforcementError,
    );
  });
});
