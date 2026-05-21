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
  writeFileSync,
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

import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { dbRun } from "../db/write.ts";
import type { NimbusVault } from "../vault/index.ts";
import { downloadTarball, MAX_TARBALL_BYTES } from "./auto-update-apply.ts";
import { resolveClosure } from "./dependency-graph.ts";
import { recordInstall } from "./dependency-store.ts";
import type { ResolvedNode } from "./dependency-types.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { resolvePublisherKey, writePublisherKey } from "./publisher-keys.ts";
import type {
  FetchManifestResponse,
  PublisherKeyFetcher,
  RegistryClient,
} from "./registry-client.ts";
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
}): Promise<SingleInstallResult> {
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

/** Internal result shape returned by completeExtensionInstallAfterCopy — no closure info. */
type SingleInstallResult = {
  id: string;
  version: string;
  installPath: string;
  manifestHash: string;
  entryHash: string;
};

export type InstallExtensionFromLocalResult = SingleInstallResult & {
  /**
   * All nodes in the resolved install closure, leaf-first. Includes the root
   * extension and every newly-installed or already-present dependency.
   * Added in T2 PR 4. Single-extension installs (no dependsOn) return a
   * one-element array containing only the root node.
   */
  installed: readonly ResolvedNode[];
};

/**
 * Build the `installed` and `activeConstraints` maps needed by the solver from
 * the current DB state. For each installed extension we attempt to read its
 * on-disk manifest and extract `dependsOn`; unreadable/malformed manifests are
 * silently skipped (the solver will still see the pinned version).
 */
function buildSolverInputs(db: Database): {
  installed: ReadonlyMap<string, string>;
  activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
} {
  const rows = listExtensions(db);
  const installed = new Map<string, string>();
  const activeConstraints = new Map<string, ReadonlyMap<string, string>>();
  for (const row of rows) {
    installed.set(row.id, row.version);
    const manifestPath = resolveExtensionManifestPath(row.install_path);
    if (manifestPath === undefined) continue;
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const mf = parseExtensionManifestJson(raw);
      if (mf.dependsOn !== undefined && Object.keys(mf.dependsOn).length > 0) {
        activeConstraints.set(row.id, new Map(Object.entries(mf.dependsOn)));
      }
    } catch {
      // Unreadable / malformed manifest — skip. The signature-verify startup
      // pass (I16) is the authoritative check; here we just skip gracefully.
    }
  }
  return { installed, activeConstraints };
}

/**
 * Install a single dependency node from the registry: fetch the manifest,
 * download the tarball, extract it into a temp dir, and call
 * completeExtensionInstallAfterCopy. Returns the install result.
 *
 * v1 limitation: the registry exposes only the latest version (no
 * `listVersions` endpoint), so the solver receives exactly one candidate
 * version per dep. If the caller needs a different version than "latest", that
 * would require a richer registry API — deferred to a future PR.
 */
async function installDepFromRegistry(opts: {
  db: Database;
  extensionsDir: string;
  registryClient: RegistryClient;
  depId: string;
  depVersion: string;
  abortSignal: AbortSignal;
  vault?: NimbusVault;
  pubkeyFetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
}): Promise<{ dest: string; result: SingleInstallResult }> {
  let fetchResponse: FetchManifestResponse;
  try {
    fetchResponse = await opts.registryClient.fetchManifest(
      opts.depId,
      opts.depVersion,
      opts.abortSignal,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `dependency install failed: could not fetch manifest for ${opts.depId}@${opts.depVersion}: ${msg}`,
    );
  }

  const { tarballUrl, entryHash: expectedEntryHash } = fetchResponse;
  let tarballBytes: Uint8Array;
  try {
    tarballBytes = await downloadTarball(tarballUrl, {
      fetcher: fetch,
      maxBytes: MAX_TARBALL_BYTES,
      signal: opts.abortSignal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `dependency install failed: could not download tarball for ${opts.depId}@${opts.depVersion}: ${msg}`,
    );
  }

  // Extract to a temp directory.
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-dep-"));
  try {
    // Write tarball to disk so extractTarGzToDirectory can read it.
    const tarPath = join(tmp, "dep.tar.gz");
    writeFileSync(tarPath, tarballBytes);

    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir, { recursive: true });
    extractTarGzToDirectory(tarPath, extractDir);

    const sourceRoot = findExtensionSourceRootInTree(extractDir);

    // Validate the extracted manifest matches what the registry advertised.
    const srcManifestPath = resolveExtensionManifestPath(sourceRoot);
    if (srcManifestPath === undefined) {
      throw new Error(`dependency ${opts.depId}: manifest missing after extract`);
    }
    const extractedManifest = parseExtensionManifestJson(readFileSync(srcManifestPath, "utf8"));
    if (extractedManifest.id !== opts.depId) {
      throw new Error(
        `dependency id mismatch: registry advertised ${opts.depId} but manifest has ${extractedManifest.id}`,
      );
    }
    if (extractedManifest.version !== opts.depVersion) {
      throw new Error(
        `dependency version mismatch: expected ${opts.depVersion} but manifest has ${extractedManifest.version}`,
      );
    }

    const dest = extensionInstallDirectory(opts.extensionsDir, opts.depId);

    // S7-F5 — same symlink sweep as the user-provided source path.
    scanForSymlinks(sourceRoot);
    mkdirSync(opts.extensionsDir, { recursive: true });

    try {
      cpSync(sourceRoot, dest, { recursive: true, dereference: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`dependency copy failed: ${msg}`);
    }

    const result = await completeExtensionInstallAfterCopy({
      db: opts.db,
      dest,
      manifest: extractedManifest,
      ...(opts.vault !== undefined && { vault: opts.vault }),
      ...(opts.pubkeyFetcher !== undefined && { fetcher: opts.pubkeyFetcher }),
      ...(opts.enforceAirGap !== undefined && { enforceAirGap: opts.enforceAirGap }),
    });

    // Sanity-check: the entry hash from the registry must match the installed
    // entry hash. This is a defence against tarball substitution attacks.
    if (result.entryHash.toLowerCase() !== expectedEntryHash.toLowerCase()) {
      // Roll back the extension row that completeExtensionInstallAfterCopy
      // inserted, so the next Gateway startup doesn't see a row pointing at a
      // missing directory and hard-disable it with a misleading reason.
      try {
        dbRun(opts.db, "DELETE FROM extension WHERE id = ?", [opts.depId]);
      } catch {
        /* best-effort — the rmSync + rethrow are the primary recovery */
      }
      // Roll back the installed dep from disk.
      rmSync(dest, { recursive: true, force: true });
      throw new Error(
        `dependency entry hash mismatch for ${opts.depId}@${opts.depVersion}: ` +
          `expected ${expectedEntryHash} got ${result.entryHash}`,
      );
    }

    return { dest, result };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort temp-dir cleanup */
    }
  }
}

/**
 * Copies a local extension directory (or extracts `.tar.gz` / `.tgz`) into
 * `extensionsDir`, resolves and installs the full dependency closure (T2 PR 4),
 * computes manifest/entry hashes, inserts DB rows. Rolls back any newly-created
 * directories on failure.
 *
 * When `registryClient` is omitted, the solver still runs but has no way to
 * fetch uninstalled deps — it will throw `OfflineDependencyResolutionError` if
 * the root manifest lists deps that are not already on disk. For zero-dep
 * extensions this is not an issue.
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
  /**
   * Registry client for fetching dependency tarballs (T2 PR 4). When absent,
   * deps that are not already installed on disk will cause an
   * OfflineDependencyResolutionError at solver time.
   */
  registryClient?: RegistryClient;
  /** AbortSignal forwarded to registry HTTP calls for dependency installs. */
  abortSignal?: AbortSignal;
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
      ...(options.registryClient !== undefined && { registryClient: options.registryClient }),
      ...(options.abortSignal !== undefined && { abortSignal: options.abortSignal }),
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

  // ── Solver: resolve the full dependency closure (T2 PR 4) ───────────────────
  //
  // We run the solver even for zero-dep extensions so the code path is uniform.
  // For a zero-dep root it returns a single-node plan trivially.
  const { installed: installedMap, activeConstraints } = buildSolverInputs(options.db);

  const signal = options.abortSignal ?? new AbortController().signal;

  // Build the RegistryFetcher for the solver.
  //
  // v1: the registry only exposes `fetchLatestVersion` (not `listVersions`), so
  // for deps that are not already installed we return a single-element array
  // containing the latest version. The solver picks that version if it satisfies
  // the range, or throws DependencyConflictError(unsatisfiable). Full
  // multi-version backtracking is deferred to a future PR when the registry
  // adds a `listVersions` endpoint.
  const registryClient = options.registryClient;
  const solverFetcher = {
    async listVersions(id: string): Promise<readonly string[]> {
      const pinned = installedMap.get(id);
      if (pinned !== undefined) return [pinned];
      if (registryClient === undefined) {
        // No registry — the solver will surface OfflineDependencyResolutionError.
        return [];
      }
      const latest = await registryClient.fetchLatestVersion(id, "stable", signal);
      if (latest === null) {
        return [];
      }
      return [latest.version];
    },
    async fetchManifest(
      id: string,
      version: string,
    ): Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }> {
      const pinned = installedMap.get(id);
      if (pinned === version) {
        // Read from disk (local-first, same as createRegistryFetcher).
        const extRow = listExtensions(options.db).find((r) => r.id === id);
        if (extRow !== undefined) {
          const mfPath = resolveExtensionManifestPath(extRow.install_path);
          if (mfPath !== undefined) {
            const raw = readFileSync(mfPath, "utf8");
            const mf = parseExtensionManifestJson(raw);
            return {
              id: mf.id,
              version: mf.version,
              ...(mf.dependsOn !== undefined ? { dependsOn: mf.dependsOn } : {}),
            };
          }
        }
      }
      if (registryClient === undefined) {
        throw new Error(`registry unavailable: cannot fetch manifest for ${id}@${version}`);
      }
      const resp = await registryClient.fetchManifest(id, version, signal);
      return {
        id: resp.manifest.id,
        version: resp.manifest.version,
        ...(resp.manifest.dependsOn !== undefined ? { dependsOn: resp.manifest.dependsOn } : {}),
      };
    },
  };

  // Errors from the solver (DependencyConflictError / OfflineDependencyResolutionError)
  // are thrown verbatim — no disk mutation has occurred at this point.
  const plan = await resolveClosure(manifest, solverFetcher, {
    installed: installedMap,
    activeConstraints,
  });

  // ── Install loop ─────────────────────────────────────────────────────────────
  //
  // Iterate leaf-first (as returned by the solver). Track every directory we
  // create so we can roll back on failure.
  const createdDirs: string[] = [];

  try {
    for (const node of plan.nodes) {
      if (!node.newlyInstalled) {
        // Already installed at the satisfying version — skip.
        continue;
      }

      if (node.id === manifest.id) {
        // Root extension: use the existing copy-from-source path.
        const dest = extensionInstallDirectory(options.extensionsDir, manifest.id);
        if (existsSync(dest)) {
          throw new Error(`extension already installed at ${dest}`);
        }

        // S7-F5 — symlink sweep.
        scanForSymlinks(sourceResolved);
        mkdirSync(options.extensionsDir, { recursive: true });

        try {
          cpSync(sourceResolved, dest, { recursive: true, dereference: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`extension copy failed: ${msg}`);
        }
        createdDirs.push(dest);

        await completeExtensionInstallAfterCopy({
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
      } else {
        // Dependency node: fetch from registry, extract, install.
        if (registryClient === undefined) {
          throw new Error(
            `cannot install dependency ${node.id}@${node.version}: no registryClient provided`,
          );
        }
        const { dest } = await installDepFromRegistry({
          db: options.db,
          extensionsDir: options.extensionsDir,
          registryClient,
          depId: node.id,
          depVersion: node.version,
          abortSignal: signal,
          ...(options.vault !== undefined && { vault: options.vault }),
          ...(options.fetcher !== undefined && { pubkeyFetcher: options.fetcher }),
          ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
        });
        createdDirs.push(dest);
      }
    }
  } catch (e) {
    // Roll back every directory we created, in reverse order (leaf-first reversal = root-first).
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try {
        rmSync(createdDirs[i] as string, { recursive: true, force: true });
      } catch {
        /* best-effort rollback */
      }
    }
    throw e;
  }

  // ── Persistence: record dependency edges in one transaction ─────────────────
  const now = Date.now();
  options.db.transaction(() => {
    for (const node of plan.nodes) {
      recordInstall(options.db, node.id, node.version, node.deps, now);
    }
  })();

  // ── Audit row ────────────────────────────────────────────────────────────────
  appendAuditEntry(options.db, {
    actionType: "extension.install_complete",
    hitlStatus: "approved",
    actionJson: JSON.stringify({
      root: manifest.id,
      rootVersion: manifest.version,
      installed: plan.nodes.map((n) => ({
        id: n.id,
        version: n.version,
        newlyInstalled: n.newlyInstalled,
        deps: Object.fromEntries(n.deps.map((d) => [d.id, d.range])),
      })),
    }),
    timestamp: now,
  });

  // ── Assemble the result ──────────────────────────────────────────────────────
  // Read the root's hashes from the DB (they were written by completeExtensionInstallAfterCopy).
  const rootDest = extensionInstallDirectory(options.extensionsDir, manifest.id);
  const rootManifestPath = resolveExtensionManifestPath(rootDest);
  if (rootManifestPath === undefined) {
    throw new Error("root extension manifest missing after install — install may be corrupt");
  }
  const rootManifestBytes = readFileSync(rootManifestPath);
  const rootManifestHex = sha256HexOfBytes(rootManifestBytes);

  const rootEntryRel =
    manifest.entry !== undefined && manifest.entry !== "" ? manifest.entry : "dist/index.js";
  const rootEntryPath = join(rootDest, rootEntryRel);
  const rootEntryHex = existsSync(rootEntryPath)
    ? sha256HexOfBytes(readFileSync(rootEntryPath))
    : "";

  return {
    id: manifest.id,
    version: manifest.version,
    installPath: rootDest,
    manifestHash: rootManifestHex,
    entryHash: rootEntryHex,
    installed: plan.nodes,
  };
}
