/**
 * The trust feed (`trust.json`): one signed static document from Nimbus carrying trust statements
 * (`trust-statement.ts`). Signed by the Nimbus trust root over the canonical JSON of the document
 * without `signature`, with the same rules as the registry index: a size cap, a positive `sequence`
 * the client never lets go backwards, unknown top-level keys tolerated and carried through.
 *
 * `parseTrustFeed` checks the envelope only; statements are read with `readTrustFeedStatements`
 * once the signature has been verified, so nothing from an unverified document is interpreted.
 */
// NOSONAR S1874: deprecated in SDK 1.32.0. Signed bytes must match `index-format.ts`, which signs this
// export; `@nimbus-dev/sdk/signing` NFC-normalises differently.

import { createHash, sign } from "node:crypto";
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874
import nacl from "tweetnacl";
import { privateKeyFromSeed } from "./ed25519-seed.ts";
import { RegistryError } from "./errors.ts";
import {
  isKnownStatementKind,
  parseTrustStatement,
  type TrustStatement,
} from "./trust-statement.ts";

export const MAX_TRUST_FEED_BYTES = 8 * 1024 * 1024;
export const MAX_STATEMENTS_PER_DOCUMENT = 10_000;

export interface TrustFeed {
  format: 1;
  rootKey: string;
  sequence: number;
  generatedAt: string;
  /** Carried RAW (the signature covers the whole document); read with `readTrustFeedStatements`. */
  readonly statements: unknown;
  signature: string;
}

export type StatementsRead = {
  readonly statements: readonly TrustStatement[];
  /** Entries of a known kind that failed to parse, a non-list, or entries past the cap. */
  readonly dropped: number;
  /** Entries whose `kind` this version does not know; skipped, so a later kind never breaks a reader. */
  readonly unknownKinds: number;
};

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_TRUST_FEED_INVALID", detail);
}

/**
 * Reads a raw statement list. Never throws on data: absent is empty, a non-list counts as one drop,
 * a malformed statement of a known kind is dropped, an unknown kind is skipped, and entries past
 * `MAX_STATEMENTS_PER_DOCUMENT` are dropped. Signatures are NOT checked here.
 */
export function readStatementList(raw: unknown): StatementsRead {
  if (raw === undefined) return { statements: [], dropped: 0, unknownKinds: 0 };
  if (!Array.isArray(raw)) return { statements: [], dropped: 1, unknownKinds: 0 };
  const statements: TrustStatement[] = [];
  let dropped = Math.max(0, raw.length - MAX_STATEMENTS_PER_DOCUMENT);
  let unknownKinds = 0;
  for (const entry of raw.slice(0, MAX_STATEMENTS_PER_DOCUMENT)) {
    if (!isKnownStatementKind(entry)) {
      unknownKinds++;
      continue;
    }
    try {
      statements.push(parseTrustStatement(entry));
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      dropped++;
    }
  }
  return { statements, dropped, unknownKinds };
}

export function parseTrustFeed(bytes: Uint8Array): TrustFeed {
  if (bytes.byteLength > MAX_TRUST_FEED_BYTES) {
    throw new RegistryError(
      "ERR_REGISTRY_TOO_LARGE",
      `trust.json exceeds ${String(MAX_TRUST_FEED_BYTES)} bytes`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid("trust.json is not valid UTF-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("trust.json is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("trust.json must be an object");
  }
  const o = raw as Record<string, unknown>;
  for (const k of ["format", "rootKey", "sequence", "generatedAt", "statements", "signature"]) {
    if (!(k in o)) throw invalid(`trust.json is missing key: ${k}`);
  }
  if (o["format"] !== 1) throw invalid("unsupported trust feed format");
  const sequence = o["sequence"];
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw invalid("sequence must be a positive integer");
  }
  const rootKey = o["rootKey"];
  if (typeof rootKey !== "string" || !KEY_RE.test(rootKey)) throw invalid("rootKey is malformed");
  const signature = o["signature"];
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
    throw invalid("signature is malformed");
  }
  const generatedAt = o["generatedAt"];
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw invalid("generatedAt is not a timestamp");
  }
  return {
    ...o,
    format: 1,
    rootKey,
    sequence,
    generatedAt,
    statements: o["statements"],
    signature,
  };
}

/**
 * The feed's statements, read as `readStatementList` does. Throws `ERR_TRUST_FEED_INVALID` when two
 * `publisher.verified` entries name one publisher: verification is read as the feed's current state,
 * so an ambiguous feed is refused whole rather than resolved by order.
 */
export function readTrustFeedStatements(feed: TrustFeed): StatementsRead {
  const read = readStatementList(feed.statements);
  const verified = new Set<string>();
  for (const s of read.statements) {
    if (s.kind !== "publisher.verified") continue;
    if (verified.has(s.publisherId)) {
      throw invalid(`two publisher.verified entries for "${s.publisherId}"`);
    }
    verified.add(s.publisherId);
  }
  return read;
}

export function trustFeedSigningBytes(feed: Omit<TrustFeed, "signature"> | TrustFeed): Uint8Array {
  const { signature: _omitted, ...rest } = feed as TrustFeed;
  return new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
}

/** SHA-256 (hex) of the feed's signing bytes: what the client stores to refuse equivocation. */
export function trustFeedDigest(feed: TrustFeed): string {
  return createHash("sha256").update(trustFeedSigningBytes(feed)).digest("hex");
}

/** Not `async` and not `Promise.try`: see `verifyRegistryIndexSelf`. */
export function verifyTrustFeedPinned(feed: TrustFeed, pinnedRootKey: string): Promise<void> {
  return new Promise((resolve) => {
    if (feed.rootKey !== pinnedRootKey) {
      throw new RegistryError(
        "ERR_TRUST_FEED_ROOT_KEY_CHANGED",
        "trust feed root key differs from the pinned key",
      );
    }
    let ok: boolean;
    try {
      ok = nacl.sign.detached.verify(
        trustFeedSigningBytes(feed),
        new Uint8Array(Buffer.from(feed.signature, "base64")),
        new Uint8Array(Buffer.from(feed.rootKey, "base64")),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new RegistryError(
        "ERR_TRUST_FEED_SIGNATURE_INVALID",
        "trust feed signature does not verify",
      );
    }
    resolve();
  });
}

/** Not `async` and not `Promise.try`: see `signIndex`. */
export function signTrustFeed(
  unsigned: Omit<TrustFeed, "signature">,
  seed: Uint8Array,
): Promise<TrustFeed> {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = unsigned as TrustFeed;
    const sig = sign(null, trustFeedSigningBytes(rest), privateKeyFromSeed(seed));
    resolve({ ...rest, signature: sig.toString("base64") });
  });
}
