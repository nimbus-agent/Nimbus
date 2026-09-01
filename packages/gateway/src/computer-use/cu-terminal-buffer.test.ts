import { describe, expect, test } from "bun:test";
import { MAX_TERMINAL_LINE_UNITS, TerminalLineBuffer } from "./cu-terminal-buffer.ts";

describe("TerminalLineBuffer", () => {
  test("accumulates without submitting", () => {
    const b = new TerminalLineBuffer();
    expect(b.append("ls -l")).toEqual({ status: "buffered", pending: "ls -l" });
    expect(b.append(" /tmp")).toEqual({ status: "buffered", pending: "ls -l /tmp" });
    expect(b.pending()).toBe("ls -l /tmp");
  });

  test("a submit character promotes the WHOLE accumulated line and clears the buffer", () => {
    const b = new TerminalLineBuffer();
    b.append("ls -l");
    expect(b.append(" /tmp\n")).toEqual({ status: "submit", line: "ls -l /tmp" });
    expect(b.pending()).toBe("");
  });

  test("carriage return submits too", () => {
    const b = new TerminalLineBuffer();
    expect(b.append("pwd\r")).toEqual({ status: "submit", line: "pwd" });
  });

  test("CRLF submits exactly once and leaves nothing behind", () => {
    const b = new TerminalLineBuffer();
    expect(b.append("pwd\r\n")).toEqual({ status: "submit", line: "pwd" });
    expect(b.pending()).toBe("");
  });

  // The rule the whole lane rests on: a control byte is REFUSED, never buffered. Buffering one
  // until a newline that may never arrive is a silent hang rather than a refusal.
  test.each([
    [0x03, "Ctrl-C"],
    [0x04, "Ctrl-D"],
    [0x1a, "Ctrl-Z"],
    [0x00, "NUL"],
    [0x1b, "ESC, which begins an escape sequence"],
    [0x08, "backspace"],
    [0x7f, "DEL"],
  ])("refuses U+%s (%s) rather than buffering it", (cp) => {
    const b = new TerminalLineBuffer();
    const r = b.append(String.fromCodePoint(cp));
    expect(r.status).toBe("refused");
  });

  // Refusal is WHOLESALE. A partially-applied write is a command the caller did not compose,
  // which is the same defect class as a half-parsed grant list.
  test("a refused write leaves the buffer exactly as it was", () => {
    const b = new TerminalLineBuffer();
    b.append("rm -rf /tmp/safe");
    const before = b.pending();
    expect(b.append(String.fromCodePoint(0x03)).status).toBe("refused");
    expect(b.append(`junk${String.fromCodePoint(0x1b)}[Bmore`).status).toBe("refused");
    expect(b.pending()).toBe(before);
    expect(b.append("\n")).toEqual({ status: "submit", line: "rm -rf /tmp/safe" });
  });

  test("refuses text that would push the buffer past the cap, without truncating", () => {
    const b = new TerminalLineBuffer();
    b.append("x".repeat(MAX_TERMINAL_LINE_UNITS - 1));
    const r = b.append("yy");
    expect(r.status).toBe("refused");
    expect(b.pending().length).toBe(MAX_TERMINAL_LINE_UNITS - 1);
  });

  test("a tab is ordinary text, not a control character", () => {
    const b = new TerminalLineBuffer();
    expect(b.append("echo\ta")).toEqual({ status: "buffered", pending: "echo\ta" });
  });

  test("only the FIRST line of a multi-line write submits; the rest is refused", () => {
    // Two commands in one call would mean the owner approves line 1 while line 2 is already
    // queued behind it, unseen. Refuse the whole write instead.
    const b = new TerminalLineBuffer();
    const r = b.append("echo one\necho two\n");
    expect(r.status).toBe("refused");
    expect(b.pending()).toBe("");
  });

  test("an empty submit is refused rather than sent as a bare newline", () => {
    const b = new TerminalLineBuffer();
    expect(b.append("\n").status).toBe("refused");
    expect(b.append("   \n").status).toBe("refused");
  });

  // The gap that let the ONE mutating refusal path survive review: no test covered a refusal on
  // the SUBMIT branch, only on the control-character branch. "A refusal changes nothing" has to be
  // asserted on every branch that can refuse, or it is a comment rather than a property.
  test("an empty submit leaves the buffer untouched, like every other refusal", () => {
    const b = new TerminalLineBuffer();
    b.append("   ");
    expect(b.append("\n").status).toBe("refused");
    expect(b.pending()).toBe("   ");
    // And the pending whitespace is still usable, so a refusal never strands the caller.
    expect(b.append("ls\n")).toEqual({ status: "submit", line: "   ls" });
  });

  // Trojan Source (CVE-2021-42574). On this lane the owner's approval prompt is the ENTIRE
  // boundary, so a character that changes how the line RENDERS attacks the only defense there is.
  // These are harmless to the shell, which is precisely why a control-character-only rule missed
  // them.
  test.each([
    [0x202e, "right-to-left override"],
    [0x202d, "left-to-right override"],
    [0x2066, "left-to-right isolate"],
    [0x2069, "pop directional isolate"],
    [0x200b, "zero-width space"],
    [0x200d, "zero-width joiner"],
    [0x200e, "left-to-right mark"],
    [0xfeff, "byte order mark"],
    [0x2028, "line separator"],
    [0x2029, "paragraph separator"],
  ])("refuses U+%s (%s), which the shell would ignore and the owner would misread", (cp) => {
    const b = new TerminalLineBuffer();
    b.append("echo safe");
    const r = b.append(String.fromCodePoint(cp));
    expect(r.status).toBe("refused");
    expect(b.pending()).toBe("echo safe");
  });

  test("a right-to-left override cannot reach the shell inside an approved line", () => {
    // The concrete attack: a line that displays as one command and runs as another.
    const b = new TerminalLineBuffer();
    const r = b.append(`echo hi ${String.fromCodePoint(0x202e)} fr- mr\n`);
    expect(r.status).toBe("refused");
  });

  test("ordinary right-to-left TEXT is still allowed — only the format controls are refused", () => {
    // Refusing Arabic or Hebrew letters would be a bug, not a defense: they are strong-RTL
    // characters, not overrides, and they cannot reorder anything around them.
    const b = new TerminalLineBuffer();
    expect(b.append("echo مرحبا").status).toBe("buffered");
  });

  test("an astral character (emoji) is ordinary text", () => {
    // Iterating code points rather than UTF-16 units means a surrogate pair is examined once. This
    // pins that: neither half of an astral character may be mistaken for something in a range.
    const b = new TerminalLineBuffer();
    expect(b.append("echo \u{1F600}").status).toBe("buffered");
  });
});
