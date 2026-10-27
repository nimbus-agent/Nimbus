import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  readCurrentVerification,
  recordTrustStatements,
  replaceCurrentVerifications,
  type StatementSource,
} from "./trust-store.ts";
import { verifiedPublisherFor } from "./verified-publisher.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const pair = (n: number) => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256);
  const key = b64(nacl.sign.keyPair.fromSeed(seed).publicKey);
  return { seed, key, fp: publisherKeyFingerprint(key) };
};
const NIMBUS = pair(1);
const ROOT = pair(20);
const K = pair(40);
const X = pair(60);
const OTHER = pair(80);
const ISSUED = "2026-10-27T12:00:00Z";
const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS.key };
const GOOD = { registry: "good", rootFingerprint: ROOT.fp };

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

const vouch = (...keys: string[]) =>
  signTrustStatement(
    {
      kind: "publisher.verified",
      issuedAt: ISSUED,
      signerKey: NIMBUS.key,
      publisherId: "acme",
      keys,
      github: "acme-dev",
      verifiedAt: "2026-10-20T00:00:00Z",
    },
    NIMBUS.seed,
  );
const selfRevoke = (k: ReturnType<typeof pair>) =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: k.key,
      publisherId: "acme",
      keyFingerprint: k.fp,
      reason: "leaked",
    },
    k.seed,
  );
const rotate = (from: ReturnType<typeof pair>, to: ReturnType<typeof pair>) =>
  signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt: ISSUED,
      signerKey: from.key,
      publisherId: "acme",
      fromKey: from.key,
      toKey: to.key,
    },
    from.seed,
  );

async function verify(...keys: string[]): Promise<void> {
  replaceCurrentVerifications(db, [await vouch(...keys)], NIMBUS.key, 1);
}
const subject = (key: ReturnType<typeof pair>, source: typeof GOOD | null = GOOD) => ({
  publisherId: "acme",
  keyFingerprint: key.fp,
  source,
});

describe("readCurrentVerification", () => {
  test("returns the handle, date and listed fingerprints of the one current entry", async () => {
    await verify(K.key, X.key);
    expect(readCurrentVerification(db, "acme")).toEqual({
      keyFingerprints: new Set([K.fp, X.fp]),
      github: "acme-dev",
      verifiedAt: "2026-10-20T00:00:00Z",
    });
    expect(readCurrentVerification(db, "nobody")).toBeNull();
  });

  test("an unreadable stored entry is no verification (fail toward unverified)", async () => {
    await verify(K.key);
    dbRun(
      db,
      "UPDATE trust_statement SET statement_json = '{' WHERE kind = 'publisher.verified'",
      [],
    );
    expect(readCurrentVerification(db, "acme")).toBeNull();
  });
});

describe("verifiedPublisherFor (R6)", () => {
  test("a listed, unrevoked key gets the badge", async () => {
    await verify(K.key);
    expect(verifiedPublisherFor(db, subject(K))).toEqual({
      github: "acme-dev",
      verifiedAt: "2026-10-20T00:00:00Z",
    });
  });

  test("a key the entry does not list gets none — a rotated-to key Nimbus has not vouched for included", async () => {
    await verify(K.key);
    recordTrustStatements(db, [await rotate(K, X)], FEED, 1);
    expect(verifiedPublisherFor(db, subject(X))).toBeNull();
    expect(verifiedPublisherFor(db, subject(OTHER))).toBeNull();
  });

  test("a revoked key loses the badge, and so does a key tainted by a revoked ancestor (R4)", async () => {
    await verify(K.key, X.key);
    recordTrustStatements(db, [await selfRevoke(K)], FEED, 1);
    expect(verifiedPublisherFor(db, subject(K))).toBeNull();
    // X was rotated from K, and Nimbus vouching clears the taint (R4) — so X keeps it.
    recordTrustStatements(db, [await rotate(K, X)], FEED, 1);
    expect(verifiedPublisherFor(db, subject(X))).not.toBeNull();
  });

  test("a registry-carried revocation removes the badge only for that registry's copies", async () => {
    await verify(K.key);
    const good: StatementSource = {
      kind: "registry",
      name: "good",
      rootKey: ROOT.key,
      rootFingerprint: ROOT.fp,
      listedPublisherKeys: new Map([["acme", new Set([K.key])]]),
    };
    recordTrustStatements(db, [await selfRevoke(K)], good, 1);
    expect(verifiedPublisherFor(db, subject(K, GOOD))).toBeNull();
    expect(
      verifiedPublisherFor(db, subject(K, { registry: "elsewhere", rootFingerprint: ROOT.fp })),
    ).not.toBeNull();
  });

  test("no verification, two entries, unsigned code, or an old schema: no badge", async () => {
    expect(verifiedPublisherFor(db, subject(K))).toBeNull();
    await verify(K.key);
    expect(
      verifiedPublisherFor(db, { publisherId: null, keyFingerprint: K.fp, source: GOOD }),
    ).toBeNull();
    expect(
      verifiedPublisherFor(db, { publisherId: "acme", keyFingerprint: null, source: GOOD }),
    ).toBeNull();
    const second = (await vouch(X.key)) as TrustStatement;
    dbRun(
      db,
      `INSERT INTO trust_statement (statement_id, kind, statement_json, signer_fingerprint, signer_role,
         source, publisher_id, first_seen_at) VALUES ('dup', 'publisher.verified', ?, 'f', 'nimbus', 'feed', 'acme', 1)`,
      [JSON.stringify(second)],
    );
    expect(verifiedPublisherFor(db, subject(K))).toBeNull();
    const old = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(old, 75);
      expect(verifiedPublisherFor(old, subject(K))).toBeNull();
    } finally {
      old.close();
    }
  });
});
