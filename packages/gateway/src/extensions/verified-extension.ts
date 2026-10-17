import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { isSameOrInside } from "../util/path-overlap.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { readVerifiedManifest } from "./approve-run.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { type ExtensionManifest, resolveExtensionManifestPath } from "./manifest.ts";
import { readPublisherKey } from "./publisher-keys.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { type ExtensionRunGrantRow, getRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { extensionEntryRelPath, verifyOneExtensionStrict } from "./verify-extensions.ts";
import { type SignedManifestShape, verifyManifestSignature } from "./verify-signature.ts";

/** Everything a spawn needs, each value re-derived from disk and the Vault on THIS call. */
export interface VerifiedExtensionForSpawn {
  readonly extensionId: string;
  readonly serviceId: string;
  readonly version: string;
  /** realpath */
  readonly installPath: string;
  /** absolute, realpath, inside `installPath` */
  readonly entryPath: string;
  /** freshly re-resolved, equal to the stored grant */
  readonly grants: ResolvedRunGrants;
}

export interface VerifiedExtensionDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly env: ExtensionRunGrantEnv;
  /** Injected only so a test can count calls; defaults to {@link computeExtensionTreeDigest}. */
  readonly treeDigest?: (root: string) => string;
}

function refuse(code: ConstructorParameters<typeof ExtensionRunGrantError>[0], msg: string): never {
  throw new ExtensionRunGrantError(code, msg);
}

/** Steps 1–2: the row exists and is enabled, then a grant exists. */
function requireRowAndGrant(
  db: Database,
  extensionId: string,
): { row: ExtensionRow; grant: ExtensionRunGrantRow } {
  const row = listExtensions(db).find((r) => r.id === extensionId);
  if (row === undefined) {
    refuse("ERR_EXTENSION_NOT_FOUND", `extension "${extensionId}" is not installed`);
  }
  if (row.enabled !== 1) refuse("ERR_EXTENSION_RUN_DISABLED", `${row.id} is disabled`);
  const grant = getRunGrant(db, row.id);
  if (grant === null) {
    refuse(
      "ERR_EXTENSION_RUN_NOT_APPROVED",
      `${row.id} has no run approval; run \`nimbus extension approve ${row.id}\``,
    );
  }
  return { row, grant };
}

/** Step 3: no startup signature failure is recorded, and the manifest + entry hashes still match. */
function assertHashesVerified(row: ExtensionRow): void {
  const reason = signatureDisabledRegistry.reasonFor(row.id);
  if (reason !== undefined) {
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id} failed publisher signature verification at startup (${reason})`,
    );
  }
  let verified: boolean;
  try {
    verified = verifyOneExtensionStrict(row);
  } catch {
    // The strict check parses the manifest unguarded; a manifest the parser rejects (e.g. a
    // publisher with no signature) is unverified, and must surface as a typed refusal.
    verified = false;
  }
  if (!verified) {
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s manifest or entry no longer matches what was installed; reinstall it`,
    );
  }
}

/** Step 4's read: `readVerifiedManifest`, with a parse failure surfaced as a typed refusal. */
function readManifestTyped(row: ExtensionRow): ExtensionManifest {
  try {
    return readVerifiedManifest(row);
  } catch (e) {
    if (e instanceof ExtensionRunGrantError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest does not parse: ${msg}`);
  }
}

/** Step 5: the live tree equals the row's digest AND the approved digest; versions all agree. */
function assertTreeAndVersion(
  row: ExtensionRow,
  rowDigest: string,
  grant: ExtensionRunGrantRow,
  manifest: ExtensionManifest,
  treeDigest: (root: string) => string,
): void {
  let live: string | null;
  try {
    live = treeDigest(row.install_path);
  } catch {
    // A symlink or unreadable entry in the tree: the digest cannot vouch for it.
    live = null;
  }
  if (live === null || live !== rowDigest || live !== grant.tree_digest) {
    refuse(
      "ERR_EXTENSION_RUN_TREE_CHANGED",
      `${row.id}'s files changed since they were approved; review them, run \`nimbus extension rehash ${row.id}\` and approve it again`,
    );
  }
  if (manifest.version !== row.version || manifest.version !== grant.version) {
    refuse(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id} is version ${manifest.version} but ${grant.version} was approved; approve it again`,
    );
  }
}

/**
 * Re-reads the manifest bytes for the signature check and hash-checks them against the row again,
 * so the object verified is byte-identical to the one `readVerifiedManifest` parsed in step 4. The
 * raw object (not the parsed `ExtensionManifest`) is what the signature covers, exactly as the
 * startup pass (`verify-extensions.ts`) verifies it.
 */
function readRawManifestForSignature(row: ExtensionRow): SignedManifestShape {
  const p = resolveExtensionManifestPath(row.install_path);
  let bytes: Buffer | undefined;
  try {
    bytes = p === undefined ? undefined : readFileSync(p);
  } catch {
    bytes = undefined;
  }
  if (bytes === undefined) {
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest could not be read`);
  }
  const hex = createHash("sha256").update(bytes).digest("hex");
  if (!sha256HexEqualConstantTime(hex, row.manifest_hash)) {
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest changed during verification`);
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest is not an object`);
  }
  return parsed as SignedManifestShape;
}

/**
 * Step 6 (I16 at spawn): a manifest that names a publisher must verify against the key cached in
 * the Vault NOW. Fail-closed on every arm — a key evicted after approval, a missing signature, a
 * mismatch — and never fall back to "unsigned": only a manifest with no `publisher` at all is
 * unsigned, which is what the owner approved for it.
 */
async function assertPublisherSignature(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  vault: NimbusVault,
): Promise<void> {
  if (manifest.publisher === undefined) return;
  const raw = readRawManifestForSignature(row);
  if (typeof raw.signature !== "string" || raw.signature === "") {
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id} names publisher "${manifest.publisher.id}" but carries no signature`,
    );
  }
  const key = await readPublisherKey(vault, manifest.publisher.id);
  if (key === undefined) {
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s publisher key for "${manifest.publisher.id}" is not in the Vault; reinstall it`,
    );
  }
  try {
    await verifyManifestSignature(raw, key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id} failed publisher signature verification: ${msg}`,
    );
  }
}

/** Step 7: the entry, by realpath, lies strictly inside the install path's realpath. */
function resolveEntryInside(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  env: ExtensionRunGrantEnv,
): { installPath: string; entryPath: string } {
  let installPath: string;
  try {
    installPath = env.realpath(row.install_path);
  } catch {
    refuse("ERR_EXTENSION_RUN_TREE_CHANGED", `${row.id}'s install path no longer exists`);
  }
  let entryPath: string;
  try {
    entryPath = env.realpath(join(installPath, extensionEntryRelPath(manifest)));
  } catch {
    refuse("ERR_EXTENSION_ENTRY_OUTSIDE", `${row.id}'s entry does not resolve to a file`);
  }
  const inside =
    isSameOrInside(env.platform, entryPath, installPath) &&
    !isSameOrInside(env.platform, installPath, entryPath);
  if (!inside) {
    refuse(
      "ERR_EXTENSION_ENTRY_OUTSIDE",
      `${row.id}'s entry "${entryPath}" lies outside its install path "${installPath}"`,
    );
  }
  return { installPath, entryPath };
}

/**
 * The pre-spawn re-verification of an installed extension (extension runtime, invariant I43). Runs
 * immediately before EVERY spawn and trusts no earlier pass — no cache, no `last_verified_at`, no
 * approval-time digest taken on faith: each call re-reads the row, the grant, the manifest, the
 * whole tree, the Vault key and the declared paths. The ORDER below is the invariant; each step
 * refuses with an `ExtensionRunGrantError`, and nothing is spawned unless every step passes.
 */
export async function readVerifiedExtensionForSpawn(
  extensionId: string,
  deps: VerifiedExtensionDeps,
): Promise<VerifiedExtensionForSpawn> {
  // 1–2
  const { row, grant } = requireRowAndGrant(deps.db, extensionId);
  // 3
  assertHashesVerified(row);
  // 4
  const manifest = readManifestTyped(row);
  const rowDigest = row.tree_digest;
  if (rowDigest === null) {
    refuse(
      "ERR_EXTENSION_RUN_NO_DIGEST",
      `${row.id} has no recorded tree digest; run \`nimbus extension rehash ${row.id}\` first`,
    );
  }
  // 5
  assertTreeAndVersion(
    row,
    rowDigest,
    grant,
    manifest,
    deps.treeDigest ?? computeExtensionTreeDigest,
  );
  // 6
  await assertPublisherSignature(row, manifest, deps.vault);
  // 7
  const { installPath, entryPath } = resolveEntryInside(row, manifest, deps.env);
  // 8 — throws its own GRANT_* refusal when a declared path no longer resolves.
  const grants = resolveExtensionRunGrants(manifest.permissions, installPath, deps.env);
  if (serializeRunGrants(grants) !== grant.permissions_json) {
    refuse(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id}'s permissions no longer resolve to what was approved; approve it again`,
    );
  }
  return {
    extensionId: row.id,
    serviceId: grant.service_id,
    version: row.version,
    installPath,
    entryPath,
    grants,
  };
}
