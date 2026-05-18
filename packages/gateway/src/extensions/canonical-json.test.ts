import { describe, expect, it } from "bun:test";

import {
  canonicalize,
  canonicalizeManifest,
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "./canonical-json.ts";

describe("canonicalize", () => {
  it("serializes primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe(`"hello"`);
  });

  it("sorts object keys by Unicode codepoint", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe(`{"a":2,"b":1,"c":3}`);
  });

  it("is invariant under input key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe(`[3,1,2]`);
  });

  it("normalizes string VALUES to NFC", () => {
    // "café" composed (precomposed é, U+00E9) vs decomposed (e + U+0301)
    const composed = "café";
    const decomposed = "café";
    expect(canonicalize(composed)).toBe(canonicalize(decomposed));
  });

  it("does NOT normalize object KEYS", () => {
    // Keys are signed byte-for-byte; we never rewrite them.
    const composedKey = "café";
    const decomposedKey = "café";
    const composed = { [composedKey]: 1 };
    const decomposed = { [decomposedKey]: 1 };
    expect(canonicalize(composed)).not.toBe(canonicalize(decomposed));
  });

  it("rejects non-integer numbers", () => {
    expect(() => canonicalize(1.5)).toThrow(NonIntegerNumberInManifest);
    expect(() => canonicalize(Number.NaN)).toThrow(NonIntegerNumberInManifest);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(NonIntegerNumberInManifest);
  });

  it("rejects unsupported types", () => {
    expect(() => canonicalize(undefined as unknown)).toThrow(UnsupportedManifestValueType);
    expect(() => canonicalize(() => 0 as unknown)).toThrow(UnsupportedManifestValueType);
  });

  it("caps recursion at MAX_DEPTH = 32", () => {
    const buildNested = (n: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(canonicalize(buildNested(32))).toContain("[");
    expect(() => canonicalize(buildNested(33))).toThrow(ManifestNestedTooDeep);
  });

  it("is idempotent: parse(canonicalize(parse(canonicalize(x)))) === canonicalize(x)", () => {
    const x = { z: 1, a: [2, { c: 3, b: 4 }], m: "hi" };
    const round1 = canonicalize(x);
    const round2 = canonicalize(JSON.parse(round1));
    expect(round2).toBe(round1);
  });
});

describe("canonicalizeManifest", () => {
  it("strips the top-level signature field", () => {
    const m = {
      id: "test",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "p", key: "AAA" },
      signature: "anything-here",
    };
    const withSig = canonicalizeManifest(m);
    const withoutSig = canonicalizeManifest({ ...m, signature: "different" });
    expect(new TextDecoder().decode(withSig)).toBe(new TextDecoder().decode(withoutSig));
  });

  it("returns UTF-8 bytes", () => {
    const out = canonicalizeManifest({
      id: "test",
      version: "1.0.0",
      permissions: {},
    } as never);
    expect(out).toBeInstanceOf(Uint8Array);
  });
});
