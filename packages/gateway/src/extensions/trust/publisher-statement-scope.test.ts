/**
 * A publisher-signed statement that arrives in a registry's index applies only to extensions
 * installed from that registry; the same statement in the Nimbus trust feed (or its snapshot)
 * applies everywhere. Without this, a hostile third-party registry could list a victim's publisher
 * id under its own key S, publish `rotate S -> victim key` and `revoke S` (both self-signed by S),
 * and R4 would block the victim's key on every machine that had that registry configured.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { type BlockSubject, blocksFor } from "./trust-blocks.ts";
import { type KeyContext, keyContinuity } from "./trust-keys.ts";
import { recordTrustStatements, type StatementSource } from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const pair = (n: number) => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256);
  const key = b64(nacl.sign.keyPair.fromSeed(seed).publicKey);
  return { seed, key, fp: publisherKeyFingerprint(key) };
};
const NIMBUS = pair(1);
const ROOT_A = pair(20);
const ROOT_H = pair(40);
const VICTIM = pair(60);
const ATTACKER = pair(80);
const NEXT = pair(100);
const ISSUED = "2026-10-27T12:00:00Z";

const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS.key };
function registry(name: string, root: ReturnType<typeof pair>, listed: string[]): StatementSource {
  return {
    kind: "registry",
    name,
    rootKey: root.key,
    rootFingerprint: root.fp,
    listedPublisherKeys: new Map([["acme", new Set(listed)]]),
  };
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

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

function subject(key: ReturnType<typeof pair>, from: string | null): BlockSubject {
  return {
    extensionId: "acme/tool",
    version: "1.0.0",
    publisherId: "acme",
    keyFingerprint: key.fp,
    source:
      from === null
        ? null
        : { registry: from, rootFingerprint: from === "hostile" ? ROOT_H.fp : ROOT_A.fp },
  };
}

function record(source: StatementSource, ...s: TrustStatement[]) {
  return recordTrustStatements(db, s, source, 1);
}

describe("publisher statements are scoped to the registry that carried them", () => {
  test("a hostile registry's planted rotation + revocation cannot block a victim installed from elsewhere", async () => {
    const hostile = registry("hostile", ROOT_H, [ATTACKER.key, VICTIM.key]);
    record(hostile, await rotate(ATTACKER, VICTIM), await selfRevoke(ATTACKER));
    expect(blocksFor(db, subject(VICTIM, "good"))).toEqual([]);
    expect(blocksFor(db, subject(VICTIM, null))).toEqual([]);
    // Within the hostile registry it applies: that registry already controls its own extensions.
    expect(blocksFor(db, subject(VICTIM, "hostile"))).toHaveLength(1);
  });

  test("a publisher's self-revocation from a registry blocks that registry's copies only", async () => {
    record(registry("good", ROOT_A, [VICTIM.key]), await selfRevoke(VICTIM));
    expect(blocksFor(db, subject(VICTIM, "good"))).toHaveLength(1);
    expect(blocksFor(db, subject(VICTIM, "other"))).toEqual([]);
  });

  test("the same statements in the Nimbus trust feed apply everywhere", async () => {
    record(FEED, await rotate(ATTACKER, VICTIM), await selfRevoke(ATTACKER));
    expect(blocksFor(db, subject(VICTIM, "good"))).toHaveLength(1);
    expect(blocksFor(db, subject(VICTIM, null))).toHaveLength(1);
  });

  test("a statement already stored from one registry also applies once a second registry carries it", async () => {
    const revocation = await selfRevoke(VICTIM);
    record(registry("good", ROOT_A, [VICTIM.key]), revocation);
    expect(blocksFor(db, subject(VICTIM, "other"))).toEqual([]);
    const second = record(registry("other", ROOT_A, [VICTIM.key]), revocation);
    // Widening a statement's scope is reported, so the enforcer re-checks running extensions.
    expect(second.insertedIds).toHaveLength(1);
    expect(blocksFor(db, subject(VICTIM, "other"))).toHaveLength(1);
  });

  test("a rotation from registry A gives continuity only to extensions sourced from A", async () => {
    record(registry("good", ROOT_A, [VICTIM.key]), await rotate(VICTIM, NEXT));
    const ctxA: KeyContext = { publisherId: "acme", source: subject(VICTIM, "good").source };
    const ctxB: KeyContext = { publisherId: "acme", source: subject(VICTIM, "other").source };
    expect(keyContinuity(db, ctxA, [VICTIM.fp], NEXT.fp)).toEqual({ ok: true, via: "rotation" });
    expect(keyContinuity(db, ctxB, [VICTIM.fp], NEXT.fp)).toEqual({
      ok: false,
      reason: "unvouched",
    });
  });
});
