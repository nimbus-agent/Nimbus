import { existsSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

import {
  type SandboxPermissions,
  validateAndNormalizePermissions,
} from "./permissions-validator.ts";

export const EXTENSION_MANIFEST_FILENAME = "nimbus.extension.json";

export const EXTENSION_MANIFEST_FILENAME_LEGACY = "nimbus-extension.json";

export const EXTENSION_MANIFEST_FILENAMES = [
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_FILENAME_LEGACY,
] as const;

export function resolveExtensionManifestPath(dir: string): string | undefined {
  for (const name of EXTENSION_MANIFEST_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

/** The entry an extension runs when its manifest names none. */
export const DEFAULT_EXTENSION_ENTRY = "dist/index.js";

/**
 * The manifest's entry, relative to the install path, with an absent or empty `entry` falling back
 * to {@link DEFAULT_EXTENSION_ENTRY}. The ONE spelling of that rule — install, package hashing, startup and
 * strict verification and the pre-spawn accessor all read it — so the file hashed is the file
 * spawned. Lives here, in the manifest leaf module, so every consumer can import it without a cycle.
 */
export function extensionEntryRelPath(manifest: { readonly entry?: string }): string {
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
  dependsOn?: Readonly<Record<string, string>>;
  sync?: ExtensionSyncManifest;
  credentials?: ExtensionCredentialDecls;
};

export const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

const PUBLISHER_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

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

function parseDependsOn(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension manifest dependsOn must be an object");
  }
  const o = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [depId, range] of Object.entries(o)) {
    if (typeof depId !== "string" || depId.trim() === "") {
      throw new Error("extension manifest dependsOn keys must be non-empty strings");
    }
    if (typeof range !== "string" || range.trim() === "") {
      throw new Error(`extension manifest dependsOn.${depId} must be a non-empty string`);
    }
    if (semver.validRange(range) === null) {
      throw new Error(
        `extension manifest dependsOn.${depId} is not a valid semver range: ${range}`,
      );
    }
    out[depId] = range;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

const SYNC_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const CREDENTIAL_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV_PREFIXES = ["NIMBUS_", "BUN_", "NODE_"] as const;
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
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
  return RESERVED_ENV_NAMES.has(env) || RESERVED_ENV_PREFIXES.some((p) => env.startsWith(p));
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

// All 94 first-party connectors (each `connectors/<id>/nimbus.extension.json` in
// `@nimbus-dev/connectors`) declare `entrypoint`; this parser
// read only `entry`, so every one of them fell back to "dist/index.js" while building
// dist/server.js — an install recorded an empty entry hash and verification then failed
// with "entry file missing". `entry` still wins where both are present.
function parseEntry(o: Record<string, unknown>): string | undefined {
  const raw = typeof o["entry"] === "string" ? o["entry"] : o["entrypoint"];
  return typeof raw === "string" ? raw.trim().replaceAll("\\", "/") : undefined;
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
  const changelog = parseChangelog(o["changelog"]);
  const dependsOn = parseDependsOn(o["dependsOn"]);
  const sync = parseSync(o["sync"]);
  const credentials = parseCredentials(o["credentials"]);
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
      ...(changelog === undefined ? {} : { changelog }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(sync === undefined ? {} : { sync }),
      ...(credentials === undefined ? {} : { credentials }),
    },
    isPreT2Legacy,
  };
}
