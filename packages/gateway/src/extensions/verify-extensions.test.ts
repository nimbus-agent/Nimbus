import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { dbRun } from "../db/write.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { writePublisherKey } from "./publisher-keys.ts";
import { verifyExtensionsBestEffort, verifyOneExtensionStrict } from "./verify-extensions.ts";
import { generateEd25519Keypair } from "./verify-signature.ts";

function memoryLogger(): { logger: Logger; warns: unknown[]; errors: unknown[] } {
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  const logger = {
    warn: (o: unknown, msg?: string) => {
      warns.push({ o, msg });
    },
    error: (o: unknown, msg?: string) => {
      errors.push({ o, msg });
    },
  } as Logger;
  return { logger, warns, errors };
}

function makeExtensionDir(
  prefix: string,
  id: string,
  entryContent: string,
): { dir: string; manifestHex: string; entryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const manifestPath = join(dir, "nimbus.extension.json");
  writeFileSync(manifestPath, JSON.stringify({ id, version: "1.0.0", name: id }), "utf8");
  mkdirSync(join(dir, "dist"), { recursive: true });
  const entryPath = join(dir, "dist/index.js");
  writeFileSync(entryPath, entryContent, "utf8");
  const manifestHex = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  return { dir, manifestHex, entryPath };
}

describe("verifyExtensionsBestEffort", () => {
  test("no-op below schema v10", async () => {
    const db = new Database(":memory:");
    const { logger, warns } = memoryLogger();
    await verifyExtensionsBestEffort(db, logger);
    expect(warns.length).toBe(0);
  });

  test("manifest hash mismatch logs error and disables extension", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir } = makeExtensionDir("nimbus-ext-vfy-", "bad", "console.log(1)\n");

    const t = Date.now();
    insertExtensionRow(db, {
      id: "bad",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      installed_at: t,
      last_verified_at: t,
    });

    const { logger, warns, errors } = memoryLogger();
    await verifyExtensionsBestEffort(db, logger);
    expect(errors.some((w) => JSON.stringify(w).includes("manifest hash mismatch"))).toBe(true);
    expect(warns.length).toBe(0);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("bad") as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });

  test("entry hash mismatch logs error and disables extension", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = makeExtensionDir("nimbus-ext-vfy-entry-", "ent", "export {}\n");

    const t = Date.now();
    insertExtensionRow(db, {
      id: "ent",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHex,
      entry_hash: "0".repeat(64),
      installed_at: t,
      last_verified_at: t,
    });

    const { logger, errors } = memoryLogger();
    await verifyExtensionsBestEffort(db, logger);
    expect(errors.some((w) => JSON.stringify(w).includes("entry hash mismatch"))).toBe(true);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("ent") as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });

  // S7-F10
  test("manifest hash mismatch calls mesh.stopExtensionClient when mesh is supplied", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir } = makeExtensionDir("nimbus-ext-mesh-stop-", "tampered", "console.log(1)\n");
    const t = Date.now();
    insertExtensionRow(db, {
      id: "tampered",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      installed_at: t,
      last_verified_at: t,
    });
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (id: string) => {
        stopped.push(id);
      },
    };
    const { logger } = memoryLogger();
    await verifyExtensionsBestEffort(db, logger, mesh);
    expect(stopped).toEqual(["tampered"]);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("tampered") as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });
});

describe("verifyOneExtensionStrict (S7-F3)", () => {
  test("returns true when files match, false after entry mutation", () => {
    const initialEntry = "/* original */";
    const { dir, manifestHex, entryPath } = makeExtensionDir(
      "nimbus-strict-",
      "ext.strict",
      initialEntry,
    );
    const entryHex = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
    const row = {
      id: "ext.strict",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHex,
      entry_hash: entryHex,
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    expect(verifyOneExtensionStrict(row)).toBe(true);
    writeFileSync(entryPath, "/* TAMPERED */", "utf8");
    expect(verifyOneExtensionStrict(row)).toBe(false);
  });

  test("returns false when manifest is mutated", () => {
    const { dir, manifestHex, entryPath } = makeExtensionDir(
      "nimbus-strict-2-",
      "ext.strict.m",
      "x",
    );
    const entryHex = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
    const row = {
      id: "ext.strict.m",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHex,
      entry_hash: entryHex,
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    expect(verifyOneExtensionStrict(row)).toBe(true);
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({ id: "ext.strict.m", version: "1.0.0", name: "tampered" }),
      "utf8",
    );
    expect(verifyOneExtensionStrict(row)).toBe(false);
  });
});

const silentLogger = pino({ level: "silent" });

describe("verifyExtensionsBestEffort — signed extensions (I16)", () => {
  beforeEach(() => signatureDisabledRegistry.reset());

  test("signed manifest with cached key passes", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(1);
    expect(signatureDisabledRegistry.count()).toBe(0);
  });

  test("vault key missing → row disabled + registry marked publisher_key_missing", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    // intentionally skip writePublisherKey
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-test-pub")).toBe("publisher_key_missing");
  });

  test("tampered manifest (post-signing edit) → row disabled + signature_failed", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const installPath = await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    // Tamper with version. Re-stamp manifest_hash so the existing
    // SHA-256 sweep doesn't catch the row via a different code path.
    const mfPath = join(installPath, "nimbus.extension.json");
    const orig = JSON.parse(readFileSync(mfPath, "utf8")) as Record<string, unknown>;
    orig["version"] = "9.9.9";
    writeFileSync(mfPath, JSON.stringify(orig));
    const newHash = createHash("sha256").update(readFileSync(mfPath)).digest("hex");
    dbRun(db, "UPDATE extension SET manifest_hash = ? WHERE id = ?", [newHash, "ext-test-pub"]);

    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });

    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-test-pub")).toBe("signature_failed");
  });

  test("unsigned extension is unaffected by the new path", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const id = "ext-legacy";
    mkdirSync(join(extensionsDir, id, "dist"), { recursive: true });
    const mfBytes = Buffer.from(JSON.stringify({ id, version: "1.0.0", permissions: {} }), "utf8");
    writeFileSync(join(extensionsDir, id, "nimbus.extension.json"), mfBytes);
    const entryText = "export default {};";
    writeFileSync(join(extensionsDir, id, "dist", "index.js"), entryText);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: join(extensionsDir, id),
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === id);
    expect(row?.enabled).toBe(1);
    expect(signatureDisabledRegistry.count()).toBe(0);
  });
});
