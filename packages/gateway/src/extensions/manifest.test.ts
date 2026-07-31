import { describe, expect, test } from "bun:test";

import { parseExtensionManifestForRegistry, parseExtensionManifestJson } from "./manifest.ts";

describe("parseExtensionManifestJson", () => {
  test("parses minimal manifest", () => {
    const m = parseExtensionManifestJson(JSON.stringify({ id: "x", version: "1.0.0" }));
    expect(m).toEqual({
      id: "x",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable",
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
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = `${"A".repeat(86)}==`;
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

describe("parseExtensionManifestJson — updateChannel + changelog (T2 PR 3)", () => {
  const minimalWithExtras = (extras: Record<string, unknown>) =>
    JSON.stringify({
      id: "com.example.x",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      ...extras,
    });

  test("parses updateChannel = 'beta'", () => {
    const m = parseExtensionManifestJson(minimalWithExtras({ updateChannel: "beta" }));
    expect(m.updateChannel).toBe("beta");
  });

  test("defaults updateChannel to 'stable' when absent", () => {
    const m = parseExtensionManifestJson(minimalWithExtras({}));
    expect(m.updateChannel).toBe("stable");
  });

  test("rejects updateChannel = 'unstable'", () => {
    expect(() =>
      parseExtensionManifestJson(minimalWithExtras({ updateChannel: "unstable" })),
    ).toThrow(/updateChannel must be/i);
  });

  test("parses changelog string", () => {
    const m = parseExtensionManifestJson(minimalWithExtras({ changelog: "Fixed bug X." }));
    expect(m.changelog).toBe("Fixed bug X.");
  });

  test("normalizes changelog to NFC", () => {
    // Build the two Unicode forms explicitly so the inequality is a real
    // runtime check (not two source literals an analyzer treats as identical).
    const decomposed = "café".normalize("NFD"); // e + combining acute accent
    const composed = "café".normalize("NFC"); // precomposed e-acute
    expect(decomposed).not.toBe(composed);
    const m = parseExtensionManifestJson(minimalWithExtras({ changelog: decomposed }));
    expect(m.changelog).toBe(composed);
  });

  test("rejects changelog > 4 KiB after NFC normalization", () => {
    const big = "x".repeat(4097);
    expect(() => parseExtensionManifestJson(minimalWithExtras({ changelog: big }))).toThrow(
      /changelog/i,
    );
  });

  test("rejects non-string changelog", () => {
    expect(() => parseExtensionManifestJson(minimalWithExtras({ changelog: 42 }))).toThrow(
      /changelog must be a string/i,
    );
  });
});

describe("parseExtensionManifestForRegistry — entry / entrypoint fallback (Task 9)", () => {
  test("accepts entrypoint as a fallback when entry is absent", () => {
    const m = parseExtensionManifestJson(
      JSON.stringify({ id: "x", version: "1.0.0", entrypoint: "dist/server.js" }),
    );
    expect(m.entry).toBe("dist/server.js");
  });

  test("prefers entry when both entry and entrypoint are present", () => {
    const m = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        entry: "dist/from-entry.js",
        entrypoint: "dist/from-entrypoint.js",
      }),
    );
    expect(m.entry).toBe("dist/from-entry.js");
  });

  test("leaves entry undefined when neither entry nor entrypoint is present", () => {
    const m = parseExtensionManifestJson(JSON.stringify({ id: "x", version: "1.0.0" }));
    expect(m.entry).toBeUndefined();
  });
});

describe("parseExtensionManifestJson — dependsOn (T2 PR 4)", () => {
  test("accepts manifest with valid dependsOn ranges", () => {
    const m = parseExtensionManifestJson(
      JSON.stringify({ id: "x", version: "1.0.0", dependsOn: { "com.shared.utils": "^1.0.0" } }),
    );
    expect(m.dependsOn?.["com.shared.utils"]).toBe("^1.0.0");
  });

  test("accepts manifest without dependsOn (legacy + zero-dep extensions)", () => {
    const m = parseExtensionManifestJson(JSON.stringify({ id: "x", version: "1.0.0" }));
    expect(m.dependsOn).toBeUndefined();
  });

  test("rejects manifest with invalid semver range in dependsOn", () => {
    expect(() =>
      parseExtensionManifestJson(
        JSON.stringify({
          id: "x",
          version: "1.0.0",
          dependsOn: { "com.shared.utils": "not-a-range" },
        }),
      ),
    ).toThrow(/semver/);
  });
});
