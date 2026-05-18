import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";

import { listExtensions } from "../../../src/automation/extension-store.ts";
import { signatureDisabledRegistry } from "../../../src/extensions/hard-disable.ts";
import { installExtensionFromLocalDirectory } from "../../../src/extensions/install-from-local.ts";
import { readPublisherKey } from "../../../src/extensions/publisher-keys.ts";
import { verifyExtensionsBestEffort } from "../../../src/extensions/verify-extensions.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../../../src/extensions/verify-signature.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

const silentLogger = pino({ level: "silent" });

describe("Signed install round-trip integration (T2 PR 2 Task 22)", () => {
  test("keygen → sign → install --publisher-key → startup verify → list shows publisher", async () => {
    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();

    // 1. keygen (in-process — equivalent to `nimbus extension keygen`)
    const { privkey, pubkey } = generateEd25519Keypair();

    // 2. write a signed manifest in a source directory
    const sourceDir = mkdtempSync(join(tmpdir(), "nimbus-roundtrip-src-"));
    try {
      mkdirSync(join(sourceDir, "dist"), { recursive: true });
      const baseManifest = {
        id: "roundtrip-ext",
        version: "1.0.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(pubkey) },
      };
      // 3. sign (equivalent to `nimbus extension sign`)
      const signature = await signManifest(baseManifest, privkey);
      writeFileSync(
        join(sourceDir, "nimbus.extension.json"),
        JSON.stringify({ ...baseManifest, signature }),
      );
      writeFileSync(join(sourceDir, "dist", "index.js"), "export default {};");

      // 4. install with explicit --publisher-key path
      const keyDir = mkdtempSync(join(tmpdir(), "nimbus-roundtrip-key-"));
      try {
        const keyFile = join(keyDir, "pub.key");
        writeFileSync(keyFile, `${encodeBase64(pubkey)}\n`);

        const installResult = await installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: sourceDir,
          vault,
          fetcher: { fetch: async () => ({ kind: "not_found" }) },
          enforceAirGap: false,
          publisherKeyPath: keyFile,
        });
        expect(installResult.id).toBe("roundtrip-ext");

        // 5. publisher key is now in the vault cache
        expect(await readPublisherKey(vault, "test-pub")).toEqual(pubkey);

        // 6. startup verify pass keeps the extension enabled
        await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
        const row = listExtensions(db).find((r) => r.id === "roundtrip-ext");
        expect(row?.enabled).toBe(1);
        expect(signatureDisabledRegistry.has("roundtrip-ext")).toBe(false);

        // 7. on-disk manifest still carries the publisher block
        const installedManifest = JSON.parse(
          readFileSync(join(extensionsDir, "roundtrip-ext", "nimbus.extension.json"), "utf8"),
        ) as { publisher: { id: string } };
        expect(installedManifest.publisher.id).toBe("test-pub");
      } finally {
        rmSync(keyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("install with --publisher-key matching the registry but not the signer fails", async () => {
    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey: signerPriv, pubkey: signerPub } = generateEd25519Keypair();
    const wrongPub = generateEd25519Keypair().pubkey;

    const sourceDir = mkdtempSync(join(tmpdir(), "nimbus-mismatch-src-"));
    const keyDir = mkdtempSync(join(tmpdir(), "nimbus-mismatch-key-"));
    try {
      mkdirSync(join(sourceDir, "dist"), { recursive: true });
      const baseManifest = {
        id: "mismatch-ext",
        version: "1.0.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(signerPub) },
      };
      const signature = await signManifest(baseManifest, signerPriv);
      writeFileSync(
        join(sourceDir, "nimbus.extension.json"),
        JSON.stringify({ ...baseManifest, signature }),
      );
      writeFileSync(join(sourceDir, "dist", "index.js"), "export default {};");

      const keyFile = join(keyDir, "pub.key");
      writeFileSync(keyFile, `${encodeBase64(wrongPub)}\n`);

      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: sourceDir,
          vault,
          fetcher: { fetch: async () => ({ kind: "not_found" }) },
          enforceAirGap: false,
          publisherKeyPath: keyFile,
        }),
      ).rejects.toThrow();

      // No DB row should exist (install was rolled back)
      expect(listExtensions(db).find((r) => r.id === "mismatch-ext")).toBeUndefined();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});
