/**
 * The extension manifest model and its strict parser — the pure rules every installer, verifier
 * and the registry share. Reading a manifest FILE is the caller's job (the gateway's
 * `extensions/manifest.ts` resolves which file a directory holds).
 */
import semver from "semver";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { isExtensionBaselineEnvKey } from "./extension-env.ts";
import { PACKAGE_MANIFEST_FILE } from "./package-set.ts";
import {
  type SandboxPermissions,
  validateAndNormalizePermissions,
} from "./permissions-validator.ts";

/** The entry an extension runs when its manifest names none. */
export const DEFAULT_EXTENSION_ENTRY = "dist/index.js";

/**
 * What a package is. A starter pack carries no code: it exists only to install its `dependsOn`
 * and name the connectors it `requires`.
 */
export type ExtensionKind = "extension" | "starter-pack";

export function isStarterPack(m: { readonly kind?: ExtensionKind }): boolean {
  return m.kind === "starter-pack";
}

/**
 * The manifest's entry, relative to the install path, with an absent or empty `entry` falling back
 * to {@link DEFAULT_EXTENSION_ENTRY}. A starter pack's entry is its own manifest file: it has no
 * code, so every layer that hashes "the entry" hashes the one file the pack is. The ONE spelling of
 * that rule — install, package hashing, startup and strict verification and the pre-spawn accessor
 * all read it — so the file hashed is the file spawned. Lives here, in the manifest leaf module, so
 * every consumer can import it without a cycle.
 */
export function extensionEntryRelPath(manifest: {
  readonly entry?: string;
  readonly kind?: ExtensionKind;
}): string {
  if (isStarterPack(manifest)) return PACKAGE_MANIFEST_FILE;
  return manifest.entry !== undefined && manifest.entry !== ""
    ? manifest.entry
    : DEFAULT_EXTENSION_ENTRY;
}

export type ExtensionSyncManifest = {
  readonly contract: "1";
  readonly intervalSeconds: number;
  readonly itemTypes: readonly string[];
};

export type ExtensionCredentialDecls = Readonly<Record<string, { readonly env: string }>>;

/** The reserved registry name a cross-registry dependency may use for the baked official registry. */
export const OFFICIAL_REGISTRY_NAME = "nimbus-official";

/** One `dependsOn` entry. The string form `"^1.2.0"` parses to `{ range }`. */
export type DependencySpec = {
  readonly range: string;
  /** Absent ⇒ same registry as the dependent. An https URL, or {@link OFFICIAL_REGISTRY_NAME}. */
  readonly registry?: string;
  /** 32 lowercase hex — the pinned root-key fingerprint the named registry must have. */
  readonly rootKeyFingerprint?: string;
};

/** True when the dependency names a registry of its own rather than the dependent's. */
export function isCrossRegistryDependency(spec: DependencySpec): boolean {
  return spec.registry !== undefined;
}

export type ExtensionManifest = {
  id: string;
  version: string;
  name?: string;
  entry?: string;
  permissions: SandboxPermissions;
  publisher?: { id: string; key: string };
  signature?: string;
  updateChannel: "stable" | "beta";
  changelog?: string;
  dependsOn?: Readonly<Record<string, DependencySpec>>;
  sync?: ExtensionSyncManifest;
  credentials?: ExtensionCredentialDecls;
  /**
   * The parser always sets it (`"extension"` when the manifest names none). Optional in the type
   * because the gateway builds manifests in code (first-party connectors, user MCP servers,
   * generated tools) that are all extensions: absent means `"extension"`, see {@link isStarterPack}.
   */
  kind?: ExtensionKind;
  /** Connectors that must be configured for this package to be useful — sorted, de-duplicated. */
  requires?: { readonly connectors: readonly string[] };
};

/** A connector id as `requires.connectors` may name it. Well-formed but unknown ids still parse. */
export const CONNECTOR_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const PUBLISHER_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

function parsePublisher(value: unknown): { id: string; key: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension manifest publisher must be an object");
  }
  const o = value as Record<string, unknown>;
  const allowed = new Set(["id", "key"]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      throw new Error(`extension manifest publisher has unknown key: ${k}`);
    }
  }
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  if (id === "" || id.length > 64 || !PUBLISHER_ID_RE.test(id)) {
    throw new Error(
      "extension manifest publisher.id is required and must match [a-z0-9][a-z0-9._-]* (max 64 chars)",
    );
  }
  const key = typeof o["key"] === "string" ? o["key"].trim() : "";
  if (!PUBLISHER_KEY_RE.test(key)) {
    throw new Error(
      "extension manifest publisher.key must be 44-char base64 of a 32-byte Ed25519 public key",
    );
  }
  return { id, key };
}

function parseSignature(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("extension manifest signature must be a string");
  if (!SIGNATURE_RE.test(value)) {
    throw new Error(
      "extension manifest signature must be 88-char base64 of a 64-byte Ed25519 signature",
    );
  }
  return value;
}

const CHANGELOG_MAX_BYTES = 4096;

function parseUpdateChannel(value: unknown): "stable" | "beta" {
  if (value === undefined) return "stable";
  if (value !== "stable" && value !== "beta") {
    throw new Error(
      `extension manifest updateChannel must be "stable" or "beta" (got: ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseChangelog(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("extension manifest changelog must be a string");
  }
  const normalized = value.normalize("NFC");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > CHANGELOG_MAX_BYTES) {
    throw new Error(
      `extension manifest changelog must be ≤ 4 KiB after NFC normalization (got ${bytes} bytes)`,
    );
  }
  return normalized;
}

const ROOT_KEY_FINGERPRINT_RE = /^[0-9a-f]{32}$/;

function parseDependencyRange(depId: string, range: unknown, what: string): string {
  if (typeof range !== "string" || range.trim() === "") {
    throw new Error(`extension manifest ${what} must be a non-empty string`);
  }
  if (semver.validRange(range) === null) {
    throw new Error(`extension manifest dependsOn.${depId} is not a valid semver range: ${range}`);
  }
  return range;
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

function parseDependencyObject(depId: string, o: Record<string, unknown>): DependencySpec {
  const what = `dependsOn.${depId}`;
  rejectUnknownKeys(o, ["range", "registry", "rootKeyFingerprint"], what);
  const range = parseDependencyRange(depId, o["range"], `${what}.range`);
  const registry = o["registry"];
  if (
    registry !== undefined &&
    (typeof registry !== "string" || (registry !== OFFICIAL_REGISTRY_NAME && !isHttpsUrl(registry)))
  ) {
    throw new Error(
      `extension manifest ${what}.registry must be an https URL or "${OFFICIAL_REGISTRY_NAME}"`,
    );
  }
  const fp = o["rootKeyFingerprint"];
  if (fp !== undefined) {
    if (registry === undefined) {
      throw new Error(`extension manifest ${what}.rootKeyFingerprint requires registry`);
    }
    if (typeof fp !== "string" || !ROOT_KEY_FINGERPRINT_RE.test(fp.toLowerCase())) {
      throw new Error(`extension manifest ${what}.rootKeyFingerprint must be 32 hex characters`);
    }
  }
  return {
    range,
    ...(registry === undefined ? {} : { registry }),
    ...(typeof fp === "string" ? { rootKeyFingerprint: fp.toLowerCase() } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDependsOn(value: unknown): Readonly<Record<string, DependencySpec>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error("extension manifest dependsOn must be an object");
  }
  const out: Record<string, DependencySpec> = {};
  for (const [depId, spec] of Object.entries(value)) {
    if (depId.trim() === "") {
      throw new Error("extension manifest dependsOn keys must be non-empty strings");
    }
    out[depId] = isPlainObject(spec)
      ? parseDependencyObject(depId, spec)
      : { range: parseDependencyRange(depId, spec, `dependsOn.${depId}`) };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

const SYNC_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const CREDENTIAL_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * A credential env name is refused when it could change what the child RUNS rather than carry a
 * secret: the gateway's and the runtimes' own namespaces, the dynamic loaders' injection variables
 * (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, ...), Windows command resolution, and every baseline key
 * `extensionProcessEnv` copies, which a credential of that name would overwrite.
 */
const RESERVED_ENV_PREFIXES = ["NIMBUS_", "BUN_", "NODE_", "LD_", "DYLD_"] as const;
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
]);
const MIN_SYNC_INTERVAL_SECONDS = 60;

function asPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`extension manifest ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(o: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      throw new Error(`extension manifest ${what} has unknown key: ${k}`);
    }
  }
}

function parseSync(value: unknown): ExtensionSyncManifest | undefined {
  if (value === undefined) return undefined;
  const o = asPlainObject(value, "sync");
  rejectUnknownKeys(o, ["contract", "intervalSeconds", "itemTypes"], "sync");
  if (o["contract"] !== "1") {
    throw new Error('extension manifest sync.contract must be exactly "1"');
  }
  const interval = o["intervalSeconds"];
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < MIN_SYNC_INTERVAL_SECONDS
  ) {
    throw new Error(
      `extension manifest sync.intervalSeconds must be an integer >= ${MIN_SYNC_INTERVAL_SECONDS}`,
    );
  }
  const types = o["itemTypes"];
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    !types.every((t) => typeof t === "string" && SYNC_NAME_RE.test(t))
  ) {
    throw new Error(
      "extension manifest sync.itemTypes must be a non-empty array of [a-z][a-z0-9_]{0,31} names",
    );
  }
  return { contract: "1", intervalSeconds: interval, itemTypes: [...(types as string[])] };
}

function isReservedEnv(env: string): boolean {
  return (
    RESERVED_ENV_NAMES.has(env) ||
    isExtensionBaselineEnvKey(env) ||
    RESERVED_ENV_PREFIXES.some((p) => env.startsWith(p))
  );
}

function parseCredentials(value: unknown): ExtensionCredentialDecls | undefined {
  if (value === undefined) return undefined;
  const o = asPlainObject(value, "credentials");
  const out: Record<string, { readonly env: string }> = {};
  const seenEnv = new Set<string>();
  for (const [name, entry] of Object.entries(o)) {
    if (!SYNC_NAME_RE.test(name)) {
      throw new Error(
        `extension manifest credentials name must match [a-z][a-z0-9_]{0,31}: ${name}`,
      );
    }
    const e = asPlainObject(entry, `credentials.${name}`);
    rejectUnknownKeys(e, ["env"], `credentials.${name}`);
    const env = e["env"];
    if (typeof env !== "string" || !CREDENTIAL_ENV_RE.test(env) || isReservedEnv(env)) {
      throw new Error(
        `extension manifest credentials.${name}.env must match [A-Z][A-Z0-9_]{0,63} and not be a reserved variable`,
      );
    }
    if (seenEnv.has(env)) {
      throw new Error(`extension manifest credentials has duplicate env var: ${env}`);
    }
    seenEnv.add(env);
    out[name] = { env };
  }
  return out;
}

function parseKind(value: unknown): ExtensionKind {
  if (value === undefined) return "extension";
  if (value !== "extension" && value !== "starter-pack") {
    throw new Error(
      `extension manifest kind must be "extension" or "starter-pack" (got: ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseRequires(value: unknown): { readonly connectors: readonly string[] } | undefined {
  if (value === undefined) return undefined;
  const o = asPlainObject(value, "requires");
  rejectUnknownKeys(o, ["connectors"], "requires");
  const connectors = o["connectors"];
  if (!Array.isArray(connectors) || connectors.length === 0) {
    throw new Error("extension manifest requires.connectors must be non-empty array");
  }
  const ids: string[] = [];
  for (const [i, c] of connectors.entries()) {
    if (typeof c !== "string" || !CONNECTOR_ID_RE.test(c)) {
      throw new Error(
        `extension manifest requires.connectors[${i}] must match [a-z][a-z0-9_-]{0,63}`,
      );
    }
    ids.push(c);
  }
  return { connectors: [...new Set(ids)].sort(codeUnitCompare) };
}

/** True unless `raw` is absent or an object-form permissions block that grants nothing. */
function grantsAnyPermission(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (!isPlainObject(raw)) return true;
  const isEmptyList = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.length === 0);
  if (!isEmptyList(raw["network"])) return true;
  const fs = raw["filesystem"];
  if (fs === undefined) return false;
  return !isPlainObject(fs) || !isEmptyList(fs["read"]) || !isEmptyList(fs["write"]);
}

/**
 * A starter pack can never carry code or a grant: no entry, no permissions, no sync, no
 * credentials — checked on the RAW object, so a normalising parser cannot mask a declared grant.
 */
function assertStarterPackShape(
  o: Record<string, unknown>,
  blocks: Pick<ExtensionManifest, "dependsOn" | "requires">,
): void {
  if (o["entry"] !== undefined || o["entrypoint"] !== undefined) {
    throw new Error("extension manifest: a starter pack must not declare entry or entrypoint");
  }
  if (grantsAnyPermission(o["permissions"])) {
    throw new Error("extension manifest: a starter pack must not declare permissions");
  }
  for (const key of ["sync", "credentials"] as const) {
    if (o[key] !== undefined) {
      throw new Error(`extension manifest: a starter pack must not declare ${key}`);
    }
  }
  if (blocks.dependsOn === undefined && blocks.requires === undefined) {
    throw new Error("extension manifest: a starter pack must declare dependsOn or requires");
  }
}

// All 94 first-party connectors (each `connectors/<id>/nimbus.extension.json` in
// `@nimbus-dev/connectors`) declare `entrypoint`; this parser
// read only `entry`, so every one of them fell back to "dist/index.js" while building
// dist/server.js — an install recorded an empty entry hash and verification then failed
// with "entry file missing". `entry` still wins where both are present.
function parseEntry(o: Record<string, unknown>): string | undefined {
  const raw = typeof o["entry"] === "string" ? o["entry"] : o["entrypoint"];
  return typeof raw === "string" ? raw.trim().replaceAll("\\", "/") : undefined;
}

/**
 * The entry a raw (unvalidated) manifest object names, by the SAME rule the full parse applies
 * (`parseEntry` then {@link extensionEntryRelPath}). For a reader that must find the entry without
 * refusing the rest of the manifest — package inspection hashes the file the gateway will run.
 */
export function rawManifestEntryRelPath(raw: Record<string, unknown>): string {
  if (raw["kind"] === "starter-pack") return PACKAGE_MANIFEST_FILE;
  const entry = parseEntry(raw);
  return extensionEntryRelPath(entry === undefined ? {} : { entry });
}

export function parseExtensionManifestJson(text: string): ExtensionManifest {
  return parseExtensionManifestForRegistry(text).manifest;
}

export type RegistryParseResult = {
  manifest: ExtensionManifest;
  isPreT2Legacy: boolean;
};

function parseManifestObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("extension manifest is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extension manifest must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** The optional manifest blocks that are present; an absent block leaves no key at all. */
function parseOptionalBlocks(
  o: Record<string, unknown>,
): Pick<ExtensionManifest, "changelog" | "dependsOn" | "sync" | "credentials" | "requires"> {
  const changelog = parseChangelog(o["changelog"]);
  const dependsOn = parseDependsOn(o["dependsOn"]);
  const sync = parseSync(o["sync"]);
  const credentials = parseCredentials(o["credentials"]);
  const requires = parseRequires(o["requires"]);
  return {
    ...(changelog === undefined ? {} : { changelog }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(sync === undefined ? {} : { sync }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(requires === undefined ? {} : { requires }),
  };
}

export function parseExtensionManifestForRegistry(text: string): RegistryParseResult {
  const o = parseManifestObject(text);
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  const version = typeof o["version"] === "string" ? o["version"].trim() : "";
  if (id === "" || version === "") {
    throw new Error("extension manifest requires non-empty id and version");
  }
  const name = typeof o["name"] === "string" ? o["name"].trim() : undefined;
  const entry = parseEntry(o);
  const publisher = parsePublisher(o["publisher"]);
  const signature = parseSignature(o["signature"]);
  if ((publisher === undefined) !== (signature === undefined)) {
    throw new Error("extension manifest must have publisher and signature together, or neither");
  }
  const updateChannel = parseUpdateChannel(o["updateChannel"]);
  const kind = parseKind(o["kind"]);
  const blocks = parseOptionalBlocks(o);
  if (kind === "starter-pack") assertStarterPackShape(o, blocks);
  const isPreT2Legacy = Array.isArray(o["permissions"]);
  const permissions = validateAndNormalizePermissions(
    o["permissions"] === undefined ? {} : o["permissions"],
  );
  return {
    manifest: {
      id,
      version,
      ...(name !== undefined && name !== "" ? { name } : {}),
      ...(entry !== undefined && entry !== "" ? { entry } : {}),
      permissions,
      ...(publisher === undefined ? {} : { publisher }),
      ...(signature === undefined ? {} : { signature }),
      updateChannel,
      ...blocks,
      kind,
    },
    isPreT2Legacy,
  };
}
