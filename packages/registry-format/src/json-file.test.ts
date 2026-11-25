import { describe, expect, test } from "bun:test";
import { RegistryError } from "./errors.ts";
import { decodeJsonFile } from "./json-file.ts";

const invalid = (detail: string): RegistryError =>
  new RegistryError("ERR_TRUST_FEED_INVALID", detail);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function codeAndMessage(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a RegistryError");
}

describe("decodeJsonFile", () => {
  test("parses a JSON value", () => {
    expect(decodeJsonFile(enc('{"a":1}'), "x.json", 100, invalid)).toEqual({ a: 1 });
  });

  test("drops one leading byte-order mark", () => {
    const bom = String.fromCodePoint(0xfeff);
    expect(decodeJsonFile(enc(`${bom}[1]`), "x.json", 100, invalid)).toEqual([1]);
  });

  test("refuses a file past its cap with ERR_REGISTRY_TOO_LARGE", () => {
    const r = codeAndMessage(() => decodeJsonFile(enc("[1,2,3]"), "x.json", 3, invalid));
    expect(r.code).toBe("ERR_REGISTRY_TOO_LARGE");
    expect(r.message).toContain("x.json exceeds 3 bytes");
  });

  test("accepts a file exactly at its cap", () => {
    expect(decodeJsonFile(enc("[1]"), "x.json", 3, invalid)).toEqual([1]);
  });

  test("refuses invalid UTF-8 with the caller's error", () => {
    const r = codeAndMessage(() =>
      decodeJsonFile(new Uint8Array([0x7b, 0xff, 0x7d]), "x.json", 100, invalid),
    );
    expect(r.code).toBe("ERR_TRUST_FEED_INVALID");
    expect(r.message).toContain("x.json is not valid UTF-8");
  });

  test("refuses invalid JSON with the caller's error", () => {
    const r = codeAndMessage(() => decodeJsonFile(enc("{nope"), "x.json", 100, invalid));
    expect(r.code).toBe("ERR_TRUST_FEED_INVALID");
    expect(r.message).toContain("x.json is not valid JSON");
  });
});
