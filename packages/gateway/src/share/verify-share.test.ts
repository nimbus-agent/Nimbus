import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { verifyShareFromBytes } from "./verify-share.ts";

describe("verifyShareFromBytes", () => {
  test("reports per-check results for a genuine share", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript",
      sessionId: "s",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "A", pubkey: encodeBase64(kp.pubkey) },
      turns: [],
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(file)));
    expect(r.ok).toBe(true);
    expect(r.signatureValid).toBe(true);
    expect(r.contentHashValid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.origin?.label).toBe("A");
    expect(r.origin?.pubkey).toBe(encodeBase64(kp.pubkey));
  });

  test("malformed input reports not-ok without throwing", () => {
    const r = verifyShareFromBytes(new TextEncoder().encode("not json"));
    expect(r.ok).toBe(false);
    expect(r.origin).toBeUndefined();
  });

  test("valid JSON that is not a share file reports not-ok and carries no origin", () => {
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify({ hello: "world" })));
    expect(r.ok).toBe(false);
    expect(r.origin).toBeUndefined();
  });

  test("a tampered body fails verification but still surfaces origin", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript",
      sessionId: "s",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "B", pubkey: encodeBase64(kp.pubkey) },
      turns: [],
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const tampered = {
      ...file,
      body: { ...file.body, sessionId: "tampered" },
    };
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(tampered)));
    expect(r.ok).toBe(false);
    expect(r.contentHashValid).toBe(false);
    expect(r.origin?.label).toBe("B");
  });

  test("an expired share is flagged via the now option", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript",
      sessionId: "s",
      createdAt: 1,
      expiresAt: 100,
      redactionSet: [],
      origin: { label: "C", pubkey: encodeBase64(kp.pubkey) },
      turns: [],
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(file)), { now: 200 });
    expect(r.ok).toBe(true);
    expect(r.expired).toBe(true);
  });
});
