import { describe, expect, test } from "bun:test";

import { IPC_MAX_LINE_BYTES, NdjsonLineReader } from "./ndjson-line-reader.ts";

describe("NdjsonLineReader", () => {
  test("emits non-empty lines and skips blanks", () => {
    const r = new NdjsonLineReader();
    const lines = r.push(new TextEncoder().encode('{"a":1}\n\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("throws when a line exceeds IPC_MAX_LINE_BYTES", () => {
    const r = new NdjsonLineReader();
    const huge = `${"x".repeat(IPC_MAX_LINE_BYTES + 1)}\n`;
    expect(() => r.push(new TextEncoder().encode(huge))).toThrow("Message exceeds 1MB line limit");
  });

  test("buffers a partial line across push() calls", () => {
    const r = new NdjsonLineReader();
    const enc = new TextEncoder();
    expect(r.push(enc.encode('{"a"'))).toEqual([]);
    expect(r.push(enc.encode(":1}\n"))).toEqual(['{"a":1}']);
  });
  test("strips a trailing carriage return", () => {
    const r = new NdjsonLineReader();
    expect(r.push(new TextEncoder().encode('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });
  test("decodes multi-byte UTF-8 split across chunk boundaries", () => {
    const r = new NdjsonLineReader();
    const full = new TextEncoder().encode('"é"\n');
    const cut = 2;
    expect(r.push(full.slice(0, cut))).toEqual([]);
    expect(r.push(full.slice(cut))).toEqual(['"é"']);
  });
  test("flush() returns a pending line with no trailing newline", () => {
    const r = new NdjsonLineReader();
    r.push(new TextEncoder().encode("partial"));
    expect(r.flush()).toEqual(["partial"]);
  });
  test("flush() strips a trailing carriage return", () => {
    const r = new NdjsonLineReader();
    r.push(new TextEncoder().encode("partial\r"));
    expect(r.flush()).toEqual(["partial"]);
  });
  test("flush() returns [] when nothing is pending", () => {
    expect(new NdjsonLineReader().flush()).toEqual([]);
  });
  test("throws when the pending buffer (no newline yet) exceeds the limit", () => {
    const r = new NdjsonLineReader();
    const huge = "x".repeat(IPC_MAX_LINE_BYTES + 1);
    expect(() => r.push(new TextEncoder().encode(huge))).toThrow("Message exceeds 1MB line limit");
  });
  test("uses the custom lineLimitError constructor", () => {
    class TooBig extends Error {}
    const r = new NdjsonLineReader({ lineLimitError: TooBig });
    const huge = `${"x".repeat(IPC_MAX_LINE_BYTES + 1)}\n`;
    expect(() => r.push(new TextEncoder().encode(huge))).toThrow(TooBig);
  });
  test("flush() drains a partial multi-byte codepoint held by the decoder", () => {
    const r = new NdjsonLineReader();
    expect(r.push(new Uint8Array([0xc3]))).toEqual([]);
    expect(r.flush()).toEqual(["�"]);
  });
});
