/**
 * The signed registry index (`index.json`): model, strict parser, and signature verification.
 *
 * Deliberately NOT routed through `verifyManifestSignature`: the SDK manifest verifier requires a
 * `publisher.key` field this envelope does not have. The signed bytes are the canonical JSON of the
 * index without its top-level `signature`, verified against `index.rootKey` with tweetnacl.
 */
// NOSONAR S1874: deprecated in SDK 1.32.0. The registry signs and verifies the bytes of this export
// (the gateway's `extensions/canonical-json.ts` wraps the same one); `@nimbus-dev/sdk/signing`
// NFC-normalises differently and would change the signed bytes for any non-ASCII string.
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874
import nacl from "tweetnacl";

import { RegistryError } from "./errors.ts";
import { assertSafeExtensionId } from "./extension-id.ts";
import { PUBLISHER_ID_RE } from "./manifest.ts";

function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export type RegistryChannel = "stable" | "beta";

export interface RegistryVersionEntry {
  channel: RegistryChannel;
  name: string;
  manifest: string;
  manifestSha256: string;
  package: string;
  packageSha256: string;
  packageSizeBytes: number;
  entryHash: string;
  publishedAt: string;
}

export interface RegistryExtensionEntry {
  publisher: { id: string; key: string };
  versions: Readonly<Record<string, RegistryVersionEntry>>;
}

export interface RegistryIndex {
  format: 1;
  rootKey: string;
  sequence: number;
  generatedAt: string;
  extensions: Readonly<Record<string, RegistryExtensionEntry>>;
  signature: string;
}

export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_REGISTRY_INDEX_INVALID", detail);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Required keys must be present; unknown keys are TOLERATED so a validly signed index that adds a
 * field later still parses on older clients. They are carried through (see the `...o` spreads) so the
 * signature, which covers the whole document, still verifies. `format` is the breaking-change switch.
 */
function requireKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const k of keys) {
    if (!(k in o)) throw invalid(`${what} is missing key: ${k}`);
  }
}

function str(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw invalid(`${what}.${key} must be a non-empty string`);
  return v;
}

function matching(o: Record<string, unknown>, key: string, re: RegExp, what: string): string {
  const v = str(o, key, what);
  if (!re.test(v)) throw invalid(`${what}.${key} is malformed`);
  return v;
}

function isoTimestamp(o: Record<string, unknown>, key: string, what: string): string {
  const v = str(o, key, what);
  if (Number.isNaN(Date.parse(v))) throw invalid(`${what}.${key} is not a timestamp`);
  return v;
}

// Strict SemVer 2.0.0: the version is joined into a path, so no range syntax, `v` prefix or whitespace.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Strict SemVer 2.0.0, the one rule the index and update apply share. */
export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

function parseVersionEntry(raw: unknown, id: string, version: string): RegistryVersionEntry {
  const what = `extensions.${id}.versions.${version}`;
  const o = asObject(raw, what);
  requireKeys(
    o,
    [
      "channel",
      "name",
      "manifest",
      "manifestSha256",
      "package",
      "packageSha256",
      "packageSizeBytes",
      "entryHash",
      "publishedAt",
    ],
    what,
  );
  const channel = o["channel"];
  if (channel !== "stable" && channel !== "beta") throw invalid(`${what}.channel is not known`);
  const base = `extensions/${id}/${version}`;
  const manifest = str(o, "manifest", what);
  if (manifest !== `${base}/manifest.json`) throw invalid(`${what}.manifest is not canonical`);
  const pkg = str(o, "package", what);
  if (pkg !== `${base}/package.tgz`) throw invalid(`${what}.package is not canonical`);
  const size = o["packageSizeBytes"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    throw invalid(`${what}.packageSizeBytes must be a positive integer`);
  }
  return {
    ...o,
    channel,
    name: str(o, "name", what),
    manifest,
    manifestSha256: matching(o, "manifestSha256", HEX64_RE, what),
    package: pkg,
    packageSha256: matching(o, "packageSha256", HEX64_RE, what),
    packageSizeBytes: size,
    entryHash: matching(o, "entryHash", HEX64_RE, what),
    publishedAt: isoTimestamp(o, "publishedAt", what),
  };
}

function parseExtensionEntry(raw: unknown, id: string): RegistryExtensionEntry {
  try {
    assertSafeExtensionId(id);
  } catch (e) {
    throw invalid(`extension id ${JSON.stringify(id)} is not safe: ${(e as Error).message}`);
  }
  const what = `extensions.${id}`;
  const o = asObject(raw, what);
  requireKeys(o, ["publisher", "versions"], what);
  const p = asObject(o["publisher"], `${what}.publisher`);
  requireKeys(p, ["id", "key"], `${what}.publisher`);
  const pid = str(p, "id", `${what}.publisher`);
  if (pid.length > 64 || !PUBLISHER_ID_RE.test(pid)) {
    throw invalid(`${what}.publisher.id is malformed`);
  }
  const key = matching(p, "key", KEY_RE, `${what}.publisher`);
  const versionsRaw = asObject(o["versions"], `${what}.versions`);
  const versions: Record<string, RegistryVersionEntry> = {};
  for (const [version, entry] of Object.entries(versionsRaw)) {
    if (!isValidSemver(version)) throw invalid(`${what} has a non-semver version: ${version}`);
    versions[version] = parseVersionEntry(entry, id, version);
  }
  if (Object.keys(versions).length === 0) throw invalid(`${what} has no versions`);
  return { ...o, publisher: { ...p, id: pid, key }, versions };
}

export function parseRegistryIndex(bytes: Uint8Array): RegistryIndex {
  if (bytes.byteLength > MAX_INDEX_BYTES) {
    throw new RegistryError(
      "ERR_REGISTRY_TOO_LARGE",
      `index.json exceeds ${String(MAX_INDEX_BYTES)} bytes`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid("index.json is not valid UTF-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("index.json is not valid JSON");
  }
  const o = asObject(raw, "index");
  requireKeys(
    o,
    ["format", "rootKey", "sequence", "generatedAt", "extensions", "signature"],
    "index",
  );
  if (o["format"] !== 1) throw invalid("unsupported index format");
  const sequence = o["sequence"];
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw invalid("index.sequence must be a positive integer");
  }
  const extensionsRaw = asObject(o["extensions"], "index.extensions");
  const extensions: Record<string, RegistryExtensionEntry> = {};
  for (const [id, entry] of Object.entries(extensionsRaw)) {
    extensions[id] = parseExtensionEntry(entry, id);
  }
  return {
    ...o,
    format: 1,
    rootKey: matching(o, "rootKey", KEY_RE, "index"),
    sequence,
    generatedAt: isoTimestamp(o, "generatedAt", "index"),
    extensions,
    signature: matching(o, "signature", SIGNATURE_RE, "index"),
  };
}

export function registryIndexSigningBytes(
  index: Omit<RegistryIndex, "signature"> | RegistryIndex,
): Uint8Array {
  const { signature: _omitted, ...rest } = index as RegistryIndex;
  return new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
}

export async function verifyRegistryIndexSelf(index: RegistryIndex): Promise<void> {
  let ok: boolean;
  try {
    ok = nacl.sign.detached.verify(
      registryIndexSigningBytes(index),
      decodeBase64(index.signature),
      decodeBase64(index.rootKey),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new RegistryError("ERR_REGISTRY_SIGNATURE_INVALID", "index signature does not verify");
  }
}

export async function verifyRegistryIndexPinned(
  index: RegistryIndex,
  pinnedRootKey: string,
): Promise<void> {
  if (index.rootKey !== pinnedRootKey) {
    throw new RegistryError(
      "ERR_REGISTRY_ROOT_KEY_CHANGED",
      "index root key differs from the pinned key",
    );
  }
  await verifyRegistryIndexSelf(index);
}
