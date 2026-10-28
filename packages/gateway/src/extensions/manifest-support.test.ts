import { describe, expect, test } from "bun:test";

import { RegistryError } from "@nimbus-dev/registry-format";

import { assertManifestSupported, dependencyRanges } from "./manifest-support.ts";

function refusal(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error("expected a RegistryError");
}

describe("dependencyRanges", () => {
  test("string-only manifest installs unchanged", () => {
    expect(dependencyRanges({ a: { range: "^1" } })).toEqual({ a: "^1" });
    expect(dependencyRanges(undefined)).toEqual({});
  });

  test("dependencyRanges refuses a cross-registry entry too", () => {
    const e = refusal(() =>
      dependencyRanges({ a: { range: "^1" }, b: { range: "1.x", registry: "nimbus-official" } }),
    );
    expect(e.code).toBe("ERR_EXTENSION_MANIFEST_UNSUPPORTED");
  });
});

describe("assertManifestSupported", () => {
  test("an extension with same-registry dependencies is supported", () => {
    expect(() =>
      assertManifestSupported({ id: "x", kind: "extension", dependsOn: { a: { range: "^1" } } }),
    ).not.toThrow();
    expect(() => assertManifestSupported({ id: "x" })).not.toThrow();
  });

  test("cross-registry dependency refused", () => {
    const e = refusal(() =>
      assertManifestSupported({
        id: "x",
        kind: "extension",
        dependsOn: { b: { range: "1.x", registry: "nimbus-official" } },
      }),
    );
    expect(e.code).toBe("ERR_EXTENSION_MANIFEST_UNSUPPORTED");
    expect(e.message).toMatch(
      /x depends on b from another registry; this Nimbus version cannot install cross-registry dependencies yet/,
    );
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
