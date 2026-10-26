/**
 * THE publish validator: the one function the CLI `publish`, `registry maintain add` and the
 * registry action's `check` and `sign` modes call to decide whether a candidate
 * `extensions/<id>/<version>/` may enter a registry. It is the content boundary of the registry, so
 * every rule lives here and nowhere else (design § 11 rules 1, 2, 4, 5).
 *
 * The checks run in a fixed order: cheap structural checks (publish request, manifest size and
 * parse) first, then the publisher signature, then the rules over the signed registry state, and
 * the package — the only expensive step — last. The first failure throws a `RegistryError`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// NOSONAR S1874: deprecated in SDK 1.32.0 with NO shipped replacement for the flat
// `publisher.key` + `signature` shape. This is the same verify the gateway runs at install and at
// every startup (I16), so a manifest accepted here is one every client accepts.
import { verifyManifestSignature } from "@nimbus-dev/sdk"; // NOSONAR S1874
import semver from "semver";

import { MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES } from "./caps.ts";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { RegistryError } from "./errors.ts";
import {
  assertCanonicalExtensionId,
  assertPublishableExtensionId,
  assertSafeExtensionId,
  deriveExtensionServiceId,
  findServiceIdPrefixCollision,
} from "./extension-id.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import { isValidSemver, type RegistryChannel, type RegistryIndex } from "./index-format.ts";
import { inspectPackage } from "./inspect.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
} from "./manifest.ts";
import { isPackageFile, PACKAGE_MANIFEST_FILE } from "./package-set.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";
import { publisherKeyStanding } from "./publisher-statements.ts";

/** `nimbus-registry.json`: the registry's own rules. */
export interface RegistryConfig {
  format: 1;
  requirePublisherNamespace: boolean;
}

/** What a publish adds under `extensions/<dirId>/<dirVersion>/`, as raw bytes. */
export interface PublishCandidate {
  dirId: string;
  dirVersion: string;
  /** The committed `manifest.json`. */
  manifestBytes: Uint8Array;
  /** The committed `package.tgz`. */
  packageBytes: Uint8Array;
  /** The committed `publish-request.json`. */
  publishRequestBytes: Uint8Array;
}

/** Everything an index entry and a reviewer summary need about an accepted candidate. */
export interface PublishVerdict {
  id: string;
  version: string;
  channel: RegistryChannel;
  name: string;
  publisher: { id: string; key: string };
  entryHash: string;
  manifestSha256: string;
  packageSha256: string;
  packageSizeBytes: number;
  /** True when the id is not in the signed index yet — a reviewer must look harder. */
  newId: boolean;
  /** The manifest's declared sandbox permissions, as the gateway parses them. */
  permissions: SandboxPermissions;
}

interface PublishRequest {
  id: string;
  version: string;
  channel: RegistryChannel;
  publisherFingerprint: string;
}

const MAX_SMALL_JSON_BYTES = 4096;
const PUBLISH_REQUEST_KEYS = ["id", "version", "channel", "publisherFingerprint"] as const;
const CONFIG_KEYS = ["format", "requirePublisherNamespace"] as const;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;
const DIST_PREFIX = "dist/";

function decodeJsonObject(
  bytes: Uint8Array,
  what: string,
  fail: (detail: string) => RegistryError,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw fail(`${what} is not valid UTF-8 JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail(`${what} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

/** Exactly `keys`: an unknown key is refused, a missing one too. */
function requireExactKeys(
  o: Record<string, unknown>,
  keys: readonly string[],
  what: string,
  fail: (detail: string) => RegistryError,
): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw fail(`${what} has an unknown key: ${k}`);
  }
  for (const k of keys) {
    if (!Object.hasOwn(o, k)) throw fail(`${what} is missing key: ${k}`);
  }
}

const configInvalid = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_CONFIG_INVALID", detail);

/** Parse `nimbus-registry.json` strictly: unknown keys are refused, so a rule cannot be misspelled. */
export function parseRegistryConfig(bytes: Uint8Array): RegistryConfig {
  const what = "nimbus-registry.json";
  if (bytes.byteLength > MAX_SMALL_JSON_BYTES) throw configInvalid(`${what} is too large`);
  const o = decodeJsonObject(bytes, what, configInvalid);
  requireExactKeys(o, CONFIG_KEYS, what, configInvalid);
  if (o["format"] !== 1) throw configInvalid(`${what} has an unsupported format`);
  const ns = o["requirePublisherNamespace"];
  if (typeof ns !== "boolean") {
    throw configInvalid(`${what}.requirePublisherNamespace must be a boolean`);
  }
  return { format: 1, requirePublisherNamespace: ns };
}

/**
 * The rules a merged publish meets: the stricter of `gh-pages`'s config (the last signed run's) and
 * the default branch's (`undefined` when that ref has no `nimbus-registry.json`). The sign job
 * refuses a default branch that loosens `gh-pages`'s, so the stricter one is what sign applies.
 * Shared by the action's `check` and the CLI's `publish`, so the two cannot disagree.
 */
export function effectiveRegistryConfig(
  pages: RegistryConfig | undefined,
  defaultBranch: RegistryConfig | undefined,
): RegistryConfig {
  return {
    format: 1,
    requirePublisherNamespace:
      (pages?.requirePublisherNamespace ?? false) ||
      (defaultBranch?.requirePublisherNamespace ?? false),
  };
}

const requestInvalid = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_PUBLISH_REQUEST_INVALID", detail);

// Rule 1.
function parsePublishRequest(bytes: Uint8Array): PublishRequest {
  const what = "publish-request.json";
  if (bytes.byteLength > MAX_SMALL_JSON_BYTES) throw requestInvalid(`${what} is too large`);
  const o = decodeJsonObject(bytes, what, requestInvalid);
  requireExactKeys(o, PUBLISH_REQUEST_KEYS, what, requestInvalid);
  const { id, version, channel, publisherFingerprint } = o;
  if (typeof id !== "string" || typeof version !== "string") {
    throw requestInvalid(`${what}.id and .version must be strings`);
  }
  if (channel !== "stable" && channel !== "beta") {
    throw requestInvalid(`${what}.channel must be "stable" or "beta"`);
  }
  if (typeof publisherFingerprint !== "string" || !FINGERPRINT_RE.test(publisherFingerprint)) {
    throw requestInvalid(`${what}.publisherFingerprint must be 32 lowercase hex characters`);
  }
  return { id, version, channel, publisherFingerprint };
}

const manifestInvalid = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", detail);

// Rule 2. Returns the parsed manifest and the raw object the signature covers.
function parseCandidateManifest(bytes: Uint8Array): {
  manifest: ExtensionManifest;
  raw: Record<string, unknown>;
} {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new RegistryError(
      "ERR_REGISTRY_TOO_LARGE",
      `manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes`,
    );
  }
  const raw = decodeJsonObject(bytes, "manifest", manifestInvalid);
  let manifest: ExtensionManifest;
  try {
    manifest = parseExtensionManifestForRegistry(new TextDecoder().decode(bytes)).manifest;
    assertSafeExtensionId(manifest.id);
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    throw manifestInvalid((e as Error).message);
  }
  // The parser trims; a published id and version are the exact strings it would keep.
  assertCanonicalExtensionId(typeof raw["id"] === "string" ? raw["id"] : "");
  // A registry serves the id as a git branch, a client directory and a Pages URL path.
  assertPublishableExtensionId(manifest.id);
  if (raw["version"] !== manifest.version) {
    throw manifestInvalid(`version ${JSON.stringify(raw["version"])} has surrounding whitespace`);
  }
  if (!isValidSemver(manifest.version)) {
    throw manifestInvalid(`version ${JSON.stringify(manifest.version)} is not strict semver`);
  }
  // Build metadata has no SemVer precedence: `1.0.0+r2` would be a second `1.0.0`.
  if (manifest.version.includes("+")) {
    throw manifestInvalid(
      `version ${manifest.version} carries build metadata, which a published version may not`,
    );
  }
  return { manifest, raw };
}

// Rule 3.
function assertCoordinates(c: PublishCandidate, m: ExtensionManifest, req: PublishRequest): void {
  for (const [field, dir, fromReq] of [
    ["id", c.dirId, req.id],
    ["version", c.dirVersion, req.version],
  ] as const) {
    const fromManifest = m[field];
    if (dir !== fromManifest || fromReq !== fromManifest) {
      throw requestInvalid(
        `manifest ${field} ${JSON.stringify(fromManifest)} must equal the directory's ` +
          `(${JSON.stringify(dir)}) and publish-request.json's (${JSON.stringify(fromReq)})`,
      );
    }
  }
}

// Rule 4. The manifest's OWN key: what the signed index will then bind to this publisher id.
async function assertSigned(
  m: ExtensionManifest,
  raw: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  if (m.publisher === undefined || m.signature === undefined) {
    throw new RegistryError(
      "ERR_REGISTRY_SIGNATURE_INVALID",
      "a published manifest must carry publisher and signature",
    );
  }
  try {
    await verifyManifestSignature(raw, new Uint8Array(Buffer.from(m.publisher.key, "base64"))); // NOSONAR S1874
  } catch {
    throw new RegistryError(
      "ERR_REGISTRY_SIGNATURE_INVALID",
      `manifest signature does not verify with publisher ${m.publisher.id}'s key`,
    );
  }
  return m.publisher;
}

/** Service ids of every indexed id. One no client could ever approve has none and collides with nothing. */
function indexedServiceIds(signed: RegistryIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of Object.keys(signed.extensions)) {
    try {
      out.set(deriveExtensionServiceId(id), id);
    } catch {
      // Not derivable: never runnable, so it occupies no service id.
    }
  }
  return out;
}

/**
 * Rule 9: a publisher publishes with its ONE current key — the key every key the index binds to it
 * leads to through the index's `key.rotate` statements — and never with a revoked one
 * (`publisher-statements.ts`). A publisher with no bound key may use any key not revoked here.
 */
function assertCurrentPublisherKey(
  publisher: { id: string; key: string },
  signed: RegistryIndex,
): void {
  const standing = publisherKeyStanding(signed, publisher.id, publisher.key);
  if (standing.ok) return;
  const fp = publisherKeyFingerprint(publisher.key);
  const current = standing.current.map(publisherKeyFingerprint).join(", ");
  switch (standing.reason) {
    case "revoked":
      throw new RegistryError(
        "ERR_REGISTRY_PUBLISHER_KEY_REVOKED",
        `publisher ${publisher.id}'s key ${fp} is revoked in this registry (itself or a key it was rotated from)`,
      );
    case "superseded":
      throw keyConflict(
        `publisher ${publisher.id}'s key ${fp} is superseded by ${current}; sign with the current key`,
      );
    case "fork":
      throw keyConflict(
        `publisher ${publisher.id}'s key rotations fork or loop (current keys: ${current || "none"}); no key can publish until the registry maintainer resolves it`,
      );
    case "unrelated": {
      const bound = Object.entries(signed.extensions)
        .filter(([, e]) => e.publisher.id === publisher.id)
        .map(([id]) => id)
        .sort(codeUnitCompare)
        .join(", ");
      throw keyConflict(
        `publisher ${publisher.id} is bound to key ${current || "(revoked)"} by indexed extension ${bound}; this manifest is signed by ${fp}, which no key.rotate in the index reaches — include the key.rotate statement with --statement`,
      );
    }
  }
}

const keyConflict = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT", detail);

// Rules 8, 9, 10: everything decided by the signed registry state.
function assertRegistryState(
  m: ExtensionManifest,
  publisher: { id: string; key: string },
  serviceId: string,
  signed: RegistryIndex,
): boolean {
  const existing = Object.hasOwn(signed.extensions, m.id) ? signed.extensions[m.id] : undefined;
  if (existing === undefined) {
    const indexed = indexedServiceIds(signed);
    const hit = findServiceIdPrefixCollision(serviceId, [...indexed.keys()]);
    if (hit !== undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_SERVICE_ID_COLLISION",
        `service id ${serviceId} of new id ${m.id} collides with ${hit} of indexed id ${String(indexed.get(hit))}`,
      );
    }
  }
  if (existing !== undefined && existing.publisher.id !== publisher.id) {
    throw new RegistryError(
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
      `${m.id} is bound to publisher ${existing.publisher.id}`,
    );
  }
  assertCurrentPublisherKey(publisher, signed);
  if (existing !== undefined) {
    // Equal precedence, not just an equal string: an indexed `1.0.0+r1` already IS `1.0.0`.
    const taken = Object.keys(existing.versions).find(
      (v) => v === m.version || semver.compare(v, m.version) === 0,
    );
    if (taken !== undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_VERSION_EXISTS",
        `${m.id}@${m.version} is already in the index (as ${taken})`,
      );
    }
  }
  return existing === undefined;
}

const fileSetInvalid = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_PACKAGE_FILE_SET", detail);

function isCleanRelPath(rel: string): boolean {
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Rule 13.
// `inspectPackage` resolves the entry by the same rule, so `entryHash` is the hash of this file.
function assertFileSet(m: ExtensionManifest, files: string[]): void {
  const entry = extensionEntryRelPath(m);
  if (!entry.startsWith(DIST_PREFIX) || !isCleanRelPath(entry)) {
    throw fileSetInvalid(`extension entry ${entry} must be a file inside dist/`);
  }
  const seen = new Set<string>();
  const folded = new Map<string, string>();
  for (const f of files) {
    if (seen.has(f)) throw fileSetInvalid(`package holds ${f} more than once`);
    seen.add(f);
    // On a case-insensitive client filesystem (Windows, macOS) these overwrite each other.
    const twin = folded.get(f.toLowerCase());
    if (twin !== undefined) {
      throw fileSetInvalid(`package holds ${twin} and ${f}, which differ only by case`);
    }
    folded.set(f.toLowerCase(), f);
    if (!isCleanRelPath(f) || !isPackageFile(f)) {
      throw fileSetInvalid(`package holds ${f}, which is outside the package file set`);
    }
  }
  if (!seen.has(PACKAGE_MANIFEST_FILE) || !seen.has(entry)) {
    throw fileSetInvalid(`package must hold ${PACKAGE_MANIFEST_FILE} and the entry ${entry}`);
  }
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * Decide whether `c` may enter the registry whose signed state is `signed` (the caller verified it)
 * and whose rules are `config`. Scratch files go into a fresh directory inside `work`, removed on
 * return; nothing outside `work` is written. Throws the first `RegistryError` in rule order.
 */
export async function validatePublish(
  c: PublishCandidate,
  signed: RegistryIndex,
  config: RegistryConfig,
  work: string,
): Promise<PublishVerdict> {
  const req = parsePublishRequest(c.publishRequestBytes); // 1
  const { manifest: m, raw } = parseCandidateManifest(c.manifestBytes); // 2
  assertCoordinates(c, m, req); // 3
  const publisher = await assertSigned(m, raw); // 4
  if (req.publisherFingerprint !== publisherKeyFingerprint(publisher.key)) {
    throw requestInvalid(
      `publish-request.json.publisherFingerprint does not match publisher ${publisher.id}'s key`,
    ); // 5
  }
  if (config.requirePublisherNamespace) {
    const ns = `${publisher.id}/`;
    if (!m.id.startsWith(ns) || m.id.length === ns.length) {
      throw new RegistryError(
        "ERR_REGISTRY_NAMESPACE_REQUIRED",
        `this registry requires ids of the form ${ns}<name>; got ${m.id}`,
      ); // 6
    }
  }
  const serviceId = deriveExtensionServiceId(m.id); // 7
  const newId = assertRegistryState(m, publisher, serviceId, signed); // 8, 9, 10

  if (c.packageBytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new RegistryError(
      "ERR_REGISTRY_TOO_LARGE",
      `package exceeds ${String(MAX_PACKAGE_BYTES)} bytes`,
    ); // 11
  }
  const scratch = mkdtempSync(join(work, "validate-"));
  try {
    const tgz = join(scratch, "package.tgz");
    writeFileSync(tgz, c.packageBytes);
    let inspected: Awaited<ReturnType<typeof inspectPackage>>;
    try {
      inspected = await inspectPackage(tgz, scratch); // 11
    } catch (e) {
      if (e instanceof RegistryError) throw e;
      throw new RegistryError(
        "ERR_REGISTRY_EXTRACT_FAILED",
        `package could not be read: ${(e as Error).message}`,
      );
    }
    if (!Buffer.from(c.manifestBytes).equals(inspected.manifestBytes)) {
      throw new RegistryError(
        "ERR_REGISTRY_MANIFEST_MISMATCH",
        `the package's ${PACKAGE_MANIFEST_FILE} differs from the committed manifest.json`,
      ); // 12
    }
    assertFileSet(m, inspected.files); // 13
    return {
      id: m.id,
      version: m.version,
      channel: req.channel,
      name: m.name ?? m.id,
      publisher: { id: publisher.id, key: publisher.key },
      entryHash: inspected.entryHash,
      manifestSha256: sha256Hex(c.manifestBytes),
      packageSha256: sha256Hex(c.packageBytes),
      packageSizeBytes: c.packageBytes.byteLength,
      newId,
      permissions: m.permissions,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
