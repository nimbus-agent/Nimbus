import { describe, expect, test } from "bun:test";
import { writeCastBytes } from "./cast-writer.ts";

describe("writeCastBytes", () => {
  test("produces a valid v2 NDJSON header line", () => {
    const bytes = writeCastBytes([]);
    const text = new TextDecoder().decode(bytes);
    const firstLine = text.split("\n")[0];
    const header = JSON.parse(firstLine ?? "");
    expect(header).toEqual({
      version: 2,
      width: 120,
      height: 40,
      timestamp: 1700000000,
      env: { SHELL: "/bin/sh", TERM: "dumb" },
    });
  });

  test("header is byte-identical across calls (frozen timestamp)", () => {
    const a = writeCastBytes([]);
    const b = writeCastBytes([]);
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b));
  });

  test("writes one event line per chunk", () => {
    const chunks = [
      { tMs: 0, data: "hello\n" },
      { tMs: 14, data: "world\n" },
    ];
    const text = new TextDecoder().decode(writeCastBytes(chunks));
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const e1 = JSON.parse(lines[1] ?? "");
    const e2 = JSON.parse(lines[2] ?? "");
    expect(e1).toEqual([0.0, "o", "hello\n"]);
    expect(e2).toEqual([0.014, "o", "world\n"]);
  });

  test("uses seconds-with-fractional precision", () => {
    const chunks = [{ tMs: 1234, data: "x" }];
    const lines = new TextDecoder().decode(writeCastBytes(chunks)).split("\n");
    const e = JSON.parse(lines[1] ?? "");
    expect(e[0]).toBeCloseTo(1.234, 5);
  });

  test("JSON-encodes data with embedded newlines / quotes", () => {
    const chunks = [{ tMs: 0, data: 'has "quotes" and\nnewlines' }];
    const lines = new TextDecoder().decode(writeCastBytes(chunks)).split("\n");
    const e = JSON.parse(lines[1] ?? "");
    expect(e[2]).toBe('has "quotes" and\nnewlines');
  });

  test("invalid UTF-8 bytes survive via U+FFFD", () => {
    const chunks = [{ tMs: 0, data: "hi�" }];
    const lines = new TextDecoder().decode(writeCastBytes(chunks)).split("\n");
    const e = JSON.parse(lines[1] ?? "");
    expect(e[2]).toBe("hi�");
  });

  test("every line is valid JSON", () => {
    const chunks = [
      { tMs: 0, data: "a" },
      { tMs: 1, data: "b" },
    ];
    const lines = new TextDecoder()
      .decode(writeCastBytes(chunks))
      .split("\n")
      .filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
