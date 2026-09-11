import { describe, expect, it } from "bun:test";

import { decodeBase64, encodeBase64 } from "./base64.ts";

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it("encodes to standard padded base64, not base64url", () => {
    // 0xFB 0xEF produces the two characters that differ between the alphabets.
    expect(encodeBase64(new Uint8Array([0xfb, 0xef, 0xff]))).toBe("++//");
    expect(encodeBase64(new Uint8Array([1]))).toBe("AQ==");
  });

  it("encodes the empty input as the empty string", () => {
    expect(encodeBase64(new Uint8Array())).toBe("");
    expect(decodeBase64("")).toEqual(new Uint8Array());
  });

  it("decodes a 32-byte key the way the Vault stores one", () => {
    const key = new Uint8Array(32).fill(7);
    const encoded = encodeBase64(key);
    expect(encoded).toHaveLength(44);
    expect(decodeBase64(encoded)).toEqual(key);
  });
});
