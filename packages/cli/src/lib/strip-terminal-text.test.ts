import { describe, expect, test } from "bun:test";

import { stripTerminalText } from "./strip-terminal-text.ts";

const chr = (...codes: number[]): string => String.fromCharCode(...codes);

describe("stripTerminalText", () => {
  test("drops controls and every direction control, keeps ordinary and non-Latin text", () => {
    const dirty = `a${chr(0x1b)}b${chr(0x202a, 0x202b, 0x202c, 0x202d, 0x202e)}c${chr(0x2066, 0x2067, 0x2068, 0x2069)}d${chr(0x200e, 0x200f)}e${chr(7)}`;
    expect(stripTerminalText(dirty)).toBe("abcde");
    expect(stripTerminalText("Zahlung ändern 中文 😀")).toBe("Zahlung ändern 中文 😀");
  });
});
