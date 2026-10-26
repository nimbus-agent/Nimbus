import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { publisherKeyFingerprint } from "./fingerprint.ts";
import {
  MAX_STATEMENTS_PER_DOCUMENT,
  MAX_TRUST_FEED_BYTES,
  parseTrustFeed,
  readStatementList,
  readTrustFeedStatements,
  signTrustFeed,
  type TrustFeed,
  trustFeedDigest,
  trustFeedSigningBytes,
  verifyTrustFeedPinned,
} from "./trust-feed.ts";
import { signTrustStatement, type TrustStatement } from "./trust-statement.ts";

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const PUB_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey);
const PUB_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(PUB_SEED).publicKey);
const OTHER_KEY = encodeBase64(
  nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 100 + i)).publicKey,
);

// Pinned once from this file's fixtures; a change to the feed's signed bytes must be deliberate.
const PINNED_FEED_SIGNATURE =
  "CPTm2VPsO+sG5x4RSsu/hXNsLCGaQX9Qow80rikvnuAzRKEebMBSMBPeU584eFP1ZFS8+xZBsVvo7wYYOuk3CA==";

const ISSUED = "2026-10-26T12:00:00Z";

async function revoke(): Promise<TrustStatement> {
  return signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: PUB_KEY,
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(PUB_KEY),
      reason: "leaked",
    },
    PUB_SEED,
  );
}

async function verified(publisherId: string, key: string): Promise<TrustStatement> {
  return signTrustStatement(
    {
      kind: "publisher.verified",
      issuedAt: ISSUED,
      signerKey: ROOT_KEY,
      publisherId,
      keys: [key],
      github: publisherId,
      verifiedAt: ISSUED,
    },
    ROOT_SEED,
  );
}

function unsignedFeed(statements: unknown): Omit<TrustFeed, "signature"> {
  return { format: 1, rootKey: ROOT_KEY, sequence: 7, generatedAt: ISSUED, statements };
}

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

describe("trust feed", () => {
  test("golden vector: node:crypto and tweetnacl sign the fixture to the pinned signature", async () => {
    const u = unsignedFeed([]);
    const viaNacl = encodeBase64(
      nacl.sign.detached(trustFeedSigningBytes(u), nacl.sign.keyPair.fromSeed(ROOT_SEED).secretKey),
    );
    expect(viaNacl).toBe(PINNED_FEED_SIGNATURE);
    expect((await signTrustFeed(u, ROOT_SEED)).signature).toBe(PINNED_FEED_SIGNATURE);
  });

  test("round-trips and verifies against the pinned root", async () => {
    const feed = await signTrustFeed(unsignedFeed([await revoke()]), ROOT_SEED);
    const parsed = parseTrustFeed(enc(feed));
    await verifyTrustFeedPinned(parsed, ROOT_KEY);
    expect(parsed.sequence).toBe(7);
  });

  test("a different pinned root is refused", async () => {
    const feed = parseTrustFeed(enc(await signTrustFeed(unsignedFeed([]), ROOT_SEED)));
    await expect(verifyTrustFeedPinned(feed, OTHER_KEY)).rejects.toThrow(
      "ERR_TRUST_FEED_ROOT_KEY_CHANGED",
    );
  });

  test("a tampered sequence is refused", async () => {
    const feed = await signTrustFeed(unsignedFeed([]), ROOT_SEED);
    const parsed = parseTrustFeed(enc({ ...feed, sequence: 8 }));
    await expect(verifyTrustFeedPinned(parsed, ROOT_KEY)).rejects.toThrow(
      "ERR_TRUST_FEED_SIGNATURE_INVALID",
    );
  });

  test("an oversized document is refused before parsing", () => {
    expect(() => parseTrustFeed(new Uint8Array(MAX_TRUST_FEED_BYTES + 1))).toThrow(
      "ERR_REGISTRY_TOO_LARGE",
    );
  });

  test("an unknown format, a missing key or a bad sequence is refused", async () => {
    const feed = await signTrustFeed(unsignedFeed([]), ROOT_SEED);
    expect(() => parseTrustFeed(enc({ ...feed, format: 2 }))).toThrow("ERR_TRUST_FEED_INVALID");
    const { statements: _s, ...noStatements } = feed;
    expect(() => parseTrustFeed(enc(noStatements))).toThrow("ERR_TRUST_FEED_INVALID");
    expect(() => parseTrustFeed(enc({ ...feed, sequence: 0 }))).toThrow("ERR_TRUST_FEED_INVALID");
    expect(() => parseTrustFeed(new TextEncoder().encode("{not json"))).toThrow(
      "ERR_TRUST_FEED_INVALID",
    );
  });

  test("one bad statement is dropped and an unknown kind is skipped; the rest survive", async () => {
    const good = await revoke();
    const feed = await signTrustFeed(
      unsignedFeed([good, { kind: "key.unrevoke" }, { kind: "key.revoke" }]),
      ROOT_SEED,
    );
    const read = readTrustFeedStatements(parseTrustFeed(enc(feed)));
    expect(read.statements).toEqual([good]);
    expect(read.unknownKinds).toBe(1);
    expect(read.dropped).toBe(1);
  });

  test("two publisher.verified entries for one publisher refuse the feed", async () => {
    const feed = await signTrustFeed(
      unsignedFeed([await verified("acme", PUB_KEY), await verified("acme", OTHER_KEY)]),
      ROOT_SEED,
    );
    expect(() => readTrustFeedStatements(parseTrustFeed(enc(feed)))).toThrow(
      "ERR_TRUST_FEED_INVALID",
    );
  });

  test("the digest is stable across re-parse and changes with one statement", async () => {
    const a = parseTrustFeed(enc(await signTrustFeed(unsignedFeed([await revoke()]), ROOT_SEED)));
    const again = parseTrustFeed(enc(a));
    expect(trustFeedDigest(again)).toBe(trustFeedDigest(a));
    expect(trustFeedDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    const b = parseTrustFeed(
      enc(await signTrustFeed(unsignedFeed([await verified("acme", PUB_KEY)]), ROOT_SEED)),
    );
    expect(trustFeedDigest(b)).not.toBe(trustFeedDigest(a));
  });
});

describe("readStatementList", () => {
  test("absent is empty, a non-array is one drop", () => {
    expect(readStatementList(undefined)).toEqual({ statements: [], dropped: 0, unknownKinds: 0 });
    expect(readStatementList({ a: 1 })).toEqual({ statements: [], dropped: 1, unknownKinds: 0 });
  });

  test("entries past the cap are counted as dropped", async () => {
    const good = await revoke();
    const list = Array.from({ length: MAX_STATEMENTS_PER_DOCUMENT + 3 }, () => good);
    const read = readStatementList(list);
    expect(read.statements).toHaveLength(MAX_STATEMENTS_PER_DOCUMENT);
    expect(read.dropped).toBe(3);
  });
});
