import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { signDeletionRecord, verifyDeletionRecord } from "./deletion-record.ts";

describe("deletion record", () => {
  test("signs and verifies a canonical {externalId, peerId, deletedCount, at}", () => {
    const kp = generateEd25519Keypair();
    const priv = encodeBase64(kp.privkey);
    const pub = encodeBase64(kp.pubkey);
    const rec = { externalId: "alice", peerId: "peer:aa", deletedCount: 4, at: 1000 };
    const sig = signDeletionRecord(rec, priv);
    expect(verifyDeletionRecord(rec, sig, pub)).toBe(true);
    expect(verifyDeletionRecord({ ...rec, deletedCount: 99 }, sig, pub)).toBe(false); // tamper
  });
  test("wrong key fails; malformed sig returns false (no throw)", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const rec = { externalId: "x", peerId: "p", deletedCount: 1, at: 1 };
    const sig = signDeletionRecord(rec, encodeBase64(a.privkey));
    expect(verifyDeletionRecord(rec, sig, encodeBase64(b.pubkey))).toBe(false);
    expect(verifyDeletionRecord(rec, "!!!", encodeBase64(a.pubkey))).toBe(false);
  });
});
