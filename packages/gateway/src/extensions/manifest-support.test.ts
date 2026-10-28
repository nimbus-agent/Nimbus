import { describe, expect, test } from "bun:test";

import { RegistryError } from "@nimbus-dev/registry-format";

import { assertManifestSupported, rangesOf } from "./manifest-support.ts";

function refusal(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error("expected a RegistryError");
}

describe("rangesOf", () => {
  test("rangesOf returns every range", () => {
    expect(
      rangesOf({ a: { range: "^1" }, b: { range: "1.x", registry: "nimbus-official" } }),
    ).toEqual({ a: "^1", b: "1.x" });
    expect(rangesOf(undefined)).toEqual({});
  });
});

describe("assertManifestSupported", () => {
  test("an extension with same-registry dependencies is supported", () => {
    expect(() =>
      assertManifestSupported({ id: "x", kind: "extension", dependsOn: { a: { range: "^1" } } }),
    ).not.toThrow();
    expect(() => assertManifestSupported({ id: "x" })).not.toThrow();
  });

  test("cross-registry dependency is supported", () => {
    expect(() =>
      assertManifestSupported({
        id: "x",
        kind: "extension",
        dependsOn: { b: { range: "1.x", registry: "nimbus-official" } },
      }),
    ).not.toThrow();
  });

  test("starter pack refused", () => {
    const e = refusal(() =>
      assertManifestSupported({ id: "x", kind: "starter-pack", dependsOn: { a: { range: "^1" } } }),
    );
    expect(e.code).toBe("ERR_EXTENSION_MANIFEST_UNSUPPORTED");
    expect(e.message).toMatch(
      /x is a starter pack; this Nimbus version cannot install starter packs yet/,
    );
  });
});
