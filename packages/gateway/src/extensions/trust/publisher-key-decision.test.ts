import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { publisherKeyFingerprint, signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { writePublisherKeyFor } from "../publisher-keys.ts";
import {
  keyChangeNote,
  publisherKeyConflict,
  publisherKeyDecision,
} from "./publisher-key-decision.ts";
import { recordTrustStatements } from "./trust-store.ts";

const pair = (n: number) => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => n + i);
  const pub = nacl.sign.keyPair.fromSeed(seed).publicKey;
  const key = Buffer.from(pub).toString("base64");
  return { seed, pub, key, fp: publisherKeyFingerprint(key) };
};
const K = pair(10);
const X = pair(50);
const FEED_ROOT = Buffer.from(new Uint8Array(32).fill(2)).toString("base64");

let db: Database;
let vault: MockVault;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  vault = new MockVault();
});
afterEach(() => db.close());

const decide = (over: { acceptFingerprint?: string; installedFingerprint?: string | null } = {}) =>
  publisherKeyDecision({ db, vault }, { publisherId: "acme", key: X.key, source: null, ...over });

async function revokeX(): Promise<void> {
  const s = await signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: "2026-10-26T12:00:00Z",
      signerKey: X.key,
      publisherId: "acme",
      keyFingerprint: X.fp,
      reason: "leaked",
    },
    X.seed,
  );
  recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: FEED_ROOT }, 1);
}

describe("publisherKeyDecision", () => {
  test("a first-seen publisher, and an already-trusted key, carry no change", async () => {
    expect(await decide()).toEqual({ ok: true, via: "new_publisher", change: null });
    await writePublisherKeyFor(vault, "acme", X.pub);
    expect(await decide()).toEqual({ ok: true, via: "trusted", change: null });
  });

  test("an unvouched key is refused with the change; the owner can accept that exact key", async () => {
    await writePublisherKeyFor(vault, "acme", K.pub);
    expect(await decide()).toEqual({
      ok: false,
      reason: "unvouched",
      change: { from: [K.fp], to: X.fp },
    });
    expect(await decide({ acceptFingerprint: X.fp })).toEqual({
      ok: true,
      via: "owner",
      change: { from: [K.fp], to: X.fp },
    });
    await expect(decide({ acceptFingerprint: "0".repeat(32) })).rejects.toThrow(
      /--accept-publisher-key names 0{32}/,
    );
  });

  test("a revoked key is refused even with the owner's matching acceptance", async () => {
    await writePublisherKeyFor(vault, "acme", K.pub);
    await revokeX();
    const d = await decide({ acceptFingerprint: X.fp });
    expect(d).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("an update starts from its own recorded key while the Vault holds it", async () => {
    await writePublisherKeyFor(vault, "acme", K.pub);
    await writePublisherKeyFor(vault, "acme", X.pub);
    // The index names X; this extension was installed with K, so X is a change for it.
    expect(await decide({ installedFingerprint: K.fp })).toMatchObject({
      ok: false,
      reason: "unvouched",
    });
    // A recorded key the Vault no longer holds falls back to every trusted key.
    expect(await decide({ installedFingerprint: "f".repeat(32) })).toMatchObject({
      ok: true,
      via: "trusted",
    });
  });
});

describe("publisherKeyConflict and keyChangeNote", () => {
  const change = { from: [K.fp], to: X.fp };
  test("a conflict names both keys and offers the override, except for a revoked key", () => {
    expect(
      publisherKeyConflict("acme", { ok: false, reason: "unvouched", change }).message,
    ).toContain(`pass --accept-publisher-key ${X.fp}`);
    expect(publisherKeyConflict("acme", { ok: false, reason: "fork", change }).message).toContain(
      "more than one key",
    );
    const revoked = publisherKeyConflict("acme", { ok: false, reason: "revoked", change }).message;
    expect(revoked).toContain("that key is revoked");
    expect(revoked).not.toContain("--accept-publisher-key");
  });
  test("the prompt sentence says what vouched for the change", () => {
    expect(keyChangeNote(change, "owner")).toBe(
      `publisher key CHANGED from ${K.fp} to ${X.fp}, not vouched for by any rotation or by Nimbus`,
    );
    expect(keyChangeNote(change, "nimbus")).toContain("vouched for by Nimbus");
    expect(keyChangeNote(change, "rotation")).toContain("signed rotation");
  });
});
