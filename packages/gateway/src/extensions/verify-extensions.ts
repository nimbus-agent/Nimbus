import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import {
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
  touchExtensionVerifiedAt,
} from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { hardDisablePreT2Extensions, signatureDisabledRegistry } from "./hard-disable.ts";
import {
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
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

async function verifyOneExtension(
  db: Database,
  logger: Logger,
  row: ExtensionRow,
  now: number,
  mesh?: ExtensionMeshHandle,
): Promise<void> {
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
 */
export async function verifyExtensionsBestEffort(
  db: Database,
  logger: Logger,
  mesh?: ExtensionMeshHandle,
  signatureOpts?: VerifyExtensionsSignatureOpts,
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
}
