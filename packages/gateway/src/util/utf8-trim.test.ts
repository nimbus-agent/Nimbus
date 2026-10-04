import { describe, expect, test } from "bun:test";
import { trimPartialUtf8 } from "./utf8-trim.ts";

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("trimPartialUtf8", () => {
  test("an empty buffer is returned unchanged", () => {
    const buf = new Uint8Array(0);
    expect(trimPartialUtf8(buf)).toBe(buf);
  });

  test.each([
    ["ASCII", "abc"],
    ["a complete 2-byte character", "aé"],
    ["a complete 3-byte character", "a€"],
    ["a complete 4-byte character", "a😀"],
  ])("a buffer ending in %s is returned as the SAME buffer, not a copy", (_label, s) => {
    const buf = bytes(s);
    expect(trimPartialUtf8(buf)).toBe(buf);
  });

  test.each([
    ["the lead byte of a 2-byte character", "aé", 1],
    ["the first byte of a 3-byte character", "a€", 1],
    ["the first two bytes of a 3-byte character", "a€", 2],
    ["the first byte of a 4-byte character", "a😀", 1],
    ["the first two bytes of a 4-byte character", "a😀", 2],
    ["the first three bytes of a 4-byte character", "a😀", 3],
  ])("drops a trailing fragment holding only %s", (_label, s, kept) => {
    const full = bytes(s);
    // Cut so that only `kept` bytes of the last character survive, the shape an output cap makes.
    const cut = full.subarray(0, 1 + kept);
    expect(hex(trimPartialUtf8(cut))).toBe(hex(bytes("a")));
  });

  test("an emoji run cut at a 10-byte cap decodes back UNDER the cap, with no U+FFFD", () => {
    // The case the helper exists for: four emoji are 16 bytes, and a cap of 10 lands two bytes
    // into the third. Decoding the raw cut appends a U+FFFD that re-encodes to 3 bytes — 11 bytes
    // of output from a 10-byte cap.
    const cut = bytes("😀😀😀😀").subarray(0, 10);
    expect(Buffer.byteLength(new TextDecoder().decode(cut), "utf8")).toBe(11);
    const decoded = new TextDecoder().decode(trimPartialUtf8(cut));
    expect(decoded).toBe("😀😀");
    expect(decoded).not.toContain("�");
    expect(Buffer.byteLength(decoded, "utf8")).toBeLessThanOrEqual(10);
  });

  test("returns a view over the input rather than a copy when it trims", () => {
    const buf = bytes("a😀").subarray(0, 3);
    const out = trimPartialUtf8(buf);
    expect(out.buffer).toBe(buf.buffer);
    expect(out.byteLength).toBe(1);
  });

  test("stops looking after four bytes, leaving a run of bare continuation bytes alone", () => {
    // No lead byte within a UTF-8 sequence's maximum length means this is not a fragment WE cut:
    // it is invalid input, reported as-is rather than trimmed into something else.
    const buf = new Uint8Array([0x61, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(trimPartialUtf8(buf)).toBe(buf);
  });

  test("leaves a buffer made only of continuation bytes, shorter than four, alone", () => {
    const buf = new Uint8Array([0x80, 0x80]);
    expect(trimPartialUtf8(buf)).toBe(buf);
  });

  test("treats a trailing byte that can never lead a sequence as a fragment and drops it", () => {
    // 0xFF matches no 1/2/3-byte lead pattern, so it reads as a 4-byte lead with nothing after it.
    const buf = new Uint8Array([0x61, 0xff]);
    expect(hex(trimPartialUtf8(buf))).toBe("61");
  });
});
