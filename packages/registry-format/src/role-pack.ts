/**
 * The role-pack manifest: a declarative bundle that reshapes one Nimbus install for a role. Pure
 * shape rules only. What a pack may SET is the gateway's call (`config/pack-settable.ts` checks
 * `defaults`), and whether a listed connector, agent or member is acceptable is checked there too.
 */
import { createHash } from "node:crypto";
// NOSONAR S1874: the same deprecated export `index-format.ts` signs with, for the same reason.
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874

import { MAX_ROLE_PACK_DEFAULTS_BYTES, MAX_ROLE_PACK_MANIFEST_BYTES } from "./caps.ts";
import { RegistryError } from "./errors.ts";
import { assertSafeExtensionId } from "./extension-id.ts";
import { isValidSemver } from "./semver.ts";

/** Equal to the gateway's `PACK_ID_RE` (a gateway test pins the two), which this package cannot import. */
export const ROLE_PACK_ID_RE =
  /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9_-]{0,63}$/;
export const CONNECTOR_ID_SHAPE_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
export const ROLE_TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const MAX_ROLE_PACK_ROLES = 8;
export const MAX_ROLE_PACK_CONNECTORS = 32;
export const MAX_ROLE_PACK_MEMBERS = 32;

const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 500;

export interface RolePackManifest {
  readonly schema: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly roles: readonly string[];
  readonly suggestedConnectors: readonly string[];
  readonly members: readonly string[];
  readonly defaults: string;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "id",
  "name",
  "version",
  "description",
  "roles",
  "suggestedConnectors",
  "members",
  "defaults",
]);

function refuse(path: string, why: string): RegistryError {
  return new RegistryError("ERR_REGISTRY_ROLE_PACK_INVALID", `${path}: ${why}`);
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Undefined for an absent key; an own property only, so an inherited value is never read. */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function requiredString(o: Record<string, unknown>, key: string): string {
  const v = own(o, key);
  if (typeof v !== "string" || v === "") throw refuse(key, "must be a non-empty string");
  return v;
}

/** 1..max chars, no surrounding whitespace (refused, not trimmed, so a typo never hides in the digest). */
function displayText(o: Record<string, unknown>, key: string, max: number): string {
  const v = requiredString(o, key);
  if (v.length > max) throw refuse(key, `must be at most ${String(max)} characters`);
  if (v !== v.trim()) throw refuse(key, "must not have leading or trailing whitespace");
  return v;
}

function stringList(
  o: Record<string, unknown>,
  key: string,
  max: number,
  check: (item: string, path: string) => void,
): readonly string[] {
  const v = own(o, key);
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw refuse(key, "must be an array of strings");
  if (v.length > max) throw refuse(key, `exceeds maximum of ${String(max)} entries`);
  const seen = new Set<string>();
  const out: string[] = [];
  v.forEach((item: unknown, i) => {
    const path = `${key}[${String(i)}]`;
    if (typeof item !== "string") throw refuse(path, "must be a string");
    check(item, path);
    if (seen.has(item)) throw refuse(path, `duplicate entry ${JSON.stringify(item)}`);
    seen.add(item);
    out.push(item);
  });
  return out;
}

function matchingShape(re: RegExp): (item: string, path: string) => void {
  return (item, path) => {
    if (!re.test(item)) throw refuse(path, `${JSON.stringify(item)} is malformed`);
  };
}

function safeExtensionId(item: string, path: string): void {
  try {
    assertSafeExtensionId(item);
  } catch (e) {
    throw refuse(path, e instanceof Error ? e.message : String(e));
  }
}

function plainObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw refuse("manifest", "must be a JSON object");
  }
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw refuse("manifest", "must be a plain JSON object");
  }
  return raw as Record<string, unknown>;
}

/** Validate an already-parsed manifest (e.g. a static JSON import). Throws `RegistryError`. */
export function parseRolePackManifestValue(raw: unknown): RolePackManifest {
  const o = plainObject(raw);
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) throw refuse(key, "is not a known role-pack field");
  }
  if (own(o, "schema") !== 1) throw refuse("schema", "must be 1");
  const id = requiredString(o, "id");
  if (!ROLE_PACK_ID_RE.test(id)) throw refuse("id", `${JSON.stringify(id)} is malformed`);
  const name = displayText(o, "name", MAX_NAME_CHARS);
  const version = requiredString(o, "version");
  if (!isValidSemver(version)) throw refuse("version", "must be strict semver (MAJOR.MINOR.PATCH)");
  const description = displayText(o, "description", MAX_DESCRIPTION_CHARS);
  const roles = stringList(o, "roles", MAX_ROLE_PACK_ROLES, matchingShape(ROLE_TAG_RE));
  const suggestedConnectors = stringList(
    o,
    "suggestedConnectors",
    MAX_ROLE_PACK_CONNECTORS,
    matchingShape(CONNECTOR_ID_SHAPE_RE),
  );
  const members = stringList(o, "members", MAX_ROLE_PACK_MEMBERS, safeExtensionId);
  const defaultsRaw = own(o, "defaults");
  if (defaultsRaw !== undefined && typeof defaultsRaw !== "string") {
    throw refuse("defaults", "must be a string");
  }
  const defaults = defaultsRaw ?? "";
  if (utf8Bytes(defaults) > MAX_ROLE_PACK_DEFAULTS_BYTES) {
    throw refuse("defaults", `exceeds ${String(MAX_ROLE_PACK_DEFAULTS_BYTES)} UTF-8 bytes`);
  }
  return {
    schema: 1,
    id,
    name,
    version,
    description,
    roles,
    suggestedConnectors,
    members,
    defaults,
  };
}

/** Parse and validate manifest text. Throws `RegistryError` (never a bare `SyntaxError`). */
export function parseRolePackManifest(text: string): RolePackManifest {
  if (utf8Bytes(text) > MAX_ROLE_PACK_MANIFEST_BYTES) {
    throw refuse("manifest", `exceeds ${String(MAX_ROLE_PACK_MANIFEST_BYTES)} bytes`);
  }
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    throw refuse("manifest", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseRolePackManifestValue(raw);
}

/** SHA-256 hex over the canonical JSON of the parsed manifest: formatting and key order never count. */
export function rolePackDigest(m: RolePackManifest): string {
  return createHash("sha256").update(canonicalize(m)).digest("hex"); // NOSONAR S1874
}
