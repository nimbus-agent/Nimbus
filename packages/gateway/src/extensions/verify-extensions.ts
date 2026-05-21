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

/**
 * Optional mesh handle so the verifier can terminate a running extension
 * child process when its on-disk hash no longer matches the registry row
 * (S7-F10). Without this, a tampered extension would continue executing
 * until the next idle-disconnect.
 */
export interface ExtensionMeshHandle {
  stopExtensionClient(extensionId: string): Promise<void>;
}

/**
 * T2 PR 3 — recover from a Gateway crash mid auto-update swap.
 *
 * If the row's `install_path` (typically `<extRoot>/<id>/active`) is missing,
 * attempt to promote the alphabetically-greatest `_prev/<v>/` entry to
 * `active/`. On success: rewrites `extension.version` to that promoted
 * version, audits `extension.autoUpdate.crash_recovered`, returns `true`.
 * On failure (no `_prev/` or rename fails): hard-disables the row with
 * reason `auto_update_install_path_missing`, returns `false`.
 */
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

  // Neither active/ nor a usable _prev/<v>/ — hard-disable.
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
  // T2 PR 3 — crash recovery runs BEFORE every other check. If active/ went
  // missing (Gateway killed mid-swap) we try to promote _prev/<v>/ to
  // active/; failures hard-disable the row and we short-circuit.
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
    // S7-F8 — constant-time compare for stored hash vs computed hash.
    if (!sha256HexEqualConstantTime(manifestHex, row.manifest_hash)) {
      logger.error(
        { extensionId: row.id, expected: row.manifest_hash, actual: manifestHex },
        "extensions: manifest hash mismatch — extension disabled",
      );
      setExtensionEnabled(db, row.id, false);
      // S7-F10 — kill the running child so a tampered extension stops
      // executing immediately, not at the next idle-disconnect.
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

/**
 * S7-F3 — strict re-verify, intended for the moment immediately before a child
 * spawn. Returns `true` when manifest+entry hashes still match the row, `false`
 * otherwise (in which case the caller must refuse to spawn). Does NOT mutate
 * the row (no side effect on enabled flag); the caller decides remediation.
 */
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

/**
 * Offline-safe dep-graph backfill (Task 12 / spec §4.4 part 1).
 * For every installed extension with no rows in `extension_dependency`,
 * reads its on-disk manifest's `dependsOn` and records the forward edges.
 * Trusts the on-disk manifest — PR 2's signature-verify already proved it
 * authentic upstream. Per-row failures are swallowed (best-effort).
 */
function backfillDependencyRowsBestEffort(
  db: Database,
  installed: ReadonlyMap<string, string>,
  installPathById: ReadonlyMap<string, string>,
  now: number,
  logger: Logger,
): void {
  for (const [id, version] of installed) {
    if (forwardDeps(db, id).length > 0) continue; // already populated
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

/**
 * Startup completeness guard (Task 13 / spec §4.4 part 2). Iterates the
 * `extension_dependency` rows; for each (dependent, dep, range) edge, marks
 * the dependent in {@link missingDependencyRegistry} if the dep is:
 *   - not installed,
 *   - hard-disabled (pre-T2, signature, or already marked by this pass),
 *   - installed at a version that no longer satisfies the recorded `range`.
 *
 * Iterates to fixed point so cascade-disable propagates: A removed → B
 * disabled → C (which depends on B) disabled on the next iteration.
 *
 * Malformed semver ranges are treated as unsatisfied (defensive: a corrupt
 * `range` column from a future schema must not crash the guard).
 *
 * Must run AFTER {@link backfillDependencyRowsBestEffort} (needs populated
 * `extension_dependency` rows) and BEFORE the orphan sweep.
 */
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

/**
 * Defense-in-depth orphan-active sweep (Task 12 / review-fix #2).
 * Removes <extensionsRoot>/<id>/ subtrees where no `extension` row matches
 * the id. Per-node atomicity from Task 9 should make this impossible under
 * normal operation; this catches regressions and old crashes. Never throws.
 */
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

/**
 * T2 PR 2 / I16 — startup signature-verification options. When supplied,
 * `verifyExtensionsBestEffort` runs a second pass after the existing
 * hash-verify sweep that re-checks the Ed25519 manifest signature on every
 * enabled signed extension. Any failure flips `enabled = 0`, records a
 * reason in {@link signatureDisabledRegistry}, and (when `mesh` is supplied)
 * stops the running extension child.
 */
export interface VerifyExtensionsSignatureOpts {
  vault: NimbusVault;
}

/**
 * Verifies enabled extensions: manifest + entry file SHA-256 vs registry columns.
 * Logs warnings on most issues; manifest or entry hash mismatch logs ERROR
 * and disables the extension. When `mesh` is supplied (S7-F10), a hash
 * mismatch additionally calls `mesh.stopExtensionClient(extensionId)` so a
 * tampered extension's running child process is terminated immediately.
 * Updates `last_verified_at` when checks complete.
 *
 * When `signatureOpts` is supplied (T2 PR 2 / I16), a second pass runs after
 * the hash-verify sweep: every enabled signed extension is re-checked for a
 * valid Ed25519 manifest signature against the publisher key cached in the
 * vault. Failures flip `enabled = 0`, mark
 * {@link signatureDisabledRegistry}, and emit a batched
 * `extension.startup_verification` audit entry summarising the run.
 *
 * When `extensionsRoot` is supplied (Task 12), an orphan-active sweep removes
 * any `<extensionsRoot>/<id>/` subtrees whose id has no `extension` row.
 * Additionally, a dep-graph backfill populates `extension_dependency` forward
 * edges from on-disk manifests for any installed extension that has no rows
 * yet. Both passes are network-free and run before the function returns.
 */
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
  // T2 PR 1 — refuse pre-T2 (legacy `permissions: string[]`) extensions at
  // registry-load. The hard-disable runs BEFORE the per-extension verify
  // sweep so a tampered + pre-T2 extension is short-circuited from the
  // running mesh on a single pass. `setExtensionEnabled` flips the row to
  // disabled; the in-memory registry (`preT2DisabledRegistry`) is rebuilt
  // for `extension.list` + `diag.snapshot` to consume.
  const preT2Disabled = hardDisablePreT2Extensions({ db, logger });
  if (mesh !== undefined) {
    for (const row of preT2Disabled) {
      // Best-effort: stop the running child so a pre-T2 extension that was
      // already spawned (e.g. previous Gateway version) stops executing
      // immediately. New spawns are blocked by the disabled flag.
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

  // T2 PR 2 / I16 — startup signature verification. Runs AFTER the hash
  // sweep so a tampered manifest is already disabled by the hash gate when
  // possible; the signature pass catches the remaining vectors (valid hash
  // but the publisher key has rotated, manifest was signed by an unknown
  // publisher, etc.).
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
      // Use the raw parsed JSON for signature verification so canonical bytes
      // match what the publisher signed at install time — `parseExtensionManifestForRegistry`
      // normalizes `permissions` (e.g. legacy `string[]` → default-deny envelope, missing
      // → `{ network: [], filesystem: { read: [], write: [] } }`), which would otherwise
      // produce different canonical bytes than the on-disk JSON. Mirrors the pattern in
      // `install-from-local.ts`.
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

  // Task 12 — dep-graph backfill + orphan-active sweep. Both are network-free
  // and run AFTER all existing passes so only surviving (non-disabled) rows
  // participate. Order matters: backfill first (needs on-disk active/ dirs to
  // exist); sweep second (removes dirs with no row, which backfill skipped
  // anyway since `installed` is keyed by extension rows).
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
