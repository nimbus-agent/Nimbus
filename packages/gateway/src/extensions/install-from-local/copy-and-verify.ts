import type { Database } from "bun:sqlite";
import {
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isStarterPack } from "@nimbus-dev/registry-format";
import {
  insertExtensionRow,
  listExtensions,
  setExtensionPublisherKeyFingerprint,
} from "../../automation/extension-store.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { NimbusVault } from "../../vault/index.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { resolvePublisherKey, writePublisherKeyFor } from "../publisher-keys.ts";
import { computeExtensionTreeDigest } from "../tree-digest.ts";
import { verifyManifestSignature } from "../verify-signature.ts";
import { extensionInstallDirectory, sha256HexOfBytes } from "./_shared.ts";
import type { CreatedPackage, NodeInstallOptions, SingleInstallResult } from "./types.ts";

async function verifyAndRecordSignature(
  options: {
    db: Database;
    manifest: ExtensionManifest;
    vault?: NimbusVault;
    publisherKeyPath?: string;
    publisherKey?: Uint8Array;
  },
  destManifest: ExtensionManifest,
  destManifestText: string,
): Promise<string | null> {
  if (destManifest.publisher === undefined) return null;
  if (options.vault === undefined) {
    throw new Error("signed-extension install requires the vault to be wired");
  }
  const publisherId = destManifest.publisher.id;
  const rawManifestObj = JSON.parse(destManifestText) as Record<string, unknown>;
  const vault = options.vault;
  let verifiedFingerprint: string | null = null;
  try {
    // A key passed explicitly (a registry install: the signed index named it) replaces the
    // path/Vault resolution entirely, but must still be the key the manifest declares. A local
    // install never fetches a key: `--publisher-key`, else the Vault's cached key, else refused.
    let resolvedPubkey: Uint8Array;
    if (options.publisherKey === undefined) {
      resolvedPubkey = await resolvePublisherKey({
        publisherId,
        explicitKeyPath: options.publisherKeyPath,
        vault,
        declaredKey: destManifest.publisher.key,
      });
    } else {
      resolvedPubkey = options.publisherKey;
      const declared = Buffer.from(destManifest.publisher.key, "base64");
      if (!Buffer.from(resolvedPubkey).equals(declared)) {
        throw new Error("manifest publisher key differs from the key supplied for this install");
      }
    }
    await verifyManifestSignature(rawManifestObj, resolvedPubkey);
    verifiedFingerprint = await writePublisherKeyFor(vault, publisherId, resolvedPubkey);
    appendAuditEntry(options.db, {
      actionType: "extension.signature_verified",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        id: options.manifest.id,
        publisher_id: publisherId,
        verified_at_ms: Date.now(),
      }),
      timestamp: Date.now(),
    });
  } catch (err) {
    appendAuditEntry(options.db, {
      actionType: "extension.signature_failed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        id: options.manifest.id,
        publisher_id: publisherId,
        error: err instanceof Error ? err.name : "Unknown",
        message: err instanceof Error ? err.message : String(err),
      }),
      timestamp: Date.now(),
    });
    throw err;
  }
  return verifiedFingerprint;
}

async function completeExtensionInstallAfterCopy(options: {
  db: Database;
  dest: string;
  manifest: ExtensionManifest;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
  /** Called once the row's transaction has committed, so a rollback knows the row exists. */
  onRowCommitted?: () => void;
}): Promise<SingleInstallResult> {
  const destManifestPath = resolveExtensionManifestPath(options.dest);
  if (destManifestPath === undefined) {
    throw new Error("extension manifest missing after copy");
  }
  const destManifestBytes = readFileSync(destManifestPath);
  const manifestHex = sha256HexOfBytes(destManifestBytes);
  const destManifestText = destManifestBytes.toString("utf8");
  const { manifest: destManifest } = parseExtensionManifestForRegistry(destManifestText);
  if (
    destManifest.id !== options.manifest.id ||
    destManifest.version !== options.manifest.version
  ) {
    throw new Error("manifest id/version changed across copy");
  }

  const verifiedKeyFingerprint =
    destManifest.publisher === undefined
      ? null
      : await verifyAndRecordSignature(options, destManifest, destManifestText);

  const entryRelRaw = extensionEntryRelPath(destManifest);
  if (entryRelRaw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entryRelRaw)) {
    throw new Error("extension entry must be a relative path");
  }
  const entryPath = assertEntryInsideInstall(options.dest, entryRelRaw);
  if (!existsSync(entryPath)) {
    throw new Error(`extension entry file missing: ${entryRelRaw}`);
  }
  const entryBytes = readFileSync(entryPath);
  const entryHex = sha256HexOfBytes(entryBytes);
  const treeDigest = computeExtensionTreeDigest(options.dest);

  const now = Date.now();
  // One transaction: a signed row never exists without the key that verified it.
  options.db.transaction(() => {
    insertExtensionRow(options.db, {
      id: options.manifest.id,
      version: options.manifest.version,
      install_path: options.dest,
      manifest_hash: manifestHex,
      entry_hash: entryHex,
      tree_digest: treeDigest,
      // From the manifest just verified at the destination, never the caller's copy.
      kind: isStarterPack(destManifest) ? "starter-pack" : "extension",
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    if (verifiedKeyFingerprint !== null && readIndexedUserVersion(options.db) >= 76) {
      setExtensionPublisherKeyFingerprint(options.db, options.manifest.id, verifiedKeyFingerprint);
    }
  })();
  options.onRowCommitted?.();

  return {
    id: options.manifest.id,
    version: options.manifest.version,
    installPath: options.dest,
    manifestHash: manifestHex,
    entryHash: entryHex,
    treeDigest,
  };
}

function scanForSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`extension source contains a symlink: ${full}`);
      }
      if (st.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

function assertEntryInsideInstall(installRoot: string, entryRel: string): string {
  const absRoot = resolve(installRoot);
  const absEntry = resolve(join(installRoot, entryRel));
  const rel = relative(absRoot, absEntry);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.split(sep).includes("..")) {
    throw new Error("extension entry path escapes install directory");
  }
  return absEntry;
}

/**
 * Whether an extension row owns `dest`, the install directory of `id`: a row with that id, or one
 * whose `install_path` resolves to `dest`. Matching the id as well means a live install is never
 * called a leftover when its stored path differs from `dest` only in case, or the extensions
 * directory has moved.
 */
export function installDirectoryIsOwned(db: Database, id: string, dest: string): boolean {
  const target = resolve(dest);
  return listExtensions(db).some((r) => r.id === id || resolve(r.install_path) === target);
}

/** The refusal for a directory no extension row owns (see {@link installDirectoryIsOwned}). */
export function leftoverDirectoryMessage(dest: string): string {
  return `a directory from an earlier failed install is in the way at ${dest}; remove it and retry`;
}

export async function installRootNode(
  options: NodeInstallOptions,
  sourceResolved: string,
  manifest: ExtensionManifest,
  created: CreatedPackage[],
): Promise<SingleInstallResult> {
  const dest = extensionInstallDirectory(options.extensionsDir, manifest.id);
  if (existsSync(dest)) {
    // A directory no extension row owns is what an earlier install left behind (a rollback that
    // could not remove it, or a crash), not an installed extension: say which, so the owner knows
    // removing the directory is safe.
    throw new Error(
      installDirectoryIsOwned(options.db, manifest.id, dest)
        ? `extension already installed at ${dest}`
        : leftoverDirectoryMessage(dest),
    );
  }

  scanForSymlinks(sourceResolved);
  mkdirSync(options.extensionsDir, { recursive: true });

  const record: CreatedPackage = { dir: dest, id: null };
  created.push(record);
  try {
    cpSync(sourceResolved, dest, { recursive: true, dereference: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`extension copy failed: ${msg}`);
  }

  return await completeExtensionInstallAfterCopy({
    db: options.db,
    dest,
    manifest,
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.publisherKeyPath !== undefined && {
      publisherKeyPath: options.publisherKeyPath,
    }),
    ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
    onRowCommitted: () => {
      record.id = manifest.id;
    },
  });
}
