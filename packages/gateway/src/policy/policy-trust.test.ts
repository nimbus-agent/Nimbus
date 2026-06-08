import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";
import { trustAnchorPubkey } from "./policy-trust.ts";

function freshStore(): PolicyStore {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return new PolicyStore(db);
}

describe("trustAnchorPubkey", () => {
  test("validates 32-byte base64 and pins", () => {
    const store = freshStore();
    const pubkey = encodeBase64(generateEd25519Keypair().pubkey); // real 32-byte key
    trustAnchorPubkey(store, pubkey, 5);
    expect(store.getAnchorPubkey()).toBe(pubkey);
  });
  test("rejects a non-base64 / nonsense key", () => {
    expect(() => trustAnchorPubkey(freshStore(), "!!!not base64!!!", 5)).toThrow();
  });
  test("rejects a valid-base64 key of the wrong length", () => {
    expect(() => trustAnchorPubkey(freshStore(), encodeBase64(new Uint8Array(16)), 5)).toThrow();
  });
});
