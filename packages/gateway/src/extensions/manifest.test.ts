import { describe, expect, test } from "bun:test";

import { parseExtensionManifestForRegistry, parseExtensionManifestJson } from "./manifest.ts";

describe("parseExtensionManifestJson", () => {
  test("parses minimal manifest", () => {
    const m = parseExtensionManifestJson(JSON.stringify({ id: "x", version: "1.0.0" }));
    // Missing `permissions` is normalized to default-deny by the validator.
    expect(m).toEqual({
      id: "x",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
    });
  });

  test("normalizes legacy array-form permissions to default-deny", () => {
    const m = parseExtensionManifestJson(
      JSON.stringify({ id: "x", version: "1.0.0", permissions: ["read-files", "trash"] }),
    );
    expect(m.permissions).toEqual({ network: [], filesystem: { read: [], write: [] } });
  });

  test("accepts object-form permissions with declared network hosts", () => {
    const m = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        permissions: { network: ["api.github.com"] },
      }),
    );
    expect(m.permissions.network).toEqual(["api.github.com"]);
    expect(m.permissions.filesystem).toEqual({ read: [], write: [] });
  });

  test("rejects unknown permission keys", () => {
    expect(() =>
      parseExtensionManifestJson(
        JSON.stringify({ id: "x", version: "1.0.0", permissions: { bogus: 1 } }),
      ),
    ).toThrow(/unknown permission/i);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseExtensionManifestJson("{")).toThrow(/not valid JSON/);
  });

  test("rejects non-object", () => {
    expect(() => parseExtensionManifestJson("[]")).toThrow(/JSON object/);
  });

  test("rejects missing id or version", () => {
    expect(() => parseExtensionManifestJson(JSON.stringify({ id: "" }))).toThrow(/id and version/);
  });
});

describe("parseExtensionManifestForRegistry — publisher + signature fields", () => {
  const makeJson = (extras: Record<string, unknown>) =>
    JSON.stringify({
      id: "test-ext",
      version: "1.0.0",
      permissions: {},
      ...extras,
    });

  test("accepts manifest with no publisher and no signature", () => {
    const out = parseExtensionManifestForRegistry(makeJson({}));
    expect(out.manifest.publisher).toBeUndefined();
    expect(out.manifest.signature).toBeUndefined();
  });

  test("accepts well-formed publisher + signature pair", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 44 chars
    const sig = `${"A".repeat(86)}==`; // 88 chars, base64-padded
    const out = parseExtensionManifestForRegistry(
      makeJson({ publisher: { id: "test-pub", key: pubkey }, signature: sig }),
    );
    expect(out.manifest.publisher).toEqual({ id: "test-pub", key: pubkey });
    expect(out.manifest.signature).toBe(sig);
  });

  test("rejects publisher without signature", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() =>
      parseExtensionManifestForRegistry(makeJson({ publisher: { id: "test-pub", key: pubkey } })),
    ).toThrow(/publisher and signature together, or neither/);
  });

  test("rejects signature without publisher", () => {
    const sig = `${"A".repeat(86)}==`;
    expect(() => parseExtensionManifestForRegistry(makeJson({ signature: sig }))).toThrow(
      /publisher and signature together, or neither/,
    );
  });

  test("rejects bad publisher.id format", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = `${"A".repeat(86)}==`;
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "BAD ID WITH SPACE", key: pubkey }, signature: sig }),
      ),
    ).toThrow(/publisher\.id/);
  });

  test("rejects publisher.key with wrong length", () => {
    const sig = `${"A".repeat(86)}==`;
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "test-pub", key: "too-short" }, signature: sig }),
      ),
    ).toThrow(/publisher\.key/);
  });

  test("rejects signature with wrong length", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "test-pub", key: pubkey }, signature: "too-short" }),
      ),
    ).toThrow(/signature/);
  });

  test("rejects unknown keys inside publisher", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = `${"A".repeat(86)}==`;
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({
          publisher: { id: "test-pub", key: pubkey, hint: "trust me" },
          signature: sig,
        }),
      ),
    ).toThrow(/unknown key/);
  });
});
