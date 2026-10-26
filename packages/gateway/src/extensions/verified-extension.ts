import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { isSameOrInside, pathApiFor } from "../util/path-overlap.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { readVerifiedManifest, resolvedCredentialsFor } from "./approve-run.ts";
import { CONTINUITY_TABLE, type ContinuityEntry } from "./continuity/continuity-table.ts";
import { type ResolvedRunCredentials, serializeRunCredentials } from "./extension-credentials.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import { EXTENSION_SERVICE_ID_PATTERN } from "./extension-service-id.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { readPublisherKeyFor } from "./publisher-keys.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { type ExtensionRunGrantRow, getRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import {
  blockSubjectForInstalled,
  blocksFor,
  blocksForInstalled,
  describeBlock,
  type TrustBlock,
  unacknowledged,
} from "./trust/trust-blocks.ts";
import { verifyOneExtensionStrict } from "./verify-extensions.ts";
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
  /**
   * The live tree digest step 5 computed on THIS call (equal to the row digest and the approved
   * digest). The runtime re-digests its per-spawn copy against it.
   */
  readonly treeDigest: string;
  /**
   * Freshly re-resolved from the manifest verified on THIS call (and the continuity binding its
   * source resolves to now), equal to the stored grant's `credentials_json`. Names and Vault keys
   * only; the runtime reads the values and hands them to the child through `extensionProcessEnv`.
   */
  readonly credentials: ResolvedRunCredentials;
}

export interface VerifiedExtensionDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly env: ExtensionRunGrantEnv;
  /** Injected only so a test can count calls; defaults to {@link computeExtensionTreeDigest}. */
  readonly treeDigest?: (root: string) => string;
  /**
   * The continuity table a legacy connector id binds through; defaults to {@link CONTINUITY_TABLE}.
   * Must be the same table the approval resolved against, or step 9 refuses.
   */
  readonly continuityTable?: readonly ContinuityEntry[];
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
  // The spawn derives its mesh key, sandbox manifest id and profile from this value; a stored id
  // outside the pattern was never written by the approval path, so refuse rather than use it.
  if (!EXTENSION_SERVICE_ID_PATTERN.test(grant.service_id)) {
    refuse(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id}'s run grant carries a malformed service id; approve it again`,
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest is not valid JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id}'s manifest is not an object`);
  }
  return parsed as SignedManifestShape;
}

/** I48: the refusal for blocks the grant's acknowledgement does not name, if any. */
function refuseUnacknowledged(
  row: ExtensionRow,
  code: "ERR_EXTENSION_KEY_REVOKED" | "ERR_EXTENSION_TAKEN_DOWN",
  blocks: readonly TrustBlock[],
  grant: ExtensionRunGrantRow,
): void {
  const open = unacknowledged(blocks, grant.trust_ack_json);
  if (open.length === 0) return;
  refuse(
    code,
    `${row.id}: ${open.map(describeBlock).join("; ")}. It runs again only if you approve it with \`nimbus extension approve ${row.id}\``,
  );
}

/**
 * Step 4a (I48): a block on this extension that the run grant did not acknowledge refuses the spawn
 * BEFORE the tree is hashed — a revocation of the key recorded at install (or, before the backfill,
 * the declared key) first, since it covers every version; then a takedown.
 */
function assertNotBlocked(
  db: Database,
  row: ExtensionRow,
  manifest: ExtensionManifest,
  grant: ExtensionRunGrantRow,
): void {
  const blocks = blocksForInstalled(db, row, manifest);
  refuseUnacknowledged(
    row,
    "ERR_EXTENSION_KEY_REVOKED",
    blocks.filter((b) => b.kind === "key.revoke"),
    grant,
  );
  refuseUnacknowledged(
    row,
    "ERR_EXTENSION_TAKEN_DOWN",
    blocks.filter((b) => b.kind === "extension.takedown"),
    grant,
  );
}

/**
 * Step 6a (I48): a revocation of the key the Vault holds NOW — the one the signature is about to be
 * checked against, which step 4a could not see — that the grant did not acknowledge refuses the
 * spawn before the signature is checked, so the refusal names the revocation.
 */
function assertKeyNotRevoked(
  db: Database,
  row: ExtensionRow,
  manifest: ExtensionManifest,
  grant: ExtensionRunGrantRow,
  vaultKey: Uint8Array,
): void {
  const base = blockSubjectForInstalled(row, manifest);
  const keyFingerprint = publisherKeyFingerprint(Buffer.from(vaultKey).toString("base64"));
  const blocks = blocksFor(db, { ...base, keyFingerprint }).filter((b) => b.kind === "key.revoke");
  refuseUnacknowledged(row, "ERR_EXTENSION_KEY_REVOKED", blocks, grant);
}

/**
 * Step 6 (I16 at spawn): a manifest that names a publisher must verify against the key cached in
 * the Vault NOW. Fail-closed on every arm — a key evicted after approval, a missing signature, a
 * mismatch — and never fall back to "unsigned": only a manifest with no `publisher` at all is
 * unsigned, which is what the owner approved for it.
 */
async function assertPublisherSignature(
  db: Database,
  row: ExtensionRow,
  manifest: ExtensionManifest,
  grant: ExtensionRunGrantRow,
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
  let key: Uint8Array | undefined;
  try {
    // The key the row recorded at install (several may be trusted after a rotation).
    key = await readPublisherKeyFor(
      vault,
      manifest.publisher.id,
      row.publisher_key_fingerprint ?? null,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s publisher key for "${manifest.publisher.id}" could not be read from the Vault: ${msg}`,
    );
  }
  if (key === undefined) {
    refuse(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s publisher key for "${manifest.publisher.id}" is not in the Vault; reinstall it`,
    );
  }
  // 6a
  assertKeyNotRevoked(db, row, manifest, grant, key);
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
  const entryRel = extensionEntryRelPath(manifest);
  // An absolute entry (POSIX `/x.js`, a drive letter, a UNC path) names a file by itself; refuse it
  // before any join, exactly as install does, rather than rely on `join` happening to re-root it.
  if (pathApiFor(env.platform).isAbsolute(entryRel)) {
    refuse("ERR_EXTENSION_ENTRY_OUTSIDE", `${row.id}'s entry "${entryRel}" is an absolute path`);
  }
  let entryPath: string;
  try {
    entryPath = env.realpath(join(installPath, entryRel));
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
  // 4a
  assertNotBlocked(deps.db, row, manifest, grant);
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
  await assertPublisherSignature(deps.db, row, manifest, grant, deps.vault);
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
  // 9 — the credentials, re-resolved from the manifest verified above and the binding the row's
  // source resolves to NOW, must equal what was approved: a credential added (or re-mapped to a
  // different Vault key) after approval was never shown to the owner.
  const { credentials } = resolvedCredentialsFor(
    row,
    manifest,
    grant.service_id,
    deps.continuityTable ?? CONTINUITY_TABLE,
  );
  if (serializeRunCredentials(credentials) !== grant.credentials_json) {
    refuse(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id}'s credentials no longer resolve to what was approved; approve it again`,
    );
  }
  return {
    extensionId: row.id,
    serviceId: grant.service_id,
    version: row.version,
    installPath,
    entryPath,
    grants,
    treeDigest: rowDigest,
    credentials,
  };
}
