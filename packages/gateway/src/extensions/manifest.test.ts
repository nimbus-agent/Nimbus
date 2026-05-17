import { describe, expect, test } from "bun:test";

import { parseExtensionManifestJson } from "./manifest.ts";

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
