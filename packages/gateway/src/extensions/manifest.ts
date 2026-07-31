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
};

const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

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
  // All 94 mcp-connectors and `nimbus scaffold extension` declare `entrypoint`; this parser
  // read only `entry`, so every one of them fell back to "dist/index.js" while building
  // dist/server.js — an install recorded an empty entry hash and verification then failed
  // with "entry file missing". `entry` still wins where both are present.
  const entryRaw = typeof o["entry"] === "string" ? o["entry"] : o["entrypoint"];
  const entry = typeof entryRaw === "string" ? entryRaw.trim().replaceAll("\\", "/") : undefined;
  const publisher = parsePublisher(o["publisher"]);
  const signature = parseSignature(o["signature"]);
  if ((publisher === undefined) !== (signature === undefined)) {
    throw new Error("extension manifest must have publisher and signature together, or neither");
  }
  const updateChannel = parseUpdateChannel(o["updateChannel"]);
  const changelog = parseChangelog(o["changelog"]);
  const dependsOn = parseDependsOn(o["dependsOn"]);
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
    },
    isPreT2Legacy,
  };
}
