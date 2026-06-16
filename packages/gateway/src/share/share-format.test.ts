import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { buildShareFile, type ShareBody, verifyShareBytes } from "./share-format.ts";

function bodyFixture(): ShareBody {
  return {
    kind: "transcript",
    sessionId: "s-1",
    createdAt: 1000,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "Asaf", pubkey: "PLACEHOLDER" },
    turns: [{ role: "user", text: "hi", timestamp: 1000 }],
  };
}

describe("share-format", () => {
  test("round-trip: a signed file verifies", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes);
    expect(r.signatureValid).toBe(true);
    expect(r.contentHashValid).toBe(true);
    expect(r.expired).toBe(false);
  });
  test("tampering with body fails the signature", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    (file.body as { sessionId: string }).sessionId = "s-tampered";
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes);
    expect(r.signatureValid && r.contentHashValid).toBe(false);
  });
  test("expiry is advisory: a genuine-but-expired share is signatureValid + expired", () => {
    const kp = generateEd25519Keypair();
    const body = {
      ...bodyFixture(),
      expiresAt: 500,
      origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) },
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes, { now: 1000 });
    expect(r.signatureValid).toBe(true);
    expect(r.expired).toBe(true);
  });
  test("valid JSON that is not a share file returns not-ok without throwing", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const r = verifyShareBytes(bytes);
    expect(r.ok).toBe(false);
    expect(r.signatureValid).toBe(false);
  });
  test("a rewritten (non-canonical) format field is NOT ok even with a valid sig+hash", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    // `format` is outside the signed body, so sig + hash stay valid — but ok must fail.
    (file as { format: string }).format = "nimbus-share/v999";
    const r = verifyShareBytes(new TextEncoder().encode(JSON.stringify(file)));
    expect(r.signatureValid).toBe(true);
    expect(r.contentHashValid).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("unexpected format"))).toBe(true);
  });
  test("a non-string contentHash fails closed (no coercion)", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    (file as { contentHash: unknown }).contentHash = 12345;
    const r = verifyShareBytes(new TextEncoder().encode(JSON.stringify(file)));
    expect(r.contentHashValid).toBe(false);
    expect(r.ok).toBe(false);
  });
});
