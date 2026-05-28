import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import semver from "semver";

import {
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
  touchExtensionVerifiedAt,
  updateExtensionRowVersion,
} from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { forwardDeps, recordInstall } from "./dependency-store.ts";
import type { ResolvedDep } from "./dependency-types.ts";
import {
  hardDisablePreT2Extensions,
  preT2DisabledRegistry,
  signatureDisabledRegistry,
} from "./hard-disable.ts";
import {
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { missingDependencyRegistry } from "./missing-dependency-registry.ts";
import { readPublisherKey } from "./publisher-keys.ts";
import {
  errorToHardDisableReason,
  type SignatureDisableReason,
  verifyManifestSignature,
} from "./verify-signature.ts";

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface ExtensionMeshHandle {
  stopExtensionClient(extensionId: string): Promise<void>;
}

async function maybeRecoverMissingActive(
  db: Database,
  logger: Logger,
  row: ExtensionRow,
  now: number,
): Promise<boolean> {
  const activePath = row.install_path;
  if (existsSync(activePath)) return true;

  const extRoot = dirname(activePath);
  const prevDir = join(extRoot, "_prev");
  if (existsSync(prevDir)) {
    let candidates: string[] = [];
    try {
      candidates = readdirSync(prevDir).sort();
    } catch {
      candidates = [];
    }
    const target = candidates[candidates.length - 1];
    if (target !== undefined) {
      try {
        renameSync(join(prevDir, target), activePath);
        updateExtensionRowVersion(db, row.id, target, row.manifest_hash, row.entry_hash, now);
        try {
          appendAuditEntry(db, {
            actionType: "extension.autoUpdate.crash_recovered",
            hitlStatus: "not_required",
            actionJson: JSON.stringify({
              id: row.id,
              promoted_from: target,
              recovered_active: activePath,
            }),
            timestamp: now,
          });
        } catch (e) {
          logger.warn(
            { extensionId: row.id, err: e instanceof Error ? e.message : String(e) },
            "extensions: crash-recovery audit append failed",
          );
        }
        logger.warn(
          { extensionId: row.id, promotedFrom: target },
          "extensions: auto-update crash-recovered — promoted _prev to active",
        );
        return true;
      } catch (e) {
        logger.error(
          { extensionId: row.id, target, err: e instanceof Error ? e.message : String(e) },
          "extensions: crash-recovery promote rename failed",
        );
      }
    }
  }

  setExtensionEnabled(db, row.id, false);
  try {
    appendAuditEntry(db, {
      actionType: "extension.autoUpdate.crash_recovery_failed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        id: row.id,
        reason: "auto_update_install_path_missing",
        install_path: activePath,
      }),
      timestamp: now,
    });
  } catch {
    /* best-effort audit */
  }
  touchExtensionVerifiedAt(db, row.id, now);
  return false;
}

async function verifyOneExtension(
  db: Database,
  logger: Logger,
  row: ExtensionRow,
  now: number,
  mesh?: ExtensionMeshHandle,
): Promise<void> {
  const recovered = await maybeRecoverMissingActive(db, logger, row, now);
  if (!recovered) return;

  const manifestPath = resolveExtensionManifestPath(row.install_path);
  try {
    if (manifestPath === undefined) {
      logger.warn(
        { extensionId: row.id, installPath: row.install_path },
        "extensions: manifest file missing",
      );
      touchExtensionVerifiedAt(db, row.id, now);
      return;
    }
    const manifestBytes = readFileSync(manifestPath);
    const manifestHex = sha256HexOfBytes(manifestBytes);
    if (!sha256HexEqualConstantTime(manifestHex, row.manifest_hash)) {
      logger.error(
        { extensionId: row.id, expected: row.manifest_hash, actual: manifestHex },
        "extensions: manifest hash mismatch — extension disabled",
      );
      setExtensionEnabled(db, row.id, false);
      if (mesh !== undefined) {
        await mesh.stopExtensionClient(row.id);
      }
      touchExtensionVerifiedAt(db, row.id, now);
      return;
    }
    const manifest = parseExtensionManifestJson(manifestBytes.toString("utf8"));
    if (manifest.id !== row.id || manifest.version !== row.version) {
      logger.warn(
        { extensionId: row.id, manifestId: manifest.id, manifestVersion: manifest.version },
        "extensions: manifest id/version differs from registry",
      );
    }
    const entryRel =
      manifest.entry !== undefined && manifest.entry !== "" ? manifest.entry : "dist/index.js";
    const entryPath = join(row.install_path, entryRel);
    if (!existsSync(entryPath)) {
      logger.warn({ extensionId: row.id, entryPath }, "extensions: entry file missing");
      touchExtensionVerifiedAt(db, row.id, now);
      return;
    }
    const entryBytes = readFileSync(entryPath);
    const entryHex = sha256HexOfBytes(entryBytes);
    if (!sha256HexEqualConstantTime(entryHex, row.entry_hash)) {
      logger.error(
        { extensionId: row.id, expected: row.entry_hash, actual: entryHex },
        "extensions: entry hash mismatch — extension disabled",
      );
      setExtensionEnabled(db, row.id, false);
      if (mesh !== undefined) {
        await mesh.stopExtensionClient(row.id);
      }
      touchExtensionVerifiedAt(db, row.id, now);
      return;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ extensionId: row.id, err: msg }, "extensions: verify failed");
  }
  touchExtensionVerifiedAt(db, row.id, now);
}

export function verifyOneExtensionStrict(row: ExtensionRow): boolean {
  const manifestPath = resolveExtensionManifestPath(row.install_path);
  if (manifestPath === undefined) return false;
  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    return false;
  }
  if (!sha256HexEqualConstantTime(sha256HexOfBytes(manifestBytes), row.manifest_hash)) return false;
  const manifest = parseExtensionManifestJson(manifestBytes.toString("utf8"));
  const entryRel =
    manifest.entry !== undefined && manifest.entry !== "" ? manifest.entry : "dist/index.js";
  const entryPath = join(row.install_path, entryRel);
  if (!existsSync(entryPath)) return false;
  let entryBytes: Buffer;
  try {
    entryBytes = readFileSync(entryPath);
  } catch {
    return false;
  }
  return sha256HexEqualConstantTime(sha256HexOfBytes(entryBytes), row.entry_hash);
}

function backfillDependencyRowsBestEffort(
  db: Database,
  installed: ReadonlyMap<string, string>,
  installPathById: ReadonlyMap<string, string>,
  now: number,
  logger: Logger,
): void {
  for (const [id, version] of installed) {
    if (forwardDeps(db, id).length > 0) continue;
    const installPath = installPathById.get(id);
    if (installPath === undefined) continue;
    const manifestPath = resolveExtensionManifestPath(installPath);
    if (manifestPath === undefined) continue;
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const parsed = parseExtensionManifestJson(raw);
      const dependsOn = parsed.dependsOn;
      if (dependsOn === undefined || Object.keys(dependsOn).length === 0) continue;
      const deps: ResolvedDep[] = Object.entries(dependsOn).map(([depId, range]) => ({
        id: depId,
        range,
        resolvedVersion: installed.get(depId) ?? "unknown",
      }));
      recordInstall(db, id, version, deps, now);
    } catch (e) {
      logger.warn(
        { extensionId: id, error: e instanceof Error ? e.message : String(e) },
        "extensions: backfill failed (skipping)",
      );
    }
  }
}

function completenessGuard(
  db: Database,
  installed: ReadonlyMap<string, string>,
  logger: Logger,
): void {
  missingDependencyRegistry.reset();

  const isUsable = (id: string): boolean => {
    if (!installed.has(id)) return false;
    if (signatureDisabledRegistry.has(id)) return false;
    if (preT2DisabledRegistry.has(id)) return false;
    if (missingDependencyRegistry.has(id)) return false;
    return true;
  };

  const rows = db
    .query("SELECT extension_id, depends_on_id, range FROM extension_dependency")
    .all() as Array<{ extension_id: string; depends_on_id: string; range: string }>;

  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (missingDependencyRegistry.has(r.extension_id)) continue;
      if (!isUsable(r.depends_on_id)) {
        missingDependencyRegistry.mark({
          extensionId: r.extension_id,
          reason: "dependency_missing",
          missingDepId: r.depends_on_id,
          requiredRange: r.range,
        });
        changed = true;
        continue;
      }
      const depVersion = installed.get(r.depends_on_id);
      let satisfies = false;
      try {
        satisfies = depVersion !== undefined && semver.satisfies(depVersion, r.range);
      } catch {
        satisfies = false;
      }
      if (!satisfies) {
        missingDependencyRegistry.mark({
          extensionId: r.extension_id,
          reason: "dependency_unsatisfied",
          missingDepId: r.depends_on_id,
          requiredRange: r.range,
          ...(depVersion !== undefined ? { observedVersion: depVersion } : {}),
        });
        changed = true;
      }
    }
  }

  if (missingDependencyRegistry.count() > 0) {
    logger.warn(
      { count: missingDependencyRegistry.count() },
      "extensions: dependency completeness guard found missing/unsatisfied dependencies",
    );
  }
}

function sweepOrphanActiveDirsBestEffort(
  db: Database,
  extensionsRoot: string,
  logger: Logger,
): readonly string[] {
  const removed: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const row = db.query("SELECT id FROM extension WHERE id = ?").get(id) as {
      id: string;
    } | null;
    if (row !== null) continue;
    try {
      rmSync(join(extensionsRoot, id), { recursive: true, force: true });
      removed.push(id);
      logger.warn(
        { orphanId: id },
        "extensions: removed orphan extension directory (no extension row)",
      );
    } catch {
      /* swallow */
    }
  }
  return removed;
}

export interface VerifyExtensionsSignatureOpts {
  vault: NimbusVault;
}

export async function verifyExtensionsBestEffort(
  db: Database,
  logger: Logger,
  mesh?: ExtensionMeshHandle,
  signatureOpts?: VerifyExtensionsSignatureOpts,
  extensionsRoot?: string,
): Promise<void> {
  if (readIndexedUserVersion(db) < 10) {
    return;
  }
  const preT2Disabled = hardDisablePreT2Extensions({ db, logger });
  if (mesh !== undefined) {
    for (const row of preT2Disabled) {
      await mesh.stopExtensionClient(row.id);
    }
  }
  const rows = listExtensions(db).filter((r) => r.enabled === 1);
  if (rows.length === 0) {
    return;
  }
  const now = Date.now();
  for (const row of rows) {
    await verifyOneExtension(db, logger, row, now, mesh);
  }

  if (signatureOpts !== undefined) {
    signatureDisabledRegistry.reset();
    let signaturesChecked = 0;
    let signatureHardDisabled = 0;
    const failures: { id: string; reason: SignatureDisableReason }[] = [];
    for (const row of listExtensions(db).filter((r) => r.enabled === 1)) {
      const manifestPath = resolveExtensionManifestPath(row.install_path);
      if (manifestPath === undefined) continue;
      let manifestText: string;
      try {
        manifestText = readFileSync(manifestPath, "utf8");
      } catch {
        continue;
      }
      let parsed: ReturnType<typeof parseExtensionManifestForRegistry>;
      try {
        parsed = parseExtensionManifestForRegistry(manifestText);
      } catch {
        continue;
      }
      const m = parsed.manifest;
      if (m.publisher === undefined) continue;
      let rawManifestObj: Record<string, unknown>;
      try {
        rawManifestObj = JSON.parse(manifestText) as Record<string, unknown>;
      } catch {
        continue;
      }
      signaturesChecked++;
      const pubkey = await readPublisherKey(signatureOpts.vault, m.publisher.id);
      let reason: SignatureDisableReason | undefined;
      if (pubkey === undefined) {
        reason = "publisher_key_missing";
      } else {
        try {
          await verifyManifestSignature(
            rawManifestObj as {
              publisher?: { id: string; key: string };
              signature?: string;
              [k: string]: unknown;
            },
            pubkey,
          );
        } catch (err) {
          reason = errorToHardDisableReason(err);
        }
      }
      if (reason !== undefined) {
        setExtensionEnabled(db, row.id, false);
        signatureDisabledRegistry.mark(row.id, reason);
        signatureHardDisabled++;
        failures.push({ id: row.id, reason });
        logger.error(
          { extensionId: row.id, reason },
          "extensions: signature verification failed — extension disabled",
        );
        if (mesh !== undefined) await mesh.stopExtensionClient(row.id);
      }
    }
    appendAuditEntry(db, {
      actionType: "extension.startup_verification",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        signatures_checked: signaturesChecked,
        hard_disabled: signatureHardDisabled,
        failures,
      }),
      timestamp: Date.now(),
    });
  }

  const allRows = listExtensions(db);
  const installedFinal: Map<string, string> = new Map();
  const installPathByIdFinal: Map<string, string> = new Map();
  for (const r of allRows) {
    installedFinal.set(r.id, r.version);
    installPathByIdFinal.set(r.id, r.install_path);
  }

  backfillDependencyRowsBestEffort(db, installedFinal, installPathByIdFinal, Date.now(), logger);

  completenessGuard(db, installedFinal, logger);

  if (extensionsRoot !== undefined) {
    sweepOrphanActiveDirsBestEffort(db, extensionsRoot, logger);
  }
}
