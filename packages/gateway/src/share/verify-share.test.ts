import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { serializeShareFileToYaml } from "./recipe-yaml.ts";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { appendForwardingHop } from "./share-forwarding.ts";
import {
  loadShareBytes,
  parseShareFile,
  verifyShareFromBytes,
  verifyShareFromInput,
} from "./verify-share.ts";

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

  test("a malformed origin shape is not attached to the report", () => {
    for (const badOrigin of ["a string", { label: 123, pubkey: "x" }, { label: "x" }, null]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ body: { origin: badOrigin } }));
      expect(verifyShareFromBytes(bytes).origin).toBeUndefined();
    }
  });

  test("input that is neither JSON nor YAML falls through to the base not-ok report", () => {
    // `{ unterminated` is invalid JSON (parse throws) AND an unterminated YAML flow mapping
    // (yamlParse throws) — so toJsonShareBytes returns the bytes unchanged, verifyShareBytes
    // reports malformed json, and the inner origin/forwarding JSON.parse throws → outer catch
    // returns `base`.
    const bytes = new TextEncoder().encode("{ unterminated");
    const r = verifyShareFromBytes(bytes);
    expect(r.ok).toBe(false);
    expect(r.origin).toBeUndefined();
    expect(r.forwarding).toBeUndefined();
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

  test("verify surfaces an advisory forwarding result without affecting content validity", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript",
      sessionId: "s-fwd",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "alice", pubkey: encodeBase64(kp.pubkey) },
      turns: [],
    };
    const signed = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bobKp = generateEd25519Keypair();
    const fwd = appendForwardingHop(signed, {
      gatewayLabel: "bob",
      pubkeyB64: encodeBase64(bobKp.pubkey),
      privkeyB64: encodeBase64(bobKp.privkey),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(fwd));
    const r = verifyShareFromBytes(bytes);
    expect(r.signatureValid).toBe(true);
    expect(r.forwarding?.hops).toBe(1);
    expect(r.forwarding?.chainValid).toBe(true);
    expect(r.forwarding?.hopsValid).toBe(1);
  });

  test("a tampered hop → chainValid false but content still verifies", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript",
      sessionId: "s-tamper",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "alice", pubkey: encodeBase64(kp.pubkey) },
      turns: [],
    };
    const signed = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bobKp = generateEd25519Keypair();
    const fwd = appendForwardingHop(signed, {
      gatewayLabel: "bob",
      pubkeyB64: encodeBase64(bobKp.pubkey),
      privkeyB64: encodeBase64(bobKp.privkey),
    });
    // Tamper the hop's gatewayLabel — the hop sig no longer matches
    const tampered = {
      ...fwd,
      forwarding: {
        hops: 1,
        chain: [{ ...fwd.forwarding.chain[0], gatewayLabel: "mallory" }],
      },
    };
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(tampered)));
    expect(r.signatureValid).toBe(true); // inner content is untouched
    expect(r.ok).toBe(true);
    expect(r.forwarding?.chainValid).toBe(false);
    expect(r.forwarding?.hopsValid).toBe(0);
  });
});

function signedRecipeShare() {
  const kp = generateEd25519Keypair();
  const body: ShareBody = {
    kind: "recipe",
    sessionId: "recipe-session-1",
    createdAt: 1_000_000,
    expiresAt: null,
    redactionSet: [],
    origin: { label: "RecipeOrigin", pubkey: encodeBase64(kp.pubkey) },
    recipe: { steps: ["step1", "step2"] },
  };
  return buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
}

describe("verifyShareFromBytes — YAML input", () => {
  test("verifies a YAML-serialized recipe share", () => {
    const share = signedRecipeShare();
    const yamlBytes = new TextEncoder().encode(serializeShareFileToYaml(share));
    const result = verifyShareFromBytes(yamlBytes, { now: share.body.createdAt + 1 });
    expect(result.ok).toBe(true);
    expect(result.signatureValid).toBe(true);
  });

  test("a tampered YAML share fails verification", () => {
    const share = signedRecipeShare();
    const tampered = serializeShareFileToYaml(share).replace(share.body.sessionId, "evil-session");
    const result = verifyShareFromBytes(new TextEncoder().encode(tampered), {
      now: share.body.createdAt + 1,
    });
    expect(result.ok).toBe(false);
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

describe("parseShareFile", () => {
  test("parseShareFile parses a JSON share", () => {
    const share = signedRecipeShare();
    const bytes = new TextEncoder().encode(JSON.stringify(share));
    expect(parseShareFile(bytes)?.body.sessionId).toBe(share.body.sessionId);
  });

  test("parseShareFile parses a YAML share (recipe variant)", () => {
    const share = signedRecipeShare();
    const bytes = new TextEncoder().encode(serializeShareFileToYaml(share));
    expect(parseShareFile(bytes)?.body.sessionId).toBe(share.body.sessionId);
  });

  test("parseShareFile returns null for non-share input", () => {
    expect(parseShareFile(new TextEncoder().encode("not a share"))).toBeNull();
    expect(parseShareFile(new TextEncoder().encode(JSON.stringify({ hi: 1 })))).toBeNull();
  });

  test("parseShareFile returns null when the bytes parse as neither JSON nor YAML", () => {
    // `{ unterminated` throws in both JSON.parse and yamlParse, so toJsonShareBytes returns the
    // raw bytes and parseShareFile's JSON.parse throws → the catch returns null.
    expect(parseShareFile(new TextEncoder().encode("{ unterminated"))).toBeNull();
  });

  test("parseShareFile returns null when sig is null (typeof null === 'object' trap)", () => {
    const withNullSig = { body: { kind: "recipe", sessionId: "s" }, sig: null };
    expect(parseShareFile(new TextEncoder().encode(JSON.stringify(withNullSig)))).toBeNull();
  });

  test("parseShareFile returns null when format or forwarding is missing", () => {
    const withoutFormat = {
      body: { kind: "recipe", sessionId: "s" },
      sig: { alg: "ed25519", pubkey: "P", signature: "S" },
      contentHash: "abc",
      forwarding: { hops: 0, chain: [] },
      // no format field
    };
    expect(parseShareFile(new TextEncoder().encode(JSON.stringify(withoutFormat)))).toBeNull();

    const withoutForwarding = {
      format: "nimbus-share/v1",
      body: { kind: "recipe", sessionId: "s" },
      sig: { alg: "ed25519", pubkey: "P", signature: "S" },
      contentHash: "abc",
      // no forwarding field
    };
    expect(parseShareFile(new TextEncoder().encode(JSON.stringify(withoutForwarding)))).toBeNull();
  });
});

describe("loadShareBytes", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "load-share-bytes-"));
  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("loadShareBytes reads a local file", async () => {
    const share = signedRecipeShare();
    const path = join(tmpDir, `share-${share.contentHash}.json`);
    writeFileSync(path, JSON.stringify(share));
    const bytes = await loadShareBytes(path);
    expect(parseShareFile(bytes)?.contentHash).toBe(share.contentHash);
  });

  test("loadShareBytes fetches an http(s) input via the injected SSRF-safe fetch seam", async () => {
    const share = signedRecipeShare();
    const json = JSON.stringify(share);
    let requested: string | undefined;
    const bytes = await loadShareBytes("https://example.com/share.json", {
      safeFetchFn: (async (input: string) => {
        requested = input;
        return new Response(json);
      }) as never,
    });
    expect(requested).toBe("https://example.com/share.json");
    expect(parseShareFile(bytes)?.contentHash).toBe(share.contentHash);
  });
});
