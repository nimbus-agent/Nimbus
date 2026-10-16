import { describe, expect, it } from "vitest";
import { showInvisible } from "../../src/lib/escape-invisible";

// Built from code points, never typed: an invisible character in a test is one a reviewer cannot see.
const cp = (n: number): string => String.fromCodePoint(n);

describe("showInvisible", () => {
  it("leaves ordinary text, tabs and newlines alone", () => {
    expect(showInvisible("a\tb\nc — ü 日本")).toBe("a\tb\nc — ü 日本");
  });

  it("escapes the bidi overrides and zero-width characters (CVE-2021-42574)", () => {
    expect(showInvisible(`x${cp(0x202e)}y${cp(0x200b)}z`)).toBe("x\\u{202E}y\\u{200B}z");
    for (const n of [0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d]) {
      expect(showInvisible(cp(n))).toBe(`\\u{${n.toString(16).toUpperCase()}}`);
    }
  });

  it("escapes the isolates, word joiner, line/paragraph separators and the BOM", () => {
    for (const n of [0x2060, 0x2066, 0x2069, 0x2028, 0x2029, 0xfeff]) {
      expect(showInvisible(cp(n))).toBe(`\\u{${n.toString(16).toUpperCase()}}`);
    }
  });

  it("escapes C0 controls except tab and LF, plus DEL and C1, zero-padded to four digits", () => {
    expect(showInvisible("\u0000\u0007\r\u001b")).toBe("\\u{0000}\\u{0007}\\u{000D}\\u{001B}");
    expect(showInvisible(`${cp(0x7f)}${cp(0x85)}${cp(0x9f)}`)).toBe("\\u{007F}\\u{0085}\\u{009F}");
  });

  it("covers the gateway table's other entries, including astral TAG characters", () => {
    expect(showInvisible(cp(0x00ad))).toBe("\\u{00AD}");
    expect(showInvisible(cp(0xfe0f))).toBe("\\u{FE0F}");
    expect(showInvisible(cp(0xe0041))).toBe("\\u{E0041}");
    expect(showInvisible(cp(0xe0100))).toBe("\\u{E0100}");
  });

  it("does not escape U+202F, which renders as a space", () => {
    expect(showInvisible(cp(0x202f))).toBe(cp(0x202f));
  });
});
