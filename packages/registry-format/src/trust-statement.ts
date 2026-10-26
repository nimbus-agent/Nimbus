/**
 * Trust statements (marketplace trust layer): small signed objects that revoke a publisher key, take
 * an extension down, rotate a publisher to a new key, or record that Nimbus verified a publisher.
 * They travel inside the trust feed (`trust-feed.ts`) and inside a registry index (`statements`);
 * this module only parses, signs and checks who may have signed one. Deciding what a statement does
 * to an installed extension is the gateway's job.
 *
 * Each statement is signed over the canonical JSON of itself without `signature`, with the same
 * `canonicalize` the registry index uses, and names its signer in `signerKey`. A statement is
 * immutable once issued: its id is the SHA-256 of its canonical bytes WITH the signature, so the same
 * statement re-published in a later document keeps its id.
 */
// NOSONAR S1874: deprecated in SDK 1.32.0. Signed bytes must match `index-format.ts`, which signs this
// export; `@nimbus-dev/sdk/signing` NFC-normalises differently.

import { createHash, sign } from "node:crypto";
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874
import nacl from "tweetnacl";

import { RegistryError } from "./errors.ts";
import { assertSafeExtensionId } from "./extension-id.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import { PUBLISHER_ID_RE } from "./manifest.ts";
import { isValidSemver } from "./semver.ts";
import { privateKeyFromSeed } from "./sign.ts";

export type TrustStatementKind =
  | "key.revoke"
  | "extension.takedown"
  | "key.rotate"
  | "publisher.verified";

export const TRUST_STATEMENT_KINDS: readonly TrustStatementKind[] = [
  "key.revoke",
  "extension.takedown",
  "key.rotate",
  "publisher.verified",
];

interface StatementBase {
  kind: TrustStatementKind;
  issuedAt: string;
  /** Base64 Ed25519 public key whose signature this statement carries. */
  signerKey: string;
  signature: string;
}

export interface KeyRevokeStatement extends StatementBase {
  kind: "key.revoke";
  publisherId: string;
  keyFingerprint: string;
  reason: string;
}

export interface ExtensionTakedownStatement extends StatementBase {
  kind: "extension.takedown";
  extensionId: string;
  publisherId: string;
  versions: "*" | readonly string[];
  reason: string;
}

export interface KeyRotateStatement extends StatementBase {
  kind: "key.rotate";
  publisherId: string;
  fromKey: string;
  toKey: string;
}

export interface PublisherVerifiedStatement extends StatementBase {
  kind: "publisher.verified";
  publisherId: string;
  keys: readonly string[];
  github: string;
  verifiedAt: string;
}

export type TrustStatement =
  | KeyRevokeStatement
  | ExtensionTakedownStatement
  | KeyRotateStatement
  | PublisherVerifiedStatement;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A statement before signing; extra keys are allowed and become part of the signed bytes. */
export type UnsignedTrustStatement = DistributiveOmit<TrustStatement, "signature"> &
  Record<string, unknown>;

export const MAX_STATEMENT_REASON_CHARS = 500;
export const MAX_TAKEDOWN_VERSIONS = 100;
export const MAX_VERIFIED_KEYS = 10;

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;
const GITHUB_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_TRUST_STATEMENT_INVALID", detail);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("a statement must be an object");
  }
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw invalid(`${key} must be a non-empty string`);
  return v;
}

function matching(o: Record<string, unknown>, key: string, re: RegExp): string {
  const v = str(o, key);
  if (!re.test(v)) throw invalid(`${key} is malformed`);
  return v;
}

function timestamp(o: Record<string, unknown>, key: string): string {
  const v = str(o, key);
  if (Number.isNaN(Date.parse(v))) throw invalid(`${key} is not a timestamp`);
  return v;
}

function publisherId(o: Record<string, unknown>): string {
  const v = str(o, "publisherId");
  if (v.length > 64 || !PUBLISHER_ID_RE.test(v)) throw invalid("publisherId is malformed");
  return v;
}

function reason(o: Record<string, unknown>): string {
  const v = str(o, "reason");
  if ([...v].length > MAX_STATEMENT_REASON_CHARS) {
    throw invalid(`reason exceeds ${String(MAX_STATEMENT_REASON_CHARS)} characters`);
  }
  return v;
}

function versions(o: Record<string, unknown>): "*" | readonly string[] {
  const v = o["versions"];
  if (v === "*") return v;
  if (!Array.isArray(v) || v.length === 0) {
    throw invalid('versions must be "*" or a non-empty list');
  }
  if (v.length > MAX_TAKEDOWN_VERSIONS) {
    throw invalid(`versions lists more than ${String(MAX_TAKEDOWN_VERSIONS)} entries`);
  }
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string" || !isValidSemver(item))
      throw invalid("versions has a non-semver entry");
    if (seen.has(item)) throw invalid("versions has a duplicate entry");
    seen.add(item);
  }
  return v as string[];
}

function verifiedKeys(o: Record<string, unknown>): readonly string[] {
  const v = o["keys"];
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_VERIFIED_KEYS) {
    throw invalid(`keys must list 1 to ${String(MAX_VERIFIED_KEYS)} keys`);
  }
  const seen = new Set<string>();
  for (const k of v) {
    if (typeof k !== "string" || !KEY_RE.test(k)) throw invalid("keys has a malformed key");
    if (seen.has(k)) throw invalid("keys has a duplicate key");
    seen.add(k);
  }
  return v as string[];
}

/** True when `raw` is an object whose `kind` this version of the format knows. */
export function isKnownStatementKind(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const kind = (raw as Record<string, unknown>)["kind"];
  return typeof kind === "string" && (TRUST_STATEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Strict parse of one statement. Unknown extra keys are tolerated and carried through (the
 * signature covers them); an unknown `kind` is an error here — a document reader that wants to skip
 * unknown kinds checks `isKnownStatementKind` first. Does not verify the signature.
 */
export function parseTrustStatement(raw: unknown): TrustStatement {
  const o = asObject(raw);
  if (!isKnownStatementKind(o)) throw invalid("kind is not known");
  const base = {
    ...o,
    issuedAt: timestamp(o, "issuedAt"),
    signerKey: matching(o, "signerKey", KEY_RE),
    signature: matching(o, "signature", SIGNATURE_RE),
  };
  switch (o["kind"] as TrustStatementKind) {
    case "key.revoke":
      return {
        ...base,
        kind: "key.revoke",
        publisherId: publisherId(o),
        keyFingerprint: matching(o, "keyFingerprint", FINGERPRINT_RE),
        reason: reason(o),
      };
    case "extension.takedown": {
      const extensionId = str(o, "extensionId");
      try {
        assertSafeExtensionId(extensionId);
      } catch (e) {
        throw invalid(`extensionId is not safe: ${(e as Error).message}`);
      }
      return {
        ...base,
        kind: "extension.takedown",
        extensionId,
        publisherId: publisherId(o),
        versions: versions(o),
        reason: reason(o),
      };
    }
    case "key.rotate": {
      const fromKey = matching(o, "fromKey", KEY_RE);
      const toKey = matching(o, "toKey", KEY_RE);
      if (fromKey === toKey) throw invalid("fromKey and toKey are the same key");
      return { ...base, kind: "key.rotate", publisherId: publisherId(o), fromKey, toKey };
    }
    case "publisher.verified":
      return {
        ...base,
        kind: "publisher.verified",
        publisherId: publisherId(o),
        keys: verifiedKeys(o),
        github: matching(o, "github", GITHUB_HANDLE_RE),
        verifiedAt: timestamp(o, "verifiedAt"),
      };
  }
}

/** The bytes a statement's signature covers: its canonical JSON without `signature`. */
export function trustStatementSigningBytes(s: UnsignedTrustStatement | TrustStatement): Uint8Array {
  const { signature: _omitted, ...rest } = s as TrustStatement;
  return new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
}

/** The statement's stable id: SHA-256 (hex) of its canonical JSON, signature included. */
export function trustStatementId(s: TrustStatement): string {
  return createHash("sha256")
    .update(canonicalize(s)) // NOSONAR S1874
    .digest("hex");
}

/**
 * Signs `s` with a raw 32-byte Ed25519 seed. Not `async` and not `Promise.try`, for the same reason
 * as `signIndex`: a bad seed still rejects, and the registry action runs this under the runner's Node.
 */
export function signTrustStatement(
  s: UnsignedTrustStatement,
  seed: Uint8Array,
): Promise<TrustStatement> {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = s as UnsignedTrustStatement & { signature?: string };
    const sig = sign(null, trustStatementSigningBytes(rest), privateKeyFromSeed(seed));
    resolve({ ...rest, signature: sig.toString("base64") } as TrustStatement);
  });
}

/**
 * The authority a statement's signer carries: the key the statement concerns (`publisher`), the
 * Nimbus trust root (`nimbus`, applies everywhere), or a registry's root (`registry`, applies only to
 * extensions installed from that registry — the gateway enforces that scope).
 */
export type StatementSignerRole = "publisher" | "nimbus" | "registry";

function signatureVerifies(s: TrustStatement): boolean {
  try {
    return nacl.sign.detached.verify(
      trustStatementSigningBytes(s),
      new Uint8Array(Buffer.from(s.signature, "base64")),
      new Uint8Array(Buffer.from(s.signerKey, "base64")),
    );
  } catch {
    return false;
  }
}

/**
 * The authority a validly signed statement carries, or `null`. Pass the Nimbus trust root and/or the
 * root of the registry whose index carried the statement; a root that is not passed confers nothing.
 * Never throws.
 *
 * - `key.revoke`: by the revoked key itself, by Nimbus, or by a registry root.
 * - `extension.takedown`: by Nimbus or a registry root.
 * - `publisher.verified`: by Nimbus ONLY — a registry root cannot vouch for a publisher.
 * - `key.rotate`: by its `fromKey` only.
 */
export function verifyTrustStatement(
  s: TrustStatement,
  opts: { readonly nimbusRootKey?: string; readonly registryRootKey?: string },
): StatementSignerRole | null {
  if (!signatureVerifies(s)) return null;
  const root: StatementSignerRole | null =
    opts.nimbusRootKey !== undefined && s.signerKey === opts.nimbusRootKey
      ? "nimbus"
      : opts.registryRootKey !== undefined && s.signerKey === opts.registryRootKey
        ? "registry"
        : null;
  switch (s.kind) {
    case "key.revoke":
      if (publisherKeyFingerprint(s.signerKey) === s.keyFingerprint) return "publisher";
      return root;
    case "extension.takedown":
      return root;
    case "publisher.verified":
      return root === "nimbus" ? "nimbus" : null;
    case "key.rotate":
      return s.signerKey === s.fromKey ? "publisher" : null;
  }
}
