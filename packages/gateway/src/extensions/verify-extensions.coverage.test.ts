/**
 * Paths of the startup verification pass (`verify-extensions.ts`, I16's second site) that
 * `verify-extensions.test.ts` does not reach: crash recovery whose audit append or promote rename
 * fails, a manifest naming its own entry file, a backfilled dependency that is not installed, and
 * a dependency on a pre-T2 (legacy-permissions) extension.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import { setupFreshExtensionDb } from "../../test/fixtures/extension.ts";
import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { dbExec, dbRun } from "../db/write.ts";
import { forwardDeps } from "./dependency-store.ts";
import { preT2DisabledRegistry, signatureDisabledRegistry } from "./hard-disable.ts";
import {
  _resetMissingDependencyRegistry,
  missingDependencyRegistry,
} from "./missing-dependency-registry.ts";
import { verifyExtensionsBestEffort } from "./verify-extensions.ts";

interface LogLine {
  readonly o: Record<string, unknown>;
  readonly msg: string | undefined;
}

function memoryLogger(): { logger: Logger; warns: LogLine[]; errors: LogLine[] } {
  const warns: LogLine[] = [];
  const errors: LogLine[] = [];
  const logger = {
    warn: (o: Record<string, unknown>, msg?: string) => warns.push({ o, msg }),
    error: (o: Record<string, unknown>, msg?: string) => errors.push({ o, msg }),
  } as unknown as Logger;
  return { logger, warns, errors };
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

const fixtures: Array<{ db: Database; extensionsDir: string }> = [];

function fresh(): { db: Database; extensionsDir: string } {
  const f = setupFreshExtensionDb();
  fixtures.push(f);
  return f;
}

/**
 * The three registries are process-global and shared by every test file in one `bun test`
 * process, so they are cleared AFTER each test as well as before: whatever this file marked must
 * not still be marked when the next file reads them.
 */
function resetRegistries(): void {
  _resetMissingDependencyRegistry();
  signatureDisabledRegistry.reset();
  preT2DisabledRegistry.reset();
}

beforeEach(resetRegistries);

afterEach(() => {
  resetRegistries();
  for (const { db, extensionsDir } of fixtures.splice(0)) {
    db.close();
    rmSync(extensionsDir, { recursive: true, force: true });
  }
});

/** Writes manifest + entry into `dir` and returns their hashes. */
function writeExtension(
  dir: string,
  manifest: Record<string, unknown>,
  entryRel = join("dist", "index.js"),
): { manifestHash: string; entryHash: string } {
  mkdirSync(join(dir, entryRel, ".."), { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const entryText = `export default ${JSON.stringify(manifest["id"])};\n`;
  writeFileSync(join(dir, "nimbus.extension.json"), manifestBytes);
  writeFileSync(join(dir, entryRel), entryText);
  return { manifestHash: sha256(manifestBytes), entryHash: sha256(entryText) };
}

/** An installed, verifiable extension at `<extensionsDir>/<id>`. */
function stageInstalled(
  db: Database,
  extensionsDir: string,
  id: string,
  manifestExtra: Record<string, unknown> = {},
): string {
  const dir = join(extensionsDir, id);
  const { manifestHash, entryHash } = writeExtension(dir, {
    id,
    version: "1.0.0",
    permissions: {},
    ...manifestExtra,
  });
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: dir,
    manifest_hash: manifestHash,
    entry_hash: entryHash,
    enabled: 1,
    installed_at: 1,
    last_verified_at: 1,
  });
  return dir;
}

/**
 * The state an auto-update crash leaves: `_prev/1.0.0` holds the previous version, and the row
 * points at an `install_path` that does not exist.
 */
function stageCrashedUpdate(
  db: Database,
  extensionsDir: string,
  id: string,
  installPath: string,
): string {
  const prev = join(extensionsDir, id, "_prev", "1.0.0");
  const { manifestHash, entryHash } = writeExtension(prev, {
    id,
    version: "1.0.0",
    permissions: {},
  });
  insertExtensionRow(db, {
    id,
    version: "1.1.0",
    install_path: installPath,
    manifest_hash: manifestHash,
    entry_hash: entryHash,
    enabled: 1,
    installed_at: 1,
    last_verified_at: 1,
  });
  return prev;
}

function auditRows(db: Database, actionType: string): Record<string, unknown>[] {
  return db
    .query<{ action_json: string }, [string]>(
      "SELECT action_json FROM audit_log WHERE action_type = ? ORDER BY id",
    )
    .all(actionType)
    .map((r) => JSON.parse(r.action_json) as Record<string, unknown>);
}

function rowOf(db: Database, id: string): { enabled: number; version: string } | undefined {
  return listExtensions(db).find((r) => r.id === id);
}

describe("crash recovery when its bookkeeping fails", () => {
  test("a failed crash_recovered audit append is logged, and the promotion still stands", async () => {
    const { db, extensionsDir } = fresh();
    const id = "com.cov.audit-down";
    const active = join(extensionsDir, id, "active");
    stageCrashedUpdate(db, extensionsDir, id, active);
    // Only THIS audit row is refused, so every other append the pass makes still works.
    dbExec(
      db,
      `CREATE TRIGGER cov_refuse_crash_audit BEFORE INSERT ON audit_log
       WHEN NEW.action_type = 'extension.autoUpdate.crash_recovered'
       BEGIN SELECT RAISE(ABORT, 'audit sink offline'); END;`,
    );
    const { logger, warns, errors } = memoryLogger();

    await verifyExtensionsBestEffort(db, logger);

    expect(existsSync(join(active, "nimbus.extension.json"))).toBe(true);
    expect(rowOf(db, id)).toMatchObject({ enabled: 1, version: "1.0.0" });
    const failed = warns.filter((w) => w.msg === "extensions: crash-recovery audit append failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.o["extensionId"]).toBe(id);
    expect(String(failed[0]?.o["err"])).toContain("audit sink offline");
    expect(auditRows(db, "extension.autoUpdate.crash_recovered")).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a promote rename that fails is logged and falls through to the hard-disable", async () => {
    const { db, extensionsDir } = fresh();
    const id = "com.cov.rename-fails";
    // A 300-character path component: no filesystem on any of the three platforms accepts it, so
    // the rename of `_prev/1.0.0` onto it fails (ENAMETOOLONG on POSIX, ENOENT on Windows).
    const unreachable = join(extensionsDir, id, "a".repeat(300));
    const prev = stageCrashedUpdate(db, extensionsDir, id, unreachable);
    const { logger, errors } = memoryLogger();

    await verifyExtensionsBestEffort(db, logger);

    const renameFailed = errors.filter(
      (e) => e.msg === "extensions: crash-recovery promote rename failed",
    );
    expect(renameFailed).toHaveLength(1);
    expect(renameFailed[0]?.o["extensionId"]).toBe(id);
    expect(renameFailed[0]?.o["target"]).toBe("1.0.0");
    expect(typeof renameFailed[0]?.o["err"]).toBe("string");
    // Fail closed: the row is disabled and the failure is on the audit chain.
    expect(rowOf(db, id)?.enabled).toBe(0);
    expect(auditRows(db, "extension.autoUpdate.crash_recovery_failed")).toEqual([
      { id, reason: "auto_update_install_path_missing", install_path: unreachable },
    ]);
    expect(auditRows(db, "extension.autoUpdate.crash_recovered")).toEqual([]);
    // The previous version was not lost in the attempt.
    expect(existsSync(join(prev, "nimbus.extension.json"))).toBe(true);
  });
});

describe("hash verification follows the manifest's own entry", () => {
  test("a manifest naming lib/main.js is verified against THAT file, not dist/index.js", async () => {
    const { db, extensionsDir } = fresh();
    const id = "com.cov.custom-entry";
    const dir = join(extensionsDir, id);
    const entryRel = join("lib", "main.js");
    const { manifestHash, entryHash } = writeExtension(
      dir,
      { id, version: "1.0.0", permissions: {}, entry: "lib/main.js" },
      entryRel,
    );
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(false); // no default to fall back to
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: manifestHash,
      entry_hash: entryHash,
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    const { logger, warns, errors } = memoryLogger();

    await verifyExtensionsBestEffort(db, logger);

    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
    const row = listExtensions(db).find((r) => r.id === id);
    expect(row?.enabled).toBe(1);
    expect(row?.last_verified_at).toBeGreaterThan(1);
    // ...and tampering with that same file is caught.
    writeFileSync(join(dir, entryRel), "export default 'tampered';\n");
    await verifyExtensionsBestEffort(db, logger);
    expect(rowOf(db, id)?.enabled).toBe(0);
    expect(errors.map((e) => e.msg)).toEqual([
      "extensions: entry hash mismatch — extension disabled",
    ]);
  });
});

describe("dependency bookkeeping", () => {
  test("a declared dependency that is NOT installed is still backfilled, and its dependent marked missing", async () => {
    const { db, extensionsDir } = fresh();
    const id = "com.cov.needs-absent";
    stageInstalled(db, extensionsDir, id, { dependsOn: { "com.cov.absent": "^1.0.0" } });
    expect(forwardDeps(db, id)).toEqual([]);
    const { logger } = memoryLogger();

    await verifyExtensionsBestEffort(db, logger);

    expect(forwardDeps(db, id)).toEqual([{ id: "com.cov.absent", range: "^1.0.0" }]);
    expect(missingDependencyRegistry.reasonFor(id)).toMatchObject({
      reason: "dependency_missing",
      missingDepId: "com.cov.absent",
      requiredRange: "^1.0.0",
    });
  });

  test("a dependency that was hard-disabled as pre-T2 is not usable, even though its version fits", async () => {
    const { db, extensionsDir } = fresh();
    const legacy = "com.cov.legacy-dep";
    const dependent = "com.cov.uses-legacy";
    // A legacy `permissions` ARRAY is the pre-T2 marker; its version (1.0.0) satisfies ^1.0.0.
    stageInstalled(db, extensionsDir, legacy, { permissions: ["network"] });
    stageInstalled(db, extensionsDir, dependent);
    dbRun(
      db,
      `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
       VALUES (?, ?, ?, ?)`,
      [dependent, legacy, "^1.0.0", 1],
    );
    const { logger } = memoryLogger();

    await verifyExtensionsBestEffort(db, logger);

    expect(preT2DisabledRegistry.has(legacy)).toBe(true);
    expect(rowOf(db, legacy)?.enabled).toBe(0);
    expect(signatureDisabledRegistry.has(legacy)).toBe(false); // not the signature path
    expect(missingDependencyRegistry.reasonFor(dependent)).toMatchObject({
      reason: "dependency_missing",
      missingDepId: legacy,
    });
  });
});

describe("the fixture itself", () => {
  test("a staged extension verifies cleanly (guards every test above against a broken stage)", async () => {
    const { db, extensionsDir } = fresh();
    const dir = stageInstalled(db, extensionsDir, "com.cov.clean");
    expect(readFileSync(join(dir, "nimbus.extension.json"), "utf8")).toContain("com.cov.clean");
    const { logger, warns, errors } = memoryLogger();
    await verifyExtensionsBestEffort(db, logger);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
    expect(rowOf(db, "com.cov.clean")?.enabled).toBe(1);
  });
});
