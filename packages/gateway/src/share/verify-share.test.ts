import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { verifyShareFromBytes, verifyShareFromInput } from "./verify-share.ts";

function genuineShareJson(): string {
  const kp = generateEd25519Keypair();
  const body: ShareBody = {
    kind: "transcript",
    sessionId: "s",
    createdAt: 1,
    expiresAt: null,
    redactionSet: [],
    origin: { label: "Z", pubkey: encodeBase64(kp.pubkey) },
    turns: [],
  };
  const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
  return JSON.stringify(file);
}

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

describe("verifyShareFromInput", () => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-share-input-"));
  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("verifies a genuine share read from a local file path", async () => {
    const path = join(tmp, "share.json");
    writeFileSync(path, genuineShareJson());
    const r = await verifyShareFromInput(path);
    expect(r.ok).toBe(true);
    expect(r.origin?.label).toBe("Z");
  });

  test("verifies an http(s) share via the injected SSRF-safe fetch seam", async () => {
    const json = genuineShareJson();
    let requested: string | undefined;
    const r = await verifyShareFromInput("https://example.com/share.json", undefined, {
      safeFetchFn: (async (input: string) => {
        requested = input;
        return new Response(json);
      }) as never,
    });
    expect(requested).toBe("https://example.com/share.json");
    expect(r.ok).toBe(true);
    expect(r.origin?.label).toBe("Z");
  });
});
