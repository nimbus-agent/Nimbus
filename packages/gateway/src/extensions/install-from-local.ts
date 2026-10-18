import type { Database } from "bun:sqlite";
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

import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { NimbusVault } from "../vault/index.ts";
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
import { extractPackage } from "./package-extract.ts";
import { resolvePublisherKey, writePublisherKey } from "./publisher-keys.ts";
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
    publisherKeyPath?: string;
    publisherKey?: Uint8Array;
  },
  destManifest: ExtensionManifest,
  destManifestText: string,
): Promise<void> {
  if (destManifest.publisher === undefined) return;
  if (options.vault === undefined) {
    throw new Error("signed-extension install requires the vault to be wired");
  }
  const publisherId = destManifest.publisher.id;
  const rawManifestObj = JSON.parse(destManifestText) as Record<string, unknown>;
  const vault = options.vault;
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
      });
    } else {
      resolvedPubkey = options.publisherKey;
      const declared = Buffer.from(destManifest.publisher.key, "base64");
      if (!Buffer.from(resolvedPubkey).equals(declared)) {
        throw new Error("manifest publisher key differs from the key supplied for this install");
      }
    }
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
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
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

async function installExtensionFromArchive(options: {
  db: Database;
  extensionsDir: string;
  archivePath: string;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
  sourceRegistry?: string;
  rootFingerprint?: string;
  approve?: ExtensionInstallApprover;
}): Promise<InstallExtensionFromLocalResult> {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-tgz-"));
  try {
    const { sourceRoot: root } = await extractPackage(options.archivePath, tmp);
    return await installExtensionFromLocalDirectory({
      db: options.db,
      extensionsDir: options.extensionsDir,
      sourcePath: root,
      ...(options.vault !== undefined && { vault: options.vault }),
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
      ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
      ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
      ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
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
  /**
   * Set only for a registry install: the registry's name and its pinned root-key fingerprint.
   * Named `rootFingerprint`, never `*Key`, for the same redaction reason as `publisher.fingerprint`.
   */
  readonly sourceRegistry?: string;
  readonly rootFingerprint?: string;
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

type SolverFetcher = {
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(
    id: string,
    version: string,
  ): Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }>;
};

/**
 * The solver's view of what exists: ONLY what is already installed. Nothing is fetched, so a
 * dependency that is not installed is unsatisfiable and the install refuses (spec § 8.6 step 8;
 * transitive fetching is a later project).
 */
function buildLocalSolverFetcher(
  db: Database,
  installedMap: ReadonlyMap<string, string>,
): SolverFetcher {
  return {
    listVersions(id: string): Promise<readonly string[]> {
      const pinned = installedMap.get(id);
      return Promise.resolve(pinned === undefined ? [] : [pinned]);
    },
    fetchManifest(
      id: string,
      version: string,
    ): Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }> {
      return Promise.try(() => {
        const extRow =
          installedMap.get(id) === version
            ? listExtensions(db).find((r) => r.id === id)
            : undefined;
        const mfPath =
          extRow === undefined ? undefined : resolveExtensionManifestPath(extRow.install_path);
        if (mfPath === undefined) {
          throw new Error(`dependency ${id}@${version} is not installed`);
        }
        const mf = parseExtensionManifestJson(readFileSync(mfPath, "utf8"));
        return {
          id: mf.id,
          version: mf.version,
          ...(mf.dependsOn === undefined ? {} : { dependsOn: mf.dependsOn }),
        };
      });
    },
  };
}

async function installRootNode(
  options: {
    db: Database;
    extensionsDir: string;
    vault?: NimbusVault;
    publisherKeyPath?: string;
    publisherKey?: Uint8Array;
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
    ...(options.publisherKeyPath !== undefined && {
      publisherKeyPath: options.publisherKeyPath,
    }),
    ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
  });
}

type InstallPlanNodesOptions = {
  db: Database;
  extensionsDir: string;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
};

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
      if (node.id !== manifest.id) {
        // Unreachable through the local-only solver, which never plans an uninstalled package.
        throw new Error(`dependency ${node.id}@${node.version} is not installed; install it first`);
      }
      await installRootNode(options, sourceResolved, manifest, (dir) => createdDirs.push(dir)); // NOSONAR S9382: topological, fail-fast install order (see above)
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
  source?: { sourceRegistry?: string; rootFingerprint?: string },
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
    ...(source?.sourceRegistry !== undefined && { sourceRegistry: source.sourceRegistry }),
    ...(source?.rootFingerprint !== undefined && { rootFingerprint: source.rootFingerprint }),
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
  publisherKeyPath?: string;
  /** The publisher's Ed25519 key, supplied by a caller that already established it (a registry install). */
  publisherKey?: Uint8Array;
  /** Shown to the owner in the install prompt; set only by a registry install. */
  sourceRegistry?: string;
  rootFingerprint?: string;
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
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
      ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
      ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
      ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
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

  const solverFetcher = buildLocalSolverFetcher(options.db, installedMap);

  const plan = await resolveClosure(manifest, solverFetcher, {
    installed: installedMap,
    activeConstraints,
  });

  if (options.approve !== undefined) {
    const approved = await options.approve(
      buildInstallApprovalRequest(manifest, plan, options.displaySourcePath ?? sourceResolved, {
        ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
        ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
      }),
    );
    if (!approved) {
      throw new ExtensionInstallNotApprovedError(manifest.id);
    }
  }

  await installPlanNodes(options, plan, sourceResolved, manifest);

  recordPlanInstallAndAudit(
    options.db,
    plan,
    manifest,
    options.approve === undefined ? "not_required" : "approved",
  );

  return buildRootInstallResult(options.extensionsDir, manifest, plan);
}
