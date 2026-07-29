import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { forwardDeps } from "./dependency-store.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import {
  _resetMissingDependencyRegistry,
  missingDependencyRegistry,
} from "./missing-dependency-registry.ts";
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
    expect(warns).toHaveLength(0);
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
    expect(warns).toHaveLength(0);
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

describe("verifyExtensionsBestEffort crash recovery (T2 PR 3)", () => {
  test("promotes _prev/<v>/ to active/ when active/ is missing", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const id = "com.example.crash-recover";
      const extRoot = join(extensionsDir, id);
      const prevDir = join(extRoot, "_prev", "1.0.0");
      mkdirSync(prevDir, { recursive: true });
      const manifestText = JSON.stringify({ id, version: "1.0.0" });
      writeFileSync(join(prevDir, "nimbus.extension.json"), manifestText, "utf8");
      mkdirSync(join(prevDir, "dist"), { recursive: true });
      writeFileSync(join(prevDir, "dist", "index.js"), "// prev entry", "utf8");

      const manifestHex = createHash("sha256")
        .update(readFileSync(join(prevDir, "nimbus.extension.json")))
        .digest("hex");
      const entryHex = createHash("sha256")
        .update(readFileSync(join(prevDir, "dist", "index.js")))
        .digest("hex");

      insertExtensionRow(db, {
        id,
        version: "1.1.0", // pretend we were rolling 1.0.0 → 1.1.0 when we crashed
        install_path: join(extRoot, "active"),
        manifest_hash: manifestHex,
        entry_hash: entryHex,
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      await verifyExtensionsBestEffort(db, logger);

      expect(readFileSync(join(extRoot, "active", "nimbus.extension.json"), "utf8")).toBe(
        manifestText,
      );
      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.version).toBe("1.0.0");
      expect(row?.enabled).toBe(1);

      const auditRow = db
        .query(
          `SELECT action_type, action_json FROM audit_log WHERE action_type = ? ORDER BY id DESC LIMIT 1`,
        )
        .get("extension.autoUpdate.crash_recovered") as
        | { action_type: string; action_json: string }
        | undefined;
      expect(auditRow).toBeDefined();
      const parsed = JSON.parse(auditRow!.action_json) as {
        id: string;
        promoted_from: string;
      };
      expect(parsed.id).toBe(id);
      expect(parsed.promoted_from).toBe("1.0.0");
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      db.close();
    }
  });

  test("hard-disables when neither active/ nor _prev/* exists", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const id = "com.example.crash-fail";
      const extRoot = join(extensionsDir, id);
      mkdirSync(extRoot, { recursive: true });
      insertExtensionRow(db, {
        id,
        version: "1.0.0",
        install_path: join(extRoot, "active"),
        manifest_hash: "0".repeat(64),
        entry_hash: "0".repeat(64),
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      await verifyExtensionsBestEffort(db, logger);

      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);

      const auditRow = db
        .query(
          `SELECT action_type, action_json FROM audit_log WHERE action_type = ? ORDER BY id DESC LIMIT 1`,
        )
        .get("extension.autoUpdate.crash_recovery_failed") as
        | { action_type: string; action_json: string }
        | undefined;
      expect(auditRow).toBeDefined();
      const parsed = JSON.parse(auditRow!.action_json) as { reason: string };
      expect(parsed.reason).toBe("auto_update_install_path_missing");
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      db.close();
    }
  });
});

describe("verifyExtensionsBestEffort — dep-graph backfill (Task 12)", () => {
  test("backfill populates forward dep edges from on-disk manifest when extension_dependency is empty", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idA = "com.shared.A";
      const idB = "com.example.B";

      const dirA = join(extensionsDir, idA);
      mkdirSync(join(dirA, "dist"), { recursive: true });
      const mfBytesA = Buffer.from(
        JSON.stringify({ id: idA, version: "1.5.0", permissions: {} }),
        "utf8",
      );
      writeFileSync(join(dirA, "nimbus.extension.json"), mfBytesA);
      const entryTextA = "export default {};";
      writeFileSync(join(dirA, "dist", "index.js"), entryTextA);

      const dirB = join(extensionsDir, idB);
      mkdirSync(join(dirB, "dist"), { recursive: true });
      const mfBytesB = Buffer.from(
        JSON.stringify({
          id: idB,
          version: "1.0.0",
          permissions: {},
          dependsOn: { [idA]: "^1.0.0" },
        }),
        "utf8",
      );
      writeFileSync(join(dirB, "nimbus.extension.json"), mfBytesB);
      const entryTextB = "export default {};";
      writeFileSync(join(dirB, "dist", "index.js"), entryTextB);

      const now = Date.now();
      insertExtensionRow(db, {
        id: idA,
        version: "1.5.0",
        install_path: dirA,
        manifest_hash: createHash("sha256").update(mfBytesA).digest("hex"),
        entry_hash: createHash("sha256").update(entryTextA).digest("hex"),
        enabled: 1,
        installed_at: now,
        last_verified_at: now,
      });
      insertExtensionRow(db, {
        id: idB,
        version: "1.0.0",
        install_path: dirB,
        manifest_hash: createHash("sha256").update(mfBytesB).digest("hex"),
        entry_hash: createHash("sha256").update(entryTextB).digest("hex"),
        enabled: 1,
        installed_at: now,
        last_verified_at: now,
      });

      expect(forwardDeps(db, idB)).toHaveLength(0);

      await verifyExtensionsBestEffort(db, logger);

      const deps = forwardDeps(db, idB);
      expect(deps).toHaveLength(1);
      expect(deps[0]?.id).toBe(idA);
      expect(deps[0]?.range).toBe("^1.0.0");

      expect(forwardDeps(db, idA)).toHaveLength(0);
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      db.close();
    }
  });
});

describe("verifyExtensionsBestEffort — orphan-active sweep (Task 12)", () => {
  test("removes dirs with no extension row, leaves dirs with a row intact", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const orphanDir = join(extensionsDir, "com.orphan");
      mkdirSync(join(orphanDir, "dist"), { recursive: true });
      writeFileSync(
        join(orphanDir, "nimbus.extension.json"),
        JSON.stringify({ id: "com.orphan", version: "1.0.0", permissions: {} }),
        "utf8",
      );

      const realId = "com.real";
      const realDir = join(extensionsDir, realId);
      mkdirSync(join(realDir, "dist"), { recursive: true });
      const mfBytes = Buffer.from(
        JSON.stringify({ id: realId, version: "1.0.0", permissions: {} }),
        "utf8",
      );
      const entryText = "export default {};";
      writeFileSync(join(realDir, "nimbus.extension.json"), mfBytes);
      writeFileSync(join(realDir, "dist", "index.js"), entryText);
      const now = Date.now();
      insertExtensionRow(db, {
        id: realId,
        version: "1.0.0",
        install_path: realDir,
        manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
        entry_hash: createHash("sha256").update(entryText).digest("hex"),
        enabled: 1,
        installed_at: now,
        last_verified_at: now,
      });

      await verifyExtensionsBestEffort(db, logger, undefined, undefined, extensionsDir);

      expect(existsSync(orphanDir)).toBe(false);
      expect(existsSync(realDir)).toBe(true);
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      db.close();
    }
  });
});

function stageMinimalExtension(
  db: Database,
  extensionsDir: string,
  id: string,
  version: string,
  manifestExtra: Record<string, unknown> = {},
): string {
  const dir = join(extensionsDir, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const mfBytes = Buffer.from(
    JSON.stringify({ id, version, permissions: {}, ...manifestExtra }),
    "utf8",
  );
  const entryText = "export default {};";
  writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
  writeFileSync(join(dir, "dist", "index.js"), entryText);
  const now = Date.now();
  insertExtensionRow(db, {
    id,
    version,
    install_path: dir,
    manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
    entry_hash: createHash("sha256").update(entryText).digest("hex"),
    enabled: 1,
    installed_at: now,
    last_verified_at: now,
  });
  return dir;
}

describe("verify-extensions — completeness guard (Task 13)", () => {
  test("hard-disables dependent when its dep is missing from the installed set", async () => {
    _resetMissingDependencyRegistry();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idB = "com.example.B";
      stageMinimalExtension(db, extensionsDir, idB, "1.0.0");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, "com.shared.A", "^1.0.0", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      expect(missingDependencyRegistry.reasonFor(idB)?.reason).toBe("dependency_missing");
      expect(missingDependencyRegistry.reasonFor(idB)?.missingDepId).toBe("com.shared.A");
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
      db.close();
    }
  });

  test("hard-disables when installed dep version does not satisfy the declared range", async () => {
    _resetMissingDependencyRegistry();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idA = "com.shared.A";
      const idB = "com.example.B";
      stageMinimalExtension(db, extensionsDir, idA, "0.9.0");
      stageMinimalExtension(db, extensionsDir, idB, "1.0.0");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, idA, "^1.0.0", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      const entry = missingDependencyRegistry.reasonFor(idB);
      expect(entry?.reason).toBe("dependency_unsatisfied");
      expect(entry?.observedVersion).toBe("0.9.0");
      expect(entry?.missingDepId).toBe(idA);
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
      db.close();
    }
  });

  test("cascade: A missing → B disabled → C (depends on B) also disabled", async () => {
    _resetMissingDependencyRegistry();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idB = "com.example.B";
      const idC = "com.example.C";
      stageMinimalExtension(db, extensionsDir, idB, "1.0.0");
      stageMinimalExtension(db, extensionsDir, idC, "1.0.0");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, "com.shared.A", "^1.0.0", now],
      );
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idC, idB, "^1.0.0", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      expect(missingDependencyRegistry.reasonFor(idB)?.reason).toBe("dependency_missing");
      expect(missingDependencyRegistry.reasonFor(idB)?.missingDepId).toBe("com.shared.A");

      expect(missingDependencyRegistry.has(idC)).toBe(true);
      const cEntry = missingDependencyRegistry.reasonFor(idC);
      expect(cEntry?.reason).toBe("dependency_missing");
      expect(cEntry?.missingDepId).toBe(idB);
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
      db.close();
    }
  });

  test("malformed semver range is treated as unsatisfied and does not throw", async () => {
    _resetMissingDependencyRegistry();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idA = "com.shared.A";
      const idB = "com.example.B";
      stageMinimalExtension(db, extensionsDir, idA, "1.0.0");
      stageMinimalExtension(db, extensionsDir, idB, "1.0.0");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, idA, "not-a-range", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      expect(missingDependencyRegistry.reasonFor(idB)?.reason).toBe("dependency_unsatisfied");
    } finally {
      dbRun(db, "DELETE FROM extension WHERE 1=1");
      dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// verifyOneExtensionStrict — additional branch coverage
// ---------------------------------------------------------------------------

describe("verifyOneExtensionStrict — branch coverage", () => {
  test("returns false when install_path has no manifest file", () => {
    // Line 220 — manifestPath === undefined branch
    const dir = mkdtempSync(join(tmpdir(), "nimbus-strict-noman-"));
    // Do NOT write nimbus.extension.json → resolveExtensionManifestPath returns undefined
    const row = {
      id: "ext.no-manifest",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    try {
      expect(verifyOneExtensionStrict(row)).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("returns false when manifest file exists but cannot be read (readFileSync throws)", () => {
    // Line 224-225 — readFileSync catch branch
    const dir = mkdtempSync(join(tmpdir(), "nimbus-strict-badread-"));
    // Create a directory at the manifest path so readFileSync throws EISDIR
    const manifestPath = join(dir, "nimbus.extension.json");
    mkdirSync(manifestPath, { recursive: true });
    const row = {
      id: "ext.bad-read",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    try {
      expect(verifyOneExtensionStrict(row)).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("returns false when entry field is empty string — defaults to dist/index.js which is missing", () => {
    // Line 230 — manifest.entry === "" branch → defaults dist/index.js, then line 232 existsSync false
    const dir = mkdtempSync(join(tmpdir(), "nimbus-strict-emptyentry-"));
    // manifest with entry: "" so we hit the default path, but NO dist/index.js
    const manifestContent = JSON.stringify({ id: "ext.empty-entry", version: "1.0.0", entry: "" });
    const manifestBytes = Buffer.from(manifestContent, "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), manifestBytes);
    const manifestHex = createHash("sha256").update(manifestBytes).digest("hex");
    // Do NOT create dist/index.js
    const row = {
      id: "ext.empty-entry",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHex,
      entry_hash: "0".repeat(64),
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    try {
      expect(verifyOneExtensionStrict(row)).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("returns false when entry file cannot be read (readFileSync throws after existsSync=true)", () => {
    // Line 236-237 — entryBytes readFileSync catch branch
    const dir = mkdtempSync(join(tmpdir(), "nimbus-strict-entryread-"));
    const manifestContent = JSON.stringify({
      id: "ext.entry-read-err",
      version: "1.0.0",
      entry: "dist/index.js",
    });
    const manifestBytes = Buffer.from(manifestContent, "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), manifestBytes);
    const manifestHex = createHash("sha256").update(manifestBytes).digest("hex");
    // Create a directory at dist/index.js so existsSync returns true but readFileSync throws EISDIR
    mkdirSync(join(dir, "dist", "index.js"), { recursive: true });
    const row = {
      id: "ext.entry-read-err",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHex,
      entry_hash: "0".repeat(64),
      enabled: 1 as const,
      installed_at: 0,
      last_verified_at: 0,
    };
    try {
      expect(verifyOneExtensionStrict(row)).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runHashVerification — manifest-missing / entry-default / entry-missing
// ---------------------------------------------------------------------------

describe("verifyExtensionsBestEffort — runHashVerification branch coverage", () => {
  test("manifest file missing → warn, touchVerifiedAt, extension stays enabled (not disabled)", async () => {
    // Lines 151-157 — manifestPath === undefined branch in runHashVerification
    // Achieved by making install_path a directory with no manifest file but with _prev present so
    // crash-recovery code still reaches runHashVerification.
    // Easiest: use an install_path that exists (so maybeRecoverMissingActive returns true)
    // but has no manifest file.
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-noman-rh-"));
    // Create dist/index.js so the dir "exists" but no manifest
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "// entry", "utf8");
    const now = Date.now();
    insertExtensionRow(db, {
      id: "ext.no-manifest-rh",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    const { logger, warns, errors } = memoryLogger();
    try {
      await verifyExtensionsBestEffort(db, logger);
      expect(warns.some((w) => JSON.stringify(w).includes("manifest file missing"))).toBe(true);
      expect(errors).toHaveLength(0);
      // Extension must NOT be hard-disabled — manifest-missing is a warn path that returns false
      // without calling disableAndStopExtension
      const row = db
        .query("SELECT enabled FROM extension WHERE id = ?")
        .get("ext.no-manifest-rh") as {
        enabled: number;
      };
      expect(row.enabled).toBe(1);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });

  test("entry file missing (manifest entry field empty → default dist/index.js) → warn, not disabled", async () => {
    // Lines 176-182 — entry="" defaults to dist/index.js, then existsSync false → warn + touchVerifiedAt
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-noentry-rh-"));
    const manifestContent = JSON.stringify({ id: "ext.no-entry-rh", version: "1.0.0", entry: "" });
    const manifestBytes = Buffer.from(manifestContent, "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), manifestBytes);
    // Do NOT create dist/index.js
    const now = Date.now();
    insertExtensionRow(db, {
      id: "ext.no-entry-rh",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(manifestBytes).digest("hex"),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    const { logger, warns, errors } = memoryLogger();
    try {
      await verifyExtensionsBestEffort(db, logger);
      expect(warns.some((w) => JSON.stringify(w).includes("entry file missing"))).toBe(true);
      expect(errors).toHaveLength(0);
      const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("ext.no-entry-rh") as {
        enabled: number;
      };
      expect(row.enabled).toBe(1);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });

  test("verifyOneExtension catch: runHashVerification throws → warn logged, extension not disabled", async () => {
    // Lines 211-213 — catch block in verifyOneExtension when runHashVerification throws
    // We cause this by making the manifest a directory (existsSync=true but readFileSync throws)
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-rh-throw-"));
    // Create a directory named nimbus.extension.json so existsSync(manifestPath) returns true
    // but readFileSync throws EISDIR
    mkdirSync(join(dir, "nimbus.extension.json"), { recursive: true });
    // resolveExtensionManifestPath uses existsSync(join(dir, "nimbus.extension.json")) which
    // returns true for directories → manifestPath is defined → readFileSync throws inside runHashVerification
    const now = Date.now();
    insertExtensionRow(db, {
      id: "ext.rh-throw",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    const { logger, warns } = memoryLogger();
    try {
      await verifyExtensionsBestEffort(db, logger);
      expect(warns.some((w) => JSON.stringify(w).includes("verify failed"))).toBe(true);
      // Extension must remain enabled — the catch path does not disable
      const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("ext.rh-throw") as {
        enabled: number;
      };
      expect(row.enabled).toBe(1);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tryPromotePrevVersion edge cases
// ---------------------------------------------------------------------------

describe("verifyExtensionsBestEffort — tryPromotePrevVersion branches", () => {
  test("_prev dir exists but is empty → no promotion → hard-disables", async () => {
    // Line 63 — target === undefined (candidates.at(-1) is undefined when _prev/ is empty)
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    const id = "com.example.prev-empty";
    const extRoot = join(extensionsDir, id);
    // Create an empty _prev dir (no version subdirs)
    mkdirSync(join(extRoot, "_prev"), { recursive: true });
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: join(extRoot, "active"),
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    try {
      await verifyExtensionsBestEffort(db, logger);
      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });

  test("_prev dir readdir throws (is a file) → no promotion → hard-disables", async () => {
    // Lines 59-60 — readdirSync catch → candidates = []
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    const id = "com.example.prev-file";
    const extRoot = join(extensionsDir, id);
    mkdirSync(extRoot, { recursive: true });
    // Write a FILE named _prev so readdirSync(_prev) throws ENOTDIR
    writeFileSync(join(extRoot, "_prev"), "not-a-dir", "utf8");
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: join(extRoot, "active"),
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    try {
      await verifyExtensionsBestEffort(db, logger);
      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });

  // D-CANDIDATE: lines 89-94 (renameSync catch in tryPromotePrevVersion).
  // Triggering this requires renameSync to throw on a destination path that does NOT yet exist
  // (if it existed, maybeRecoverMissingActive returns true before reaching tryPromotePrevVersion).
  // Cross-device rename or filesystem-level ACL manipulation would be needed — not reliably
  // reproducible cross-platform without introducing fragile platform-specific code.
});

// ---------------------------------------------------------------------------
// sweepOrphanActiveDirsBestEffort — extensionsRoot unreadable
// ---------------------------------------------------------------------------

describe("verifyExtensionsBestEffort — orphan sweep branch coverage", () => {
  test("extensionsRoot unreadable (is a file) → sweep returns empty, no crash", async () => {
    // Line 365 — catch in sweepOrphanActiveDirsBestEffort when readdirSync throws
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    // Create a valid extension so rows.length > 0 (to get past early-return)
    stageMinimalExtensionLocal(db, extensionsDir, "com.sweep.ok", "1.0.0");
    // Pass a FILE path as extensionsRoot so readdirSync throws ENOTDIR
    const fakeRoot = join(extensionsDir, "not-a-dir-file");
    writeFileSync(fakeRoot, "blocking", "utf8");
    try {
      // No crash — the readdirSync ENOTDIR is swallowed by the best-effort sweep's catch.
      await expect(
        verifyExtensionsBestEffort(db, logger, undefined, undefined, fakeRoot),
      ).resolves.toBeUndefined();
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });

  test("extensionsRoot contains a file entry (not a directory) — skipped by isDirectory() guard", async () => {
    // Line 368 — !entry.isDirectory() continue branch
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    stageMinimalExtensionLocal(db, extensionsDir, "com.sweep.real2", "1.0.0");
    // Add a plain file inside extensionsDir — should be skipped, not treated as orphan dir
    writeFileSync(join(extensionsDir, "plain-file.txt"), "data", "utf8");
    try {
      await verifyExtensionsBestEffort(db, logger, undefined, undefined, extensionsDir);
      // plain-file.txt must still exist (not removed)
      expect(existsSync(join(extensionsDir, "plain-file.txt"))).toBe(true);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computeRowSignatureReason / runSignatureVerificationPass — branch coverage
// ---------------------------------------------------------------------------

describe("verifyExtensionsBestEffort — signature pass branch coverage", () => {
  let _tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of _tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    _tmpDirs = [];
    signatureDisabledRegistry.reset();
  });

  function makeDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    _tmpDirs.push(d);
    return d;
  }

  test("computeRowSignatureReason: manifestPath undefined → skip (extension not disabled)", async () => {
    // Line 397 — manifestPath === undefined → "skip"
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    const dir = makeDir("nimbus-sig-noman-");
    // No manifest file in dir
    const now = Date.now();
    insertExtensionRow(db, {
      id: "ext.sig-noman",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    // Also stage a real extension so rows.length > 0 and hash verification passes for it
    stageMinimalExtensionLocal(db, extensionsDir, "com.sig.real", "1.0.0");
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    // ext.sig-noman was skipped (no manifest) by the signature pass → not in the
    // signature-disabled registry (hash verification may still disable it; that's fine —
    // the signature "skip" path is what this test exercises).
    expect(signatureDisabledRegistry.has("ext.sig-noman")).toBe(false);
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("computeRowSignatureReason: manifest readFileSync throws → skip", async () => {
    // Line 402 — readFileSync throws → "skip"
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    const dir = makeDir("nimbus-sig-readerror-");
    // Create a directory at manifest path so readFileSync throws EISDIR
    mkdirSync(join(dir, "nimbus.extension.json"), { recursive: true });
    // Also need an entry so hash verification reaches the signature pass
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "x", "utf8");
    const now = Date.now();
    insertExtensionRow(db, {
      id: "ext.sig-readerror",
      version: "1.0.0",
      install_path: dir,
      manifest_hash: "0".repeat(64),
      entry_hash: "0".repeat(64),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    expect(signatureDisabledRegistry.has("ext.sig-readerror")).toBe(false);
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("computeRowSignatureReason: parseExtensionManifestForRegistry throws → skip", async () => {
    // Line 408 — parseExtensionManifestForRegistry throws (invalid JSON structure)
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    // stage a full extension with correct hashes, then tweak manifest to be invalid JSON object
    const dir = stageMinimalExtensionLocal(db, extensionsDir, "ext.sig-parseerror", "1.0.0");
    // Overwrite manifest with content that is valid JSON but invalid manifest
    // (missing required "id" field → parseExtensionManifestForRegistry throws)
    const badManifest = JSON.stringify({ version: "1.0.0" });
    const badManifestBytes = Buffer.from(badManifest, "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), badManifestBytes);
    // Update db hash to match the new bad manifest so hash verification passes
    dbRun(db, "UPDATE extension SET manifest_hash = ? WHERE id = ?", [
      createHash("sha256").update(badManifestBytes).digest("hex"),
      "ext.sig-parseerror",
    ]);
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    // Signature skip → not in signatureDisabledRegistry
    expect(signatureDisabledRegistry.has("ext.sig-parseerror")).toBe(false);
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("computeRowSignatureReason: JSON.parse of manifestText throws → skip", async () => {
    // Line 416 — JSON.parse throws (non-JSON text) — this can't happen after parseExtensionManifestForRegistry
    // succeeds, but we test the publisher=undefined path (line 411) which leads to "skip"
    // Publisher undefined → line 411 returns "skip" before JSON.parse is reached
    // Use an extension with no publisher field to exercise the publisher === undefined skip
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    stageMinimalExtensionLocal(db, extensionsDir, "ext.sig-nopub", "1.0.0");
    // stageMinimalExtensionLocal writes a manifest with no publisher field
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    expect(signatureDisabledRegistry.has("ext.sig-nopub")).toBe(false);
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("I16: valid signature → extension stays enabled (accepted)", async () => {
    // The primary I16 security assertion: valid sig → enabled=1, not in signatureDisabledRegistry
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-valid", pubkey);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "pub-valid",
      pubkey,
      privkey,
    });
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (id: string) => {
        stopped.push(id);
      },
    };
    await verifyExtensionsBestEffort(db, silentLogger, mesh, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-pub-valid");
    expect(row?.enabled).toBe(1);
    expect(signatureDisabledRegistry.has("ext-pub-valid")).toBe(false);
    expect(stopped).not.toContain("ext-pub-valid");
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("I16: invalid/tampered signature → extension disabled + mesh.stopExtensionClient called", async () => {
    // The primary I16 security assertion for the bad-sig path.
    // Lines 445-453: setExtensionEnabled(false) + signatureDisabledRegistry.mark + mesh.stopExtensionClient
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-tampered", pubkey);
    const installPath = await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "pub-tampered",
      pubkey,
      privkey,
    });
    // Tamper the manifest (change version) and update the DB hash so hash-check passes
    const mfPath = join(installPath, "nimbus.extension.json");
    const orig = JSON.parse(readFileSync(mfPath, "utf8")) as Record<string, unknown>;
    orig["version"] = "9.9.9";
    const tamperedBytes = Buffer.from(JSON.stringify(orig), "utf8");
    writeFileSync(mfPath, tamperedBytes);
    dbRun(db, "UPDATE extension SET manifest_hash = ? WHERE id = ?", [
      createHash("sha256").update(tamperedBytes).digest("hex"),
      "ext-pub-tampered",
    ]);
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (id: string) => {
        stopped.push(id);
      },
    };
    await verifyExtensionsBestEffort(db, silentLogger, mesh, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-pub-tampered");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-pub-tampered")).toBe("signature_failed");
    expect(stopped).toContain("ext-pub-tampered");
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });

  test("publisher_key_missing → extension disabled, mesh.stopExtensionClient called", async () => {
    // Line 420 — pubkey === undefined → "publisher_key_missing"
    const { db, extensionsDir } = setupFreshExtensionDb();
    _tmpDirs.push(extensionsDir);
    const vault = new MockVault();
    // Do NOT write the key to vault
    const { privkey, pubkey } = generateEd25519Keypair();
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "pub-missing-key",
      pubkey,
      privkey,
    });
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (id: string) => {
        stopped.push(id);
      },
    };
    await verifyExtensionsBestEffort(db, silentLogger, mesh, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-pub-missing-key");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-pub-missing-key")).toBe(
      "publisher_key_missing",
    );
    expect(stopped).toContain("ext-pub-missing-key");
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  });
});

// ---------------------------------------------------------------------------
// completenessGuard — signatureDisabledRegistry / preT2DisabledRegistry isUsable checks
// ---------------------------------------------------------------------------

describe("verify-extensions — completenessGuard isUsable registry checks", () => {
  beforeEach(() => {
    _resetMissingDependencyRegistry();
    signatureDisabledRegistry.reset();
  });

  test("dep in signatureDisabledRegistry → dependent marked dependency_missing (lines 324)", async () => {
    // isUsable returns false when dep is in signatureDisabledRegistry
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idA = "com.sig-disabled.A";
      const idB = "com.sig-disabled.B";
      stageMinimalExtensionLocal(db, extensionsDir, idA, "1.0.0");
      stageMinimalExtensionLocal(db, extensionsDir, idB, "1.0.0");

      // Mark idA as signature-disabled (as if the sig pass already ran and failed for it)
      signatureDisabledRegistry.mark(idA, "signature_failed");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, idA, "^1.0.0", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      expect(missingDependencyRegistry.reasonFor(idB)?.reason).toBe("dependency_missing");
      expect(missingDependencyRegistry.reasonFor(idB)?.missingDepId).toBe(idA);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateDependencyRow — observedVersion spread when dep version is defined
// ---------------------------------------------------------------------------

describe("verify-extensions — evaluateDependencyRow observedVersion branch", () => {
  test("dep is installed but version out-of-range → dependency_unsatisfied WITH observedVersion", async () => {
    // Line 311 — depVersion is defined → observedVersion included in the returned object
    // This is the same as the existing "does not satisfy range" test, but we verify observedVersion present
    _resetMissingDependencyRegistry();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    try {
      const idA = "com.obs.A";
      const idB = "com.obs.B";
      stageMinimalExtensionLocal(db, extensionsDir, idA, "2.0.0");
      stageMinimalExtensionLocal(db, extensionsDir, idB, "1.0.0");

      const now = Date.now();
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
         VALUES (?, ?, ?, ?)`,
        [idB, idA, "^1.0.0", now],
      );

      await verifyExtensionsBestEffort(db, logger);

      expect(missingDependencyRegistry.has(idB)).toBe(true);
      const entry = missingDependencyRegistry.reasonFor(idB);
      expect(entry?.reason).toBe("dependency_unsatisfied");
      expect(entry?.observedVersion).toBe("2.0.0");
      expect(entry?.missingDepId).toBe(idA);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        dbRun(db, "DELETE FROM extension_dependency WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// verifyExtensionsBestEffort — preT2 mesh stop loop (lines 478-482)
// ---------------------------------------------------------------------------

describe("verifyExtensionsBestEffort — preT2 mesh stop", () => {
  test("pre-T2 extension gets mesh.stopExtensionClient called when mesh is supplied", async () => {
    // Lines 478-482 — for (const row of preT2Disabled) { await mesh.stopExtensionClient(row.id) }
    const { db, extensionsDir } = setupFreshExtensionDb();
    const { logger } = memoryLogger();
    // A pre-T2 extension has permissions as an ARRAY (legacy format)
    const id = "com.pret2.stop";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    // Legacy array-format permissions → isPreT2Legacy = true
    const mfBytes = Buffer.from(
      JSON.stringify({ id, version: "1.0.0", permissions: ["read"] }),
      "utf8",
    );
    const entryText = "export default {};";
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    writeFileSync(join(dir, "dist", "index.js"), entryText);
    const now = Date.now();
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (extId: string) => {
        stopped.push(extId);
      },
    };
    try {
      await verifyExtensionsBestEffort(db, logger, mesh);
      expect(stopped).toContain(id);
      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
    } finally {
      try {
        dbRun(db, "DELETE FROM extension WHERE 1=1");
        db.close();
      } catch {
        /* best-effort */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Local helper used in the above tests (mirrors stageMinimalExtension)
// ---------------------------------------------------------------------------

function stageMinimalExtensionLocal(
  db: Database,
  extensionsDir: string,
  id: string,
  version: string,
  manifestExtra: Record<string, unknown> = {},
): string {
  const dir = join(extensionsDir, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const mfBytes = Buffer.from(
    JSON.stringify({ id, version, permissions: {}, ...manifestExtra }),
    "utf8",
  );
  const entryText = "export default {};";
  writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
  writeFileSync(join(dir, "dist", "index.js"), entryText);
  const now = Date.now();
  insertExtensionRow(db, {
    id,
    version,
    install_path: dir,
    manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
    entry_hash: createHash("sha256").update(entryText).digest("hex"),
    enabled: 1,
    installed_at: now,
    last_verified_at: now,
  });
  return dir;
}
