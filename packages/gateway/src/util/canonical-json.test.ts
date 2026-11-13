import { describe, expect, test } from "bun:test";

import { byCodeUnit, canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  test("sorts object keys by code unit at every depth, with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("keeps array order and drops undefined members", () => {
    expect(canonicalJson([2, 1, undefined])).toBe("[2,1,null]");
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  test("does not normalise Unicode (NFC and NFD differ)", () => {
    const nfc = String.fromCodePoint(0xe9);
    const nfd = `e${String.fromCodePoint(0x301)}`;
    expect(canonicalJson({ k: nfc })).not.toBe(canonicalJson({ k: nfd }));
  });

  test("handles scalars and a non-integer number", () => {
    expect(canonicalJson(0.5)).toBe("0.5");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("byCodeUnit", () => {
  test("orders by UTF-16 code unit, not locale", () => {
    expect(["b", "B", "a"].sort(byCodeUnit)).toEqual(["B", "a", "b"]);
    expect(byCodeUnit("a", "a")).toBe(0);
  });
});
