import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/** Windows PATH often lists Git's GNU tar before the inbox BSD tar; GNU tar mishandles Win32 paths here. */
export function resolveSystemTarCommand(): string {
  if (process.platform !== "win32") {
    return "tar";
  }
  const root = process.env["SystemRoot"] ?? process.env["windir"];
  if (root !== undefined && root !== "") {
    return join(root, "System32", "tar.exe");
  }
  return join("C:", "Windows", "System32", "tar.exe");
}

import { insertExtensionRow } from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { NimbusVault } from "../vault/index.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { resolvePublisherKey, writePublisherKey } from "./publisher-keys.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
import { verifyManifestSignature } from "./verify-signature.ts";

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * S7-F9 — extension IDs are reflected into filesystem paths under the
 * platform-specific extensions dir. Windows MAX_PATH is 260 chars; this cap
 * leaves enough headroom for the install dir prefix (`<configDir>/extensions/`)
 * and the longest entry filename without overflowing.
 */
const MAX_EXTENSION_ID_LENGTH = 128;

/** Reject ids that could escape the extensions directory when joined. */
export function assertSafeExtensionId(extensionId: string): void {
  if (extensionId.trim() === "" || extensionId.includes("\0")) {
    throw new Error("invalid extension id");
  }
  if (extensionId.length > MAX_EXTENSION_ID_LENGTH) {
    throw new Error(
      `extension id too long (max ${String(MAX_EXTENSION_ID_LENGTH)} chars, got ${String(extensionId.length)})`,
    );
  }
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) {
    throw new Error("invalid extension id");
  }
  for (const p of parts) {
    if (p === "..") {
      throw new Error("invalid extension id");
    }
  }
}

export function extensionInstallDirectory(extensionsDir: string, extensionId: string): string {
  assertSafeExtensionId(extensionId);
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  return join(extensionsDir, ...parts);
}

async function completeExtensionInstallAfterCopy(options: {
  db: Database;
  dest: string;
  manifest: ExtensionManifest;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
}): Promise<InstallExtensionFromLocalResult> {
  const destManifestPath = resolveExtensionManifestPath(options.dest);
  if (destManifestPath === undefined) {
    throw new Error("extension manifest missing after copy");
  }
  const destManifestBytes = readFileSync(destManifestPath);
  const manifestHex = sha256HexOfBytes(destManifestBytes);
  const destManifestText = destManifestBytes.toString("utf8");
  // Use the registry parser so we see publisher + signature fields if present.
  const { manifest: destManifest } = parseExtensionManifestForRegistry(destManifestText);
  if (
    destManifest.id !== options.manifest.id ||
    destManifest.version !== options.manifest.version
  ) {
    throw new Error("manifest id/version changed across copy");
  }

  // I16 — signed-manifest verification. Only fires when the manifest has a
  // publisher block; unsigned manifests install unchanged.
  if (destManifest.publisher !== undefined) {
    if (options.vault === undefined || options.fetcher === undefined) {
      throw new Error(
        "signed-extension install requires vault and publisher key fetcher to be wired",
      );
    }
    const publisherId = destManifest.publisher.id;
    // Re-parse the raw manifest bytes from disk so we sign over the *exact*
    // canonicalized bytes the verifier will see (matches the on-disk JSON).
    const rawManifestObj = JSON.parse(destManifestText) as Record<string, unknown>;
    const vault = options.vault;
    try {
      const resolvedPubkey = await resolvePublisherKey({
        publisherId,
        explicitKeyPath: options.publisherKeyPath,
        vault,
        fetcher: options.fetcher,
        enforceAirGap: options.enforceAirGap ?? false,
      });
      await verifyManifestSignature(
        rawManifestObj as {
          publisher?: { id: string; key: string };
          signature?: string;
          [k: string]: unknown;
        },
        resolvedPubkey,
      );
      // Success — cache the resolved pubkey + write the verified audit row.
      await writePublisherKey(vault, publisherId, resolvedPubkey);
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
  }

  const entryRelRaw =
    destManifest.entry !== undefined && destManifest.entry !== ""
      ? destManifest.entry
      : "dist/index.js";
  if (entryRelRaw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entryRelRaw)) {
    throw new Error("extension entry must be a relative path");
  }
  const entryPath = assertEntryInsideInstall(options.dest, entryRelRaw);
  if (!existsSync(entryPath)) {
    throw new Error(`extension entry file missing: ${entryRelRaw}`);
  }
  const entryBytes = readFileSync(entryPath);
  const entryHex = sha256HexOfBytes(entryBytes);

  const now = Date.now();
  insertExtensionRow(options.db, {
    id: options.manifest.id,
    version: options.manifest.version,
    install_path: options.dest,
    manifest_hash: manifestHex,
    entry_hash: entryHex,
    enabled: 1,
    installed_at: now,
    last_verified_at: now,
  });

  return {
    id: options.manifest.id,
    version: options.manifest.version,
    installPath: options.dest,
    manifestHash: manifestHex,
    entryHash: entryHex,
  };
}

/**
 * S7-F5 — recursively reject symlinks. Used both for source-directory installs
 * (pre-copy) and post-extract sweeps for tar archives.
 */
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

/** Check a single extracted entry; throws on path-escape or symlink. Pushes subdirectories onto `stack`. */
function checkExtractedEntry(absRoot: string, dir: string, ent: Dirent, stack: string[]): void {
  const full = join(dir, ent.name);
  const rel = relative(absRoot, resolve(full));
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`archive entry escapes install root: ${full}`);
  }
  const st = lstatSync(full);
  if (st.isSymbolicLink()) {
    throw new Error(`archive contains symlink: ${full}`);
  }
  if (st.isDirectory()) stack.push(full);
}

/**
 * S7-F4 — post-extract path-traversal sweep. Even if `tar` ignored an entry's
 * `..` prefix, a final-path resolve must stay inside destDir.
 */
function assertNoEntryEscapes(destDir: string): void {
  const absRoot = resolve(destDir);
  const stack: string[] = [absRoot];
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
      checkExtractedEntry(absRoot, dir, ent, stack);
    }
  }
}

function extractTarGzToDirectory(archivePath: string, destDir: string): void {
  const cmd = resolveSystemTarCommand();
  // S7-F4 — explicit safety flags. GNU tar honours these; BSD tar (Windows
  // inbox) ignores unknown options. The post-extract sweep is the structural
  // backstop regardless.
  const args = ["-xzf", archivePath, "-C", destDir];
  if (process.platform === "linux") {
    // GNU-tar-only safety flags. bsdtar (macOS, Windows inbox) rejects
    // --no-overwrite-dir with a non-zero exit; the assertNoEntryEscapes sweep
    // below is the structural backstop on all platforms.
    args.push("--no-overwrite-dir", "--no-same-owner", "--no-same-permissions");
  }
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    const output = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
    const detail = output || `exit ${String(r.status)}`;
    throw new Error(`failed to extract archive: ${detail}`);
  }
  assertNoEntryEscapes(destDir);
}

async function installExtensionFromArchive(options: {
  db: Database;
  extensionsDir: string;
  archivePath: string;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
}): Promise<InstallExtensionFromLocalResult> {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-tgz-"));
  try {
    extractTarGzToDirectory(options.archivePath, tmp);
    const root = findExtensionSourceRootInTree(tmp);
    return await installExtensionFromLocalDirectory({
      db: options.db,
      extensionsDir: options.extensionsDir,
      sourcePath: root,
      ...(options.vault !== undefined && { vault: options.vault }),
      ...(options.fetcher !== undefined && { fetcher: options.fetcher }),
      ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function findExtensionSourceRootInTree(extractedRoot: string): string {
  if (resolveExtensionManifestPath(extractedRoot) !== undefined) {
    return extractedRoot;
  }
  for (const ent of readdirSync(extractedRoot, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const sub = join(extractedRoot, ent.name);
      if (resolveExtensionManifestPath(sub) !== undefined) {
        return sub;
      }
    }
  }
  throw new Error(
    "archive does not contain nimbus.extension.json (at root or one subdirectory deep)",
  );
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

export type InstallExtensionFromLocalResult = {
  id: string;
  version: string;
  installPath: string;
  manifestHash: string;
  entryHash: string;
};

/**
 * Copies a local extension directory (or extracts `.tar.gz` / `.tgz`) into `extensionsDir`,
 * computes manifest/entry hashes, inserts DB row. Rolls back the copy if the DB insert fails.
 */
export async function installExtensionFromLocalDirectory(options: {
  db: Database;
  extensionsDir: string;
  sourcePath: string;
  /** Vault used to cache verified publisher pubkeys (I16). */
  vault?: NimbusVault;
  /** Registry client used to fetch unknown publisher pubkeys (I16). */
  fetcher?: PublisherKeyFetcher;
  /** When true, never reach the registry; rely on vault cache or explicit key. */
  enforceAirGap?: boolean;
  /** Path to a 44-char base64 publisher public-key file (`--publisher-key`). */
  publisherKeyPath?: string;
}): Promise<InstallExtensionFromLocalResult> {
  const sourceResolved = resolve(options.sourcePath);
  if (!existsSync(sourceResolved)) {
    throw new Error("extension source path does not exist");
  }
  const st = statSync(sourceResolved);
  if (st.isFile()) {
    const lower = sourceResolved.toLowerCase();
    if (!lower.endsWith(".tar.gz") && !lower.endsWith(".tgz")) {
      throw new Error("extension source file must be a .tar.gz or .tgz archive");
    }
    return await installExtensionFromArchive({
      db: options.db,
      extensionsDir: options.extensionsDir,
      archivePath: sourceResolved,
      ...(options.vault !== undefined && { vault: options.vault }),
      ...(options.fetcher !== undefined && { fetcher: options.fetcher }),
      ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
    });
  }
  if (!st.isDirectory()) {
    throw new Error("extension source path must be a directory or .tar.gz archive");
  }

  const srcManifestPath = resolveExtensionManifestPath(sourceResolved);
  if (srcManifestPath === undefined) {
    throw new Error(
      "extension manifest not found (expected nimbus.extension.json or nimbus-extension.json)",
    );
  }

  const manifestBytes = readFileSync(srcManifestPath);
  const manifest = parseExtensionManifestJson(manifestBytes.toString("utf8"));

  const dest = extensionInstallDirectory(options.extensionsDir, manifest.id);
  if (existsSync(dest)) {
    throw new Error(`extension already installed at ${dest}`);
  }

  // S7-F5 — recursively reject symlinks inside the source tree before copy.
  // Even with { dereference: true } there is an in-flight TOCTOU between lstat
  // and cpSync; rejecting outright is the simpler and stronger guarantee.
  scanForSymlinks(sourceResolved);

  mkdirSync(options.extensionsDir, { recursive: true });

  try {
    cpSync(sourceResolved, dest, { recursive: true, dereference: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`extension copy failed: ${msg}`);
  }

  try {
    return await completeExtensionInstallAfterCopy({
      db: options.db,
      dest,
      manifest,
      ...(options.vault !== undefined && { vault: options.vault }),
      ...(options.fetcher !== undefined && { fetcher: options.fetcher }),
      ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
    });
  } catch (e) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* best-effort rollback */
    }
    throw e;
  }
}
