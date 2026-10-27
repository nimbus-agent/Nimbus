import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { blocksFor } from "./trust-blocks.ts";
import { isKeyRevoked, type KeyContext, keyContinuity } from "./trust-keys.ts";
import {
  recordTrustStatements,
  replaceCurrentVerifications,
  type StatementSource,
} from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const seed = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const pair = (n: number) => {
  const s = seed(n);
  const k = b64(nacl.sign.keyPair.fromSeed(s).publicKey);
  return { seed: s, key: k, fp: publisherKeyFingerprint(k) };
};
const NIMBUS = pair(1);
const REG = pair(30);
const K = pair(60);
const X = pair(90);
const Y = pair(120);
const Z = pair(150);
const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS.key };
const ISSUED = "2026-10-26T12:00:00Z";
const CTX: KeyContext = { publisherId: "acme", source: null };

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

function store(...s: TrustStatement[]): void {
  expect(recordTrustStatements(db, s, FEED, 1).inserted).toBe(s.length);
}
const rotate = (from: ReturnType<typeof pair>, to: ReturnType<typeof pair>, issuedAt = ISSUED) =>
  signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt,
      signerKey: from.key,
      publisherId: "acme",
      fromKey: from.key,
      toKey: to.key,
    },
    from.seed,
  );
const revoke = (k: ReturnType<typeof pair>, by = NIMBUS) =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: by.key,
      publisherId: "acme",
      keyFingerprint: k.fp,
      reason: "leaked",
    },
    by.seed,
  );
const vouch = (...keys: string[]) =>
  signTrustStatement(
    {
      kind: "publisher.verified",
      issuedAt: ISSUED,
      signerKey: NIMBUS.key,
      publisherId: "acme",
      keys,
      github: "acme",
      verifiedAt: ISSUED,
    },
    NIMBUS.seed,
  );

describe("R4 — revocation taints keys reached by rotation", () => {
  test("a rotation K→X signed BEFORE K's revocation still taints X (dates are not trusted)", async () => {
    store(await rotate(K, X, "2020-01-01T00:00:00Z"), await revoke(K));
    expect(isKeyRevoked(db, CTX, X.fp)).toBe(true);
    const b = blocksFor(db, {
      extensionId: "acme.tool",
      version: "1.0.0",
      publisherId: "acme",
      keyFingerprint: X.fp,
      source: null,
    });
    expect(b).toHaveLength(1);
    expect(b[0]?.reason).toContain(`key ${X.fp} was rotated from revoked key ${K.fp}`);
  });

  test("the taint follows the whole chain, and Nimbus vouching clears it for the vouched key only", async () => {
    store(await rotate(K, X), await rotate(X, Y), await revoke(K));
    expect(isKeyRevoked(db, CTX, Y.fp)).toBe(true);
    replaceCurrentVerifications(db, [await vouch(Y.key)], NIMBUS.key, 2);
    expect(isKeyRevoked(db, CTX, Y.fp)).toBe(false);
    expect(isKeyRevoked(db, CTX, X.fp)).toBe(true);
  });

  test("vouching never clears a revocation of the key itself", async () => {
    store(await revoke(X));
    replaceCurrentVerifications(db, [await vouch(X.key)], NIMBUS.key, 2);
    expect(isKeyRevoked(db, CTX, X.fp)).toBe(true);
  });

  test("a registry-scoped revocation taints only for code from that registry", async () => {
    const regSource: StatementSource = {
      kind: "registry",
      name: "community",
      rootKey: REG.key,
      rootFingerprint: REG.fp,
      listedPublisherKeys: new Map([["acme", new Set([K.key, X.key])]]),
    };
    expect(
      recordTrustStatements(db, [await revoke(K, REG), await rotate(K, X)], regSource, 1).inserted,
    ).toBe(2);
    expect(isKeyRevoked(db, CTX, X.fp)).toBe(false);
    expect(
      isKeyRevoked(
        db,
        { ...CTX, source: { registry: "community", rootFingerprint: REG.fp } },
        X.fp,
      ),
    ).toBe(true);
  });
});

describe("keyContinuity (R3, R5, R8)", () => {
  test("trusted and first-seen keys pass; an unrelated key does not", async () => {
    expect(keyContinuity(db, CTX, [K.fp], K.fp)).toEqual({ ok: true, via: "trusted" });
    expect(keyContinuity(db, CTX, [], X.fp)).toEqual({ ok: true, via: "new_publisher" });
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: false, reason: "unvouched" });
  });

  test("a rotation chain from a trusted key continues to any key along it", async () => {
    store(await rotate(K, X), await rotate(X, Y));
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: true, via: "rotation" });
    expect(keyContinuity(db, CTX, [K.fp], Y.fp)).toEqual({ ok: true, via: "rotation" });
  });

  test("R3: once K is revoked no rotation from it continues — X is revoked (tainted)", async () => {
    store(await rotate(K, X), await revoke(K));
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: false, reason: "revoked" });
  });

  test("R3 with vouching: Nimbus can vouch X; the chain from revoked K still does not count", async () => {
    store(await rotate(K, X), await rotate(K, Z), await revoke(K));
    replaceCurrentVerifications(db, [await vouch(X.key)], NIMBUS.key, 2);
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: true, via: "nimbus" });
    expect(keyContinuity(db, CTX, [K.fp], Z.fp)).toEqual({ ok: false, reason: "revoked" });
  });

  test("R8: a fork from K gives no automatic continuity unless Nimbus vouches", async () => {
    store(await rotate(K, X), await rotate(K, Y));
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: false, reason: "fork" });
    replaceCurrentVerifications(db, [await vouch(Y.key)], NIMBUS.key, 2);
    expect(keyContinuity(db, CTX, [K.fp], Y.fp)).toEqual({ ok: true, via: "nimbus" });
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: false, reason: "fork" });
  });

  test("a rotation cycle terminates and is a fork, not a continuation", async () => {
    store(await rotate(K, X), await rotate(X, Y), await rotate(Y, X));
    expect(keyContinuity(db, CTX, [K.fp], X.fp)).toEqual({ ok: false, reason: "fork" });
  });

  test("an intermediate revoked key cuts the chain for keys past it", async () => {
    store(await rotate(K, X), await rotate(X, Y), await revoke(X));
    expect(keyContinuity(db, CTX, [K.fp], Y.fp)).toEqual({ ok: false, reason: "revoked" });
  });
});
