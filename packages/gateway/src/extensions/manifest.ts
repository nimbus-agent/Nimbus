import { existsSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

import {
  type SandboxPermissions,
  validateAndNormalizePermissions,
} from "./permissions-validator.ts";

/** Canonical spec name; preferred when both exist. */
export const EXTENSION_MANIFEST_FILENAME = "nimbus.extension.json";

/** Legacy scaffold filename; still accepted for installs and verification. */
export const EXTENSION_MANIFEST_FILENAME_LEGACY = "nimbus-extension.json";

/** Order: canonical spec first, then legacy. */
export const EXTENSION_MANIFEST_FILENAMES = [
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_FILENAME_LEGACY,
] as const;

/** First manifest file present under `dir`, or undefined. */
export function resolveExtensionManifestPath(dir: string): string | undefined {
  for (const name of EXTENSION_MANIFEST_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

/**
 * Resolved manifest shape consumed by the rest of the Gateway. `permissions`
 * is the normalized `SandboxPermissions` envelope; legacy array-form input is
 * silently mapped to default-deny by the validator (see
 * `permissions-validator.ts`).
 */
export type ExtensionManifest = {
  id: string;
  version: string;
  name?: string;
  /** Relative path to entry file (default dist/index.js). */
  entry?: string;
  /** Sandbox permission envelope (object form; legacy array → default-deny). */
  permissions: SandboxPermissions;
  /** Verified-publisher identity (T2 PR 2). Paired with `signature`. */
  publisher?: { id: string; key: string };
  /** Base64 Ed25519 signature over the canonicalized manifest minus this field. */
  signature?: string;
  /**
   * Update channel for auto-update (T2 PR 3). Default `"stable"` when absent
   * on disk. The defaulted field is NOT emitted into canonical signature
   * bytes — `verifyManifestSignature` operates on the raw on-disk JSON, so
   * pre-PR-3 signed manifests keep verifying.
   */
  updateChannel: "stable" | "beta";
  /**
   * Plain-text changelog surfaced in the auto-update HITL consent dialog
   * (T2 PR 3). ≤ 4 KiB after NFC normalization.
   */
  changelog?: string;
  /**
   * Optional dependency map: { extensionId → semver range }. Consumed by the
   * dependency-resolution solver (T2 PR 4). Absent on legacy + zero-dep
   * extensions. Every range value must pass `semver.validRange`.
   */
  dependsOn?: Readonly<Record<string, string>>;
};

/** Allowed publisher id format. Matches the service-id pattern from CI/CD data layer. */
const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 32-byte Ed25519 pubkey in base64 standard encoding (with padding). */
const PUBLISHER_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** 64-byte Ed25519 signature in base64 standard encoding (with padding). */
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

/** Max byte length of the changelog after NFC normalization. */
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
    throw new Error("extension manifest changelog must be a string");
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

export function parseExtensionManifestJson(text: string): ExtensionManifest {
  return parseExtensionManifestForRegistry(text).manifest;
}

/**
 * Registry-load variant of {@link parseExtensionManifestJson}. Returns the
 * resolved manifest plus an `isPreT2Legacy` flag that is `true` iff the raw
 * `permissions` field used the legacy `string[]` form. T2 PR 1 (2026-05-16)
 * hard-disables pre-T2 extensions at registry-load time — once the manifest
 * has been normalized by `validateAndNormalizePermissions`, the array form
 * is indistinguishable from an explicit default-deny object form, so the
 * detection has to happen at this parse boundary. See
 * `extensions/hard-disable.ts` for the wiring site.
 */
export type RegistryParseResult = {
  manifest: ExtensionManifest;
  /** True iff the raw `permissions` field was the legacy `string[]` form. */
  isPreT2Legacy: boolean;
};

export function parseExtensionManifestForRegistry(text: string): RegistryParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("extension manifest is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extension manifest must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  const version = typeof o["version"] === "string" ? o["version"].trim() : "";
  if (id === "" || version === "") {
    throw new Error("extension manifest requires non-empty id and version");
  }
  const name = typeof o["name"] === "string" ? o["name"].trim() : undefined;
  const entry =
    typeof o["entry"] === "string" ? o["entry"].trim().replaceAll("\\", "/") : undefined;
  const publisher = parsePublisher(o["publisher"]);
  const signature = parseSignature(o["signature"]);
  if ((publisher === undefined) !== (signature === undefined)) {
    throw new Error("extension manifest must have publisher and signature together, or neither");
  }
  const updateChannel = parseUpdateChannel(o["updateChannel"]);
  const changelog = parseChangelog(o["changelog"]);
  const dependsOn = parseDependsOn(o["dependsOn"]);
  // Pre-T2 detection MUST happen on the raw JSON value, before
  // `validateAndNormalizePermissions` collapses the legacy array form to
  // default-deny. After normalization the two cases are indistinguishable.
  const isPreT2Legacy = Array.isArray(o["permissions"]);
  // Manifests without an explicit `permissions` field are treated as the
  // legacy default-deny shape — `validateAndNormalizePermissions(undefined)`
  // is not called directly because the validator only accepts arrays or
  // objects; missing → explicit empty object form.
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
      ...(publisher !== undefined ? { publisher } : {}),
      ...(signature !== undefined ? { signature } : {}),
      updateChannel,
      ...(changelog !== undefined ? { changelog } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    },
    isPreT2Legacy,
  };
}
