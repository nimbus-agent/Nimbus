import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
