/**
 * Building the next Nimbus trust feed from its SOURCE (marketplace trust layer, spec § 6.13). A feed
 * repository's default branch never holds a signed document; it holds:
 *
 * - `publishers/<publisherId>.json` — one per verified publisher, `{ publisherId, keys, github }`:
 *   the feed's CURRENT verification state (R7). Removing the file un-verifies the publisher.
 * - `requests/<name>.json` — a Nimbus-root block (`key.revoke` / `extension.takedown`), unsigned.
 * - `statements/<id>.json` — a publisher-signed statement, carried for verified publishers only.
 *
 * `planTrustFeed` decides what the next feed changes (no key needed: `nimbus trust maintain plan`
 * and the registry action's `trust-check`); `buildTrustFeed` signs it (`trust maintain sign` and
 * `trust-sign`). One rule for every caller, so they cannot disagree. The rules:
 *
 * - Blocks are a union (R1): every RAW entry of the previous feed whose raw `kind` is not
 *   `publisher.verified` is carried verbatim — including kinds this version does not know and entries
 *   it cannot parse — so deleting a source file, or re-signing with an older tool, removes nothing.
 * - A request is signed once, by meaning (`alreadyCarried` under the feed's own root).
 * - An unchanged publisher file keeps its signed statement byte for byte (stable id and date).
 * - A publisher statement is admitted by the registries' own rule (`admitPublisherStatements`) with
 *   the publisher's Nimbus-verified keys as its bound keys: a feed-carried statement applies
 *   everywhere (R2), so only keys Nimbus vouched for can reach it.
 */
import { codeUnitCompare } from "./code-unit-compare.ts";
import { RegistryError } from "./errors.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import { admitPublisherStatements } from "./publisher-statements.ts";
import {
  alreadyCarried,
  assertFeedRequestSignable,
  parseRegistryRequest,
  REQUEST_NAME_RE,
  type RegistryRequest,
  signFeedRequest,
} from "./registry-requests.ts";
import { publicKeyFromSeed } from "./sign.ts";
import {
  MAX_STATEMENTS_PER_DOCUMENT,
  parseTrustFeed,
  readTrustFeedStatements,
  signTrustFeed,
  type TrustFeed,
  verifyTrustFeedPinned,
} from "./trust-feed.ts";
import {
  type PublisherVerifiedStatement,
  parseTrustStatement,
  signTrustStatement,
  type TrustStatement,
  trustStatementId,
  verifyTrustStatement,
} from "./trust-statement.ts";

export const TRUST_FEED_FILE = "trust.json";
export const FEED_CONFIG_FILE = "nimbus-trust.json";
export const FEED_PUBLISHERS_DIR = "publishers/";
export const FEED_REQUESTS_DIR = "requests/";
export const FEED_STATEMENTS_DIR = "statements/";

/** One source file: its repository-relative path (`/`-separated) and its parsed JSON. */
export interface FeedSourceFile {
  readonly path: string;
  readonly raw: unknown;
}

export interface FeedSource {
  readonly publishers: readonly FeedSourceFile[];
  readonly requests: readonly FeedSourceFile[];
  readonly statements: readonly FeedSourceFile[];
}

/** A verified publisher as its source file states it; `keys` sorted. */
export interface PublisherEntry {
  readonly publisherId: string;
  readonly keys: readonly string[];
  readonly github: string;
}

export interface FeedSkip {
  readonly path: string;
  readonly reason: string;
}

export interface FeedPlan {
  readonly status: "changed" | "unchanged";
  /** Requests to sign, in file-name order. */
  readonly blocks: ReadonlyArray<{ readonly path: string; readonly request: RegistryRequest }>;
  /** Publishers whose entry this run adds or re-signs. */
  readonly verified: ReadonlyArray<PublisherEntry & { readonly change: "added" | "changed" }>;
  /** Publisher ids whose entry the next feed drops. */
  readonly unverified: readonly string[];
  /** Publisher statements this run admits. */
  readonly admitted: readonly TrustStatement[];
  readonly skipped: readonly FeedSkip[];
}

const PLACEHOLDER_KEY = `${"A".repeat(43)}=`;
const PLACEHOLDER_SIGNATURE = `${"A".repeat(86)}==`;
const PUBLISHER_FILE_KEYS = ["publisherId", "keys", "github"] as const;

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_TRUST_STATEMENT_INVALID", detail);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `dir/<name>.json` → `<name>`, or `undefined` for any other shape. */
function baseName(path: string, dir: string): string | undefined {
  if (!path.startsWith(dir) || !path.endsWith(".json")) return undefined;
  const name = path.slice(dir.length, -".json".length);
  return name === "" || name.includes("/") ? undefined : name;
}

/** `nimbus-trust.json`: exactly `{ "format": 1 }`. Throws `ERR_TRUST_FEED_INVALID` otherwise. */
export function parseFeedConfig(raw: unknown): { format: 1 } {
  if (!isObject(raw) || Object.keys(raw).length !== 1 || raw["format"] !== 1) {
    throw new RegistryError(
      "ERR_TRUST_FEED_INVALID",
      `${FEED_CONFIG_FILE} must be exactly { "format": 1 }`,
    );
  }
  return { format: 1 };
}

/**
 * Strict parse of `publishers/<publisherId>.json`. The fields follow the `publisher.verified`
 * statement's own rules (checked over the would-be statement); unknown keys are refused, the file's
 * base name must be the publisher id, and the keys are returned sorted so the signed statement never
 * depends on the file's order.
 */
export function parsePublisherFile(path: string, raw: unknown): PublisherEntry {
  if (!isObject(raw)) throw invalid("a publisher file must be an object");
  for (const k of Object.keys(raw)) {
    if (!(PUBLISHER_FILE_KEYS as readonly string[]).includes(k)) {
      throw invalid(`a publisher file has an unknown key: ${k}`);
    }
  }
  const s = parseTrustStatement({
    kind: "publisher.verified",
    ...raw,
    verifiedAt: "2026-01-01T00:00:00Z",
    issuedAt: "2026-01-01T00:00:00Z",
    signerKey: PLACEHOLDER_KEY,
    signature: PLACEHOLDER_SIGNATURE,
  }) as PublisherVerifiedStatement;
  if (baseName(path, FEED_PUBLISHERS_DIR) !== s.publisherId) {
    throw invalid(`${path} must be named ${FEED_PUBLISHERS_DIR}${s.publisherId}.json`);
  }
  return { publisherId: s.publisherId, keys: [...s.keys].sort(codeUnitCompare), github: s.github };
}

/** The previous feed's raw entries that are not `publisher.verified`: carried verbatim (R1). */
function carriedEntries(prev: TrustFeed): unknown[] {
  if (!Array.isArray(prev.statements)) return [];
  return prev.statements.filter((e) => !(isObject(e) && e["kind"] === "publisher.verified"));
}

/** The previous feed's verified entries, by publisher id (root-signed only). */
function previousVerified(prev: TrustFeed): Map<string, PublisherVerifiedStatement> {
  const out = new Map<string, PublisherVerifiedStatement>();
  for (const s of readTrustFeedStatements(prev).statements) {
    if (s.kind !== "publisher.verified") continue;
    if (verifyTrustStatement(s, { nimbusRootKey: prev.rootKey }) !== "nimbus") continue;
    out.set(s.publisherId, s);
  }
  return out;
}

const sameEntry = (s: PublisherVerifiedStatement, e: PublisherEntry): boolean =>
  s.github === e.github &&
  s.keys.length === e.keys.length &&
  [...s.keys].sort(codeUnitCompare).every((k, i) => k === e.keys[i]);

/** True when request `a`'s block already covers `b`'s (same kind and subject, wider versions). */
function requestCovers(a: RegistryRequest, b: RegistryRequest): boolean {
  if (a.kind === "key.revoke" || b.kind === "key.revoke") {
    return (
      a.kind === "key.revoke" &&
      b.kind === "key.revoke" &&
      a.publisherId === b.publisherId &&
      a.keyFingerprint === b.keyFingerprint
    );
  }
  if (a.extensionId !== b.extensionId || a.publisherId !== b.publisherId) return false;
  if (a.versions === "*") return true;
  return b.versions !== "*" && b.versions.every((v) => a.versions.includes(v));
}

function planRequests(
  prev: TrustFeed,
  carried: readonly unknown[],
  files: readonly FeedSourceFile[],
  skipped: FeedSkip[],
): FeedPlan["blocks"] {
  const doc = { extensions: {}, statements: carried, rootKey: prev.rootKey };
  const blocks: Array<{ path: string; request: RegistryRequest }> = [];
  for (const f of [...files].sort((a, b) => codeUnitCompare(a.path, b.path))) {
    const name = baseName(f.path, FEED_REQUESTS_DIR);
    if (name === undefined || !REQUEST_NAME_RE.test(name)) {
      skipped.push({
        path: f.path,
        reason: `a request file must be ${FEED_REQUESTS_DIR}<name>.json`,
      });
      continue;
    }
    let request: RegistryRequest;
    try {
      request = parseRegistryRequest(f.raw);
      assertFeedRequestSignable(request, prev.rootKey);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      skipped.push({ path: f.path, reason: e.message });
      continue;
    }
    // Already signed into the feed, or covered by a request signed earlier in this run: nothing new.
    if (alreadyCarried(doc, request, "nimbus")) continue;
    if (blocks.some((b) => requestCovers(b.request, request))) continue;
    blocks.push({ path: f.path, request });
  }
  return blocks;
}

function planPublishers(
  prevVerified: ReadonlyMap<string, PublisherVerifiedStatement>,
  files: readonly FeedSourceFile[],
  skipped: FeedSkip[],
): { next: Map<string, PublisherEntry>; verified: FeedPlan["verified"]; unverified: string[] } {
  const next = new Map<string, PublisherEntry>();
  const verified: Array<PublisherEntry & { change: "added" | "changed" }> = [];
  for (const f of [...files].sort((a, b) => codeUnitCompare(a.path, b.path))) {
    let entry: PublisherEntry;
    try {
      entry = parsePublisherFile(f.path, f.raw);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      skipped.push({ path: f.path, reason: e.message });
      continue;
    }
    next.set(entry.publisherId, entry);
    const before = prevVerified.get(entry.publisherId);
    if (before === undefined) verified.push({ ...entry, change: "added" });
    else if (!sameEntry(before, entry)) verified.push({ ...entry, change: "changed" });
  }
  const unverified = [...prevVerified.keys()].filter((id) => !next.has(id)).sort(codeUnitCompare);
  return { next, verified, unverified };
}

function planStatements(
  carried: readonly unknown[],
  verifiedKeys: ReadonlyMap<string, PublisherEntry>,
  files: readonly FeedSourceFile[],
  skipped: FeedSkip[],
  reserved: number,
): TrustStatement[] {
  const pathById = new Map<string, string>();
  const candidates: TrustStatement[] = [];
  for (const f of [...files].sort((a, b) => codeUnitCompare(a.path, b.path))) {
    try {
      const s = parseTrustStatement(f.raw);
      pathById.set(trustStatementId(s), f.path);
      candidates.push(s);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      skipped.push({ path: f.path, reason: `not a valid statement: ${e.message}` });
    }
  }
  const admission = admitPublisherStatements({ extensions: {}, statements: carried }, candidates, {
    boundKeys: (publisherId) => new Set(verifiedKeys.get(publisherId)?.keys ?? []),
    // The feed's cap covers this run's blocks and verified entries too, so plan and build agree.
    maxStatements: MAX_STATEMENTS_PER_DOCUMENT - reserved,
    where: "the trust feed",
    unbound: (publisherId) =>
      `publisher ${publisherId} is not verified in the trust feed: only a verified publisher's own statements ride the feed (block an unverified publisher's key with \`nimbus trust maintain revoke-key\`)`,
  });
  for (const s of admission.skipped) {
    // Every candidate was parsed above, so its id is known; the fallback is for the impossible case.
    const path = pathById.get(s.id ?? "") ?? FEED_STATEMENTS_DIR;
    skipped.push({ path, reason: s.reason });
  }
  return admission.admitted;
}

/** What the next feed would change over `prev`, from `source`. Never throws on source data. */
export function planTrustFeed(prev: TrustFeed, source: FeedSource): FeedPlan {
  const skipped: FeedSkip[] = [];
  const carried = carriedEntries(prev);
  const blocks = planRequests(prev, carried, source.requests, skipped);
  const pubs = planPublishers(previousVerified(prev), source.publishers, skipped);
  const reserved = blocks.length + pubs.next.size;
  const admitted = planStatements(carried, pubs.next, source.statements, skipped, reserved);
  const changed =
    blocks.length > 0 ||
    pubs.verified.length > 0 ||
    pubs.unverified.length > 0 ||
    admitted.length > 0;
  return {
    status: changed ? "changed" : "unchanged",
    blocks,
    verified: pubs.verified,
    unverified: pubs.unverified,
    admitted,
    skipped,
  };
}

/** The verified entries of the next feed: kept byte for byte when unchanged, else signed at `at`. */
async function verifiedStatements(
  prev: TrustFeed,
  source: FeedSource,
  seed: Uint8Array,
  at: string,
): Promise<TrustStatement[]> {
  const before = previousVerified(prev);
  const { next } = planPublishers(before, source.publishers, []);
  const out: TrustStatement[] = [];
  for (const id of [...next.keys()].sort(codeUnitCompare)) {
    const entry = next.get(id) as PublisherEntry;
    const kept = before.get(id);
    if (kept !== undefined && sameEntry(kept, entry)) {
      out.push(kept);
      continue;
    }
    out.push(
      // NOSONAR S9382: sequential by design - one signature at a time, in publisher-id order
      await signTrustStatement(
        {
          kind: "publisher.verified",
          publisherId: entry.publisherId,
          keys: [...entry.keys],
          github: entry.github,
          verifiedAt: at,
          issuedAt: at,
          signerKey: prev.rootKey,
        },
        seed,
      ),
    );
  }
  return out;
}

/** An unsigned, empty feed at sequence 1 (`trust maintain init`). */
export function emptyTrustFeed(rootKey: string, at: string): Omit<TrustFeed, "signature"> {
  return { format: 1, rootKey, sequence: 1, generatedAt: at, statements: [] };
}

/**
 * The next signed feed, or `feed: undefined` when the plan is `unchanged`. `seed` must be `prev`'s
 * root; `at` is the run's time (a CI run passes its commit time). The result is checked the way a
 * client checks it before it is returned.
 */
export async function buildTrustFeed(
  prev: TrustFeed,
  source: FeedSource,
  seed: Uint8Array,
  at: string,
): Promise<{ plan: FeedPlan; feed: TrustFeed | undefined }> {
  const signer = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  if (signer !== prev.rootKey) {
    throw new RegistryError(
      "ERR_TRUST_FEED_ROOT_KEY_CHANGED",
      `the key given (fingerprint ${publisherKeyFingerprint(signer)}) is not the trust feed's root key (${publisherKeyFingerprint(prev.rootKey)})`,
    );
  }
  const plan = planTrustFeed(prev, source);
  if (plan.status === "unchanged") return { plan, feed: undefined };
  const blocks: TrustStatement[] = [];
  for (const b of plan.blocks) {
    // NOSONAR S9382: sequential by design - one signature at a time, in file-name order
    blocks.push(await signFeedRequest(b.request, prev.rootKey, seed, at));
  }
  const statements = [
    ...carriedEntries(prev),
    ...blocks,
    ...(await verifiedStatements(prev, source, seed, at)),
    ...plan.admitted,
  ];
  if (statements.length > MAX_STATEMENTS_PER_DOCUMENT) {
    throw new RegistryError(
      "ERR_TRUST_FEED_INVALID",
      `the next feed would carry ${String(statements.length)} statements; the cap is ${String(MAX_STATEMENTS_PER_DOCUMENT)}`,
    );
  }
  const { signature: _previous, ...carried } = prev;
  const feed = await signTrustFeed(
    { ...carried, format: 1, sequence: prev.sequence + 1, generatedAt: at, statements },
    seed,
  );
  // What a client does first: parse the bytes, read the statements, verify against the pinned root.
  const reparsed = parseTrustFeed(new TextEncoder().encode(JSON.stringify(feed)));
  readTrustFeedStatements(reparsed);
  await verifyTrustFeedPinned(reparsed, prev.rootKey);
  return { plan, feed };
}
