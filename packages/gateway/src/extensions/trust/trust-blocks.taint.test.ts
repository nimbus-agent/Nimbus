import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { type BlockSubject, blocksFor, taintBlocks } from "./trust-blocks.ts";
import { recordTrustStatements, type StatementSource } from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const seed = (start: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => start + i);
const key = (s: Uint8Array): string => b64(nacl.sign.keyPair.fromSeed(s).publicKey);
const NIMBUS_SEED = seed(1);
const REGISTRY_SEED = seed(40);
const OLD_SEED = seed(80);
const NEW_SEED = seed(120);
const NIMBUS_KEY = key(NIMBUS_SEED);
const REGISTRY_KEY = key(REGISTRY_SEED);
const OLD_KEY = key(OLD_SEED);
const NEW_KEY = key(NEW_SEED);
const OLD_FP = publisherKeyFingerprint(OLD_KEY);
const NEW_FP = publisherKeyFingerprint(NEW_KEY);
const REGISTRY_FP = publisherKeyFingerprint(REGISTRY_KEY);

const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS_KEY };
const REGISTRY: StatementSource = {
  kind: "registry",
  name: "community",
  rootKey: REGISTRY_KEY,
  rootFingerprint: REGISTRY_FP,
  listedPublisherKeys: new Map([["acme", new Set([OLD_KEY])]]),
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

const subject = (over: Partial<BlockSubject> = {}): BlockSubject => ({
  extensionId: "acme/deploy",
  version: "1.0.0",
  publisherId: "acme",
  keyFingerprint: NEW_FP,
  source: { registry: "community", rootFingerprint: REGISTRY_FP },
  ...over,
});

function record(source: StatementSource, ...statements: TrustStatement[]): void {
  expect(recordTrustStatements(db, statements, source, 1).inserted).toBe(statements.length);
}

const revokeOld = (): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: "2026-10-26T12:00:00Z",
      signerKey: NIMBUS_KEY,
      publisherId: "acme",
      keyFingerprint: OLD_FP,
      reason: "leaked",
    },
    NIMBUS_SEED,
  );

const rotateOldToNew = (): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt: "2026-10-25T12:00:00Z",
      signerKey: OLD_KEY,
      publisherId: "acme",
      fromKey: OLD_KEY,
      toKey: NEW_KEY,
    },
    OLD_SEED,
  );

describe("taintBlocks (a key reached by rotation from a revoked key)", () => {
  test("blocks the rotated-to key with the revocation's statement id and a rotation reason", async () => {
    record(FEED, await revokeOld());
    record(REGISTRY, await rotateOldToNew());
    const blocks = taintBlocks(db, subject());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("key.revoke");
    expect(blocks[0]?.issuer).toBe("nimbus");
    expect(blocks[0]?.reason).toBe(`key ${NEW_FP} was rotated from revoked key ${OLD_FP}: leaked`);
    expect(blocksFor(db, subject()).map((b) => b.statementId)).toEqual([
      blocks[0]?.statementId ?? "",
    ]);
  });

  test("nothing is tainted without the rotation edge", async () => {
    record(FEED, await revokeOld());
    expect(taintBlocks(db, subject())).toEqual([]);
  });

  test("nothing is tainted when no revocation exists", async () => {
    record(REGISTRY, await rotateOldToNew());
    expect(taintBlocks(db, subject())).toEqual([]);
  });

  test("unsigned code or a subject without a key fingerprint has no taint", async () => {
    record(FEED, await revokeOld());
    record(REGISTRY, await rotateOldToNew());
    expect(taintBlocks(db, subject({ publisherId: null }))).toEqual([]);
    expect(taintBlocks(db, subject({ keyFingerprint: null }))).toEqual([]);
  });

  test("a rotation carried by another registry does not count for this source", async () => {
    record(FEED, await revokeOld());
    record(REGISTRY, await rotateOldToNew());
    expect(
      taintBlocks(db, subject({ source: { registry: "other", rootFingerprint: REGISTRY_FP } })),
    ).toEqual([]);
  });
});
