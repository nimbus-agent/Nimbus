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

/**
 * `platform`/`env` default to the live process and exist so the Windows branch can be exercised on
 * any host — every production caller passes neither.
 */
export function resolveSystemTarCommand(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform !== "win32") {
    return "tar";
  }
  const root = env["SystemRoot"] ?? env["windir"];
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
  extensionEntryRelPath,
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
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { verifyManifestSignature } from "./verify-signature.ts";

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const MAX_EXTENSION_ID_LENGTH = 128;

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

async function verifyAndRecordSignature(
  options: {
    db: Database;
    manifest: ExtensionManifest;
    vault?: NimbusVault;
    fetcher?: PublisherKeyFetcher;
    enforceAirGap?: boolean;
    publisherKeyPath?: string;
  },
  destManifest: ExtensionManifest,
  destManifestText: string,
): Promise<void> {
  if (destManifest.publisher === undefined) return;
  if (options.vault === undefined || options.fetcher === undefined) {
    throw new Error(
      "signed-extension install requires vault and publisher key fetcher to be wired",
    );
  }
  const publisherId = destManifest.publisher.id;
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
    await verifyManifestSignature(rawManifestObj, resolvedPubkey);
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
  const { manifest: destManifest } = parseExtensionManifestForRegistry(destManifestText);
  if (
    destManifest.id !== options.manifest.id ||
    destManifest.version !== options.manifest.version
  ) {
    throw new Error("manifest id/version changed across copy");
  }

  if (destManifest.publisher !== undefined) {
    await verifyAndRecordSignature(options, destManifest, destManifestText);
  }

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
  insertExtensionRow(options.db, {
    id: options.manifest.id,
    version: options.manifest.version,
    install_path: options.dest,
    manifest_hash: manifestHex,
    entry_hash: entryHex,
    tree_digest: treeDigest,
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

export function extractTarGzToDirectory(archivePath: string, destDir: string): void {
  const cmd = resolveSystemTarCommand();
  const args = ["-x", "-z"];
  if (process.platform === "linux") {
    args.push("--no-overwrite-dir", "--no-same-owner", "--no-same-permissions");
  }
  args.push(`--file=${resolve(archivePath)}`, `--directory=${resolve(destDir)}`);
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
  approve?: ExtensionInstallApprover;
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
      ...(options.approve !== undefined && { approve: options.approve }),
      displaySourcePath: options.archivePath,
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

type SingleInstallResult = {
  id: string;
  version: string;
  installPath: string;
  manifestHash: string;
  entryHash: string;
  treeDigest: string;
};

/**
 * What the local owner approves before an install writes anything (Non-Negotiable 2: the consent
 * gate lives in the executor, never in a client prompt). Built from the RESOLVED plan, so the owner
 * sees every package the install will add — dependencies included — and nothing is copied, fetched
 * or rowed for a plan they did not approve.
 *
 * `publisher` is what the manifest CLAIMS. The I16 signature is verified after approval, against
 * the copied bytes, and a failure there still rolls the whole install back — so approval never
 * substitutes for verification, it only precedes it.
 */
export type ExtensionInstallApprovalRequest = {
  readonly id: string;
  readonly version: string;
  readonly sourcePath: string;
  /**
   * `fingerprint` is the first 32 hex chars of SHA-256 over the decoded Ed25519 public key. It is
   * deliberately NOT named `key`: the consent display redacts any payload field whose name
   * contains "key" (`executor.ts` `SENSITIVE_PAYLOAD_KEY`), which would hide the one value that
   * lets the owner tell two publishers with the same id apart.
   */
  readonly publisher: { readonly id: string; readonly fingerprint: string } | null;
  readonly permissions: ExtensionManifest["permissions"];
  /** Packages this install adds, root first, then each newly installed dependency. */
  readonly installs: ReadonlyArray<{ readonly id: string; readonly version: string }>;
};

/** Resolves `true` only when the local owner approved; anything else installs nothing. */
export type ExtensionInstallApprover = (
  request: ExtensionInstallApprovalRequest,
) => Promise<boolean>;

export type InstallExtensionFromLocalResult = SingleInstallResult & {
  installed: readonly ResolvedNode[];
};

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

async function fetchDepManifestResponse(opts: {
  registryClient: RegistryClient;
  depId: string;
  depVersion: string;
  abortSignal: AbortSignal;
}): Promise<FetchManifestResponse> {
  try {
    return await opts.registryClient.fetchManifest(opts.depId, opts.depVersion, opts.abortSignal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `dependency install failed: could not fetch manifest for ${opts.depId}@${opts.depVersion}: ${msg}`,
    );
  }
}

async function downloadDepTarball(
  opts: { depId: string; depVersion: string; abortSignal: AbortSignal },
  tarballUrl: string,
): Promise<Uint8Array> {
  try {
    return await downloadTarball(tarballUrl, {
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
}

function extractAndValidateDepSource(
  tmp: string,
  tarballBytes: Uint8Array,
  depId: string,
  depVersion: string,
): { sourceRoot: string; extractedManifest: ExtensionManifest } {
  const tarPath = join(tmp, "dep.tar.gz");
  writeFileSync(tarPath, tarballBytes);

  const extractDir = join(tmp, "extracted");
  mkdirSync(extractDir, { recursive: true });
  extractTarGzToDirectory(tarPath, extractDir);

  const sourceRoot = findExtensionSourceRootInTree(extractDir);

  const srcManifestPath = resolveExtensionManifestPath(sourceRoot);
  if (srcManifestPath === undefined) {
    throw new Error(`dependency ${depId}: manifest missing after extract`);
  }
  const extractedManifest = parseExtensionManifestJson(readFileSync(srcManifestPath, "utf8"));
  if (extractedManifest.id !== depId) {
    throw new Error(
      `dependency id mismatch: registry advertised ${depId} but manifest has ${extractedManifest.id}`,
    );
  }
  if (extractedManifest.version !== depVersion) {
    throw new Error(
      `dependency version mismatch: expected ${depVersion} but manifest has ${extractedManifest.version}`,
    );
  }
  return { sourceRoot, extractedManifest };
}

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
  const fetchResponse = await fetchDepManifestResponse(opts);
  const { tarballUrl, entryHash: expectedEntryHash } = fetchResponse;
  const tarballBytes = await downloadDepTarball(opts, tarballUrl);

  const tmp = mkdtempSync(join(tmpdir(), "nimbus-dep-"));
  try {
    const { sourceRoot, extractedManifest } = extractAndValidateDepSource(
      tmp,
      tarballBytes,
      opts.depId,
      opts.depVersion,
    );

    const dest = extensionInstallDirectory(opts.extensionsDir, opts.depId);

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

    if (result.entryHash.toLowerCase() !== expectedEntryHash.toLowerCase()) {
      try {
        dbRun(opts.db, "DELETE FROM extension WHERE id = ?", [opts.depId]);
      } catch {
        /* best-effort — the rmSync + rethrow are the primary recovery */
      }
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

type SolverFetcher = {
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(
    id: string,
    version: string,
  ): Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }>;
};

function buildLocalSolverFetcher(
  db: Database,
  installedMap: ReadonlyMap<string, string>,
  registryClient: RegistryClient | undefined,
  signal: AbortSignal,
): SolverFetcher {
  return {
    async listVersions(id: string): Promise<readonly string[]> {
      const pinned = installedMap.get(id);
      if (pinned !== undefined) return [pinned];
      if (registryClient === undefined) {
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
        const extRow = listExtensions(db).find((r) => r.id === id);
        if (extRow !== undefined) {
          const mfPath = resolveExtensionManifestPath(extRow.install_path);
          if (mfPath !== undefined) {
            const raw = readFileSync(mfPath, "utf8");
            const mf = parseExtensionManifestJson(raw);
            return {
              id: mf.id,
              version: mf.version,
              ...(mf.dependsOn === undefined ? {} : { dependsOn: mf.dependsOn }),
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
        ...(resp.manifest.dependsOn === undefined ? {} : { dependsOn: resp.manifest.dependsOn }),
      };
    },
  };
}

async function installRootNode(
  options: {
    db: Database;
    extensionsDir: string;
    vault?: NimbusVault;
    fetcher?: PublisherKeyFetcher;
    enforceAirGap?: boolean;
    publisherKeyPath?: string;
  },
  sourceResolved: string,
  manifest: ExtensionManifest,
  registerDir: (dir: string) => void,
): Promise<void> {
  const dest = extensionInstallDirectory(options.extensionsDir, manifest.id);
  if (existsSync(dest)) {
    throw new Error(`extension already installed at ${dest}`);
  }

  scanForSymlinks(sourceResolved);
  mkdirSync(options.extensionsDir, { recursive: true });

  try {
    cpSync(sourceResolved, dest, { recursive: true, dereference: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`extension copy failed: ${msg}`);
  }
  registerDir(dest);

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
}

type InstallPlanNodesOptions = {
  db: Database;
  extensionsDir: string;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
  registryClient?: RegistryClient;
};

async function installDependencyNode(
  node: ResolvedNode,
  options: InstallPlanNodesOptions,
  signal: AbortSignal,
): Promise<string> {
  if (options.registryClient === undefined) {
    throw new Error(
      `cannot install dependency ${node.id}@${node.version}: no registryClient provided`,
    );
  }
  const { dest } = await installDepFromRegistry({
    db: options.db,
    extensionsDir: options.extensionsDir,
    registryClient: options.registryClient,
    depId: node.id,
    depVersion: node.version,
    abortSignal: signal,
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.fetcher !== undefined && { pubkeyFetcher: options.fetcher }),
    ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
  });
  return dest;
}

function rollbackCreatedDirs(createdDirs: readonly string[]): void {
  for (const dir of [...createdDirs].reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort rollback */
    }
  }
}

async function installPlanNodes(
  options: InstallPlanNodesOptions,
  plan: { nodes: readonly ResolvedNode[] },
  sourceResolved: string,
  manifest: ExtensionManifest,
  signal: AbortSignal,
): Promise<void> {
  const createdDirs: string[] = [];
  try {
    // SERIAL by design: `plan.nodes` is topologically ordered (dependencies before dependents),
    // and on the first failure nothing further may start — the catch rolls back exactly the
    // directories created so far.
    for (const node of plan.nodes) {
      if (!node.newlyInstalled) {
        continue;
      }
      if (node.id === manifest.id) {
        await installRootNode(options, sourceResolved, manifest, (dir) => createdDirs.push(dir)); // NOSONAR S9382: topological, fail-fast install order (see above)
      } else {
        createdDirs.push(await installDependencyNode(node, options, signal)); // NOSONAR S9382: topological, fail-fast install order (see above)
      }
    }
  } catch (e) {
    rollbackCreatedDirs(createdDirs);
    throw e;
  }
}

/** Thrown when the owner declined (or the gate timed out); nothing was written. */
export class ExtensionInstallNotApprovedError extends Error {
  constructor(id: string) {
    super(`ERR_EXTENSION_INSTALL_NOT_APPROVED: install of ${id} was not approved`);
    this.name = "ExtensionInstallNotApprovedError";
  }
}

export function publisherKeyFingerprint(base64Key: string): string {
  return createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
}

function buildInstallApprovalRequest(
  manifest: ExtensionManifest,
  plan: { nodes: readonly ResolvedNode[] },
  sourcePath: string,
): ExtensionInstallApprovalRequest {
  const others = plan.nodes
    .filter((n) => n.newlyInstalled && n.id !== manifest.id)
    .map((n) => ({ id: n.id, version: n.version }));
  return {
    id: manifest.id,
    version: manifest.version,
    sourcePath,
    publisher:
      manifest.publisher === undefined
        ? null
        : {
            id: manifest.publisher.id,
            fingerprint: publisherKeyFingerprint(manifest.publisher.key),
          },
    permissions: manifest.permissions,
    installs: [{ id: manifest.id, version: manifest.version }, ...others],
  };
}

function recordPlanInstallAndAudit(
  db: Database,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  hitlStatus: "approved" | "not_required",
): void {
  const now = Date.now();
  db.transaction(() => {
    for (const node of plan.nodes) {
      recordInstall(db, node.id, node.version, node.deps, now);
    }
  })();

  appendAuditEntry(db, {
    actionType: "extension.install_complete",
    hitlStatus,
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
}

function buildRootInstallResult(
  extensionsDir: string,
  manifest: ExtensionManifest,
  plan: { nodes: readonly ResolvedNode[] },
): InstallExtensionFromLocalResult {
  const rootDest = extensionInstallDirectory(extensionsDir, manifest.id);
  const rootManifestPath = resolveExtensionManifestPath(rootDest);
  if (rootManifestPath === undefined) {
    throw new Error("root extension manifest missing after install — install may be corrupt");
  }
  const rootManifestHex = sha256HexOfBytes(readFileSync(rootManifestPath));

  const rootEntryRel = extensionEntryRelPath(manifest);
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
    treeDigest: computeExtensionTreeDigest(rootDest),
    installed: plan.nodes,
  };
}

export async function installExtensionFromLocalDirectory(options: {
  db: Database;
  extensionsDir: string;
  sourcePath: string;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
  registryClient?: RegistryClient;
  abortSignal?: AbortSignal;
  /**
   * The local owner's approval, asked after the plan resolves and before anything is written. The
   * production IPC path always supplies one (`ipc/automation-rpc.ts`); a direct library call
   * without one installs ungated and records the install audit row as `not_required`, never as
   * `approved`.
   */
  approve?: ExtensionInstallApprover;
  /** The path to show the owner when `sourcePath` is an archive's temporary extraction. */
  displaySourcePath?: string;
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
      ...(options.approve !== undefined && { approve: options.approve }),
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

  const { installed: installedMap, activeConstraints } = buildSolverInputs(options.db);

  const signal = options.abortSignal ?? new AbortController().signal;

  const solverFetcher = buildLocalSolverFetcher(
    options.db,
    installedMap,
    options.registryClient,
    signal,
  );

  const plan = await resolveClosure(manifest, solverFetcher, {
    installed: installedMap,
    activeConstraints,
  });

  if (options.approve !== undefined) {
    const approved = await options.approve(
      buildInstallApprovalRequest(manifest, plan, options.displaySourcePath ?? sourceResolved),
    );
    if (!approved) {
      throw new ExtensionInstallNotApprovedError(manifest.id);
    }
  }

  await installPlanNodes(options, plan, sourceResolved, manifest, signal);

  recordPlanInstallAndAudit(
    options.db,
    plan,
    manifest,
    options.approve === undefined ? "not_required" : "approved",
  );

  return buildRootInstallResult(options.extensionsDir, manifest, plan);
}
