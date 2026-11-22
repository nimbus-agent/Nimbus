import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I16 — Verified-publisher invariant", () => {
  test("static: install-from-local.ts and verify-extensions.ts both call verifyManifestSignature", async () => {
    const install = await read("packages/gateway/src/extensions/install-from-local.ts");
    const verify = await read("packages/gateway/src/extensions/verify-extensions.ts");
    expect(install).toContain("verifyManifestSignature(");
    expect(verify).toContain("verifyManifestSignature(");
  });

  test("behavioral #1: signed extension with missing vault key is hard-disabled at startup", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pino = (await import("pino")).default;

    const { insertExtensionRow, listExtensions } = await import("../automation/extension-store.ts");
    const { signatureDisabledRegistry } = await import("../extensions/hard-disable.ts");
    const { encodeBase64, generateEd25519Keypair, signManifest } = await import(
      "../extensions/verify-signature.ts"
    );
    const { verifyExtensionsBestEffort } = await import("../extensions/verify-extensions.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const { setupFreshExtensionDb } = await import("../../test/fixtures/extension.ts");

    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    const id = "test-ext-missing-key";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = {
      id,
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(pubkey) },
    };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    const entryText = "export default {};";
    writeFileSync(join(dir, "dist", "index.js"), entryText);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });

    try {
      await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
      expect(signatureDisabledRegistry.reasonFor(id)).toBe("publisher_key_missing");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("behavioral #2: tampered manifest is hard-disabled at startup with signature_failed", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pino = (await import("pino")).default;

    const { insertExtensionRow, listExtensions } = await import("../automation/extension-store.ts");
    const { dbRun } = await import("../db/write.ts");
    const { signatureDisabledRegistry } = await import("../extensions/hard-disable.ts");
    const { writePublisherKey } = await import("../extensions/publisher-keys.ts");
    const { encodeBase64, generateEd25519Keypair, signManifest } = await import(
      "../extensions/verify-signature.ts"
    );
    const { verifyExtensionsBestEffort } = await import("../extensions/verify-extensions.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const { setupFreshExtensionDb } = await import("../../test/fixtures/extension.ts");

    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const id = "test-ext-tampered";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = {
      id,
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(pubkey) },
    };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    const entryText = "export default {};";
    writeFileSync(join(dir, "dist", "index.js"), entryText);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    const tampered = Buffer.from(JSON.stringify({ ...base, version: "9.9.9", signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), tampered);
    const newHash = createHash("sha256").update(tampered).digest("hex");
    dbRun(db, "UPDATE extension SET manifest_hash = ? WHERE id = ?", [newHash, id]);

    try {
      await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
      expect(signatureDisabledRegistry.reasonFor(id)).toBe("signature_failed");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});
