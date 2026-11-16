import { describe, expect, test } from "bun:test";

import {
  hasUnterminatedString,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** End-to-end through the three primitives, the way `forEachSectionEntry` uses them. */
function valueOfLine(line: string): string | undefined {
  const kv = splitKeyValue(stripComment(line).trim());
  return kv === undefined ? undefined : parseString(kv.valRaw);
}

test("a # inside a quoted value is content, not a comment", () => {
  expect(valueOfLine('sprint = "Tracks the # of open PRs each week."')).toBe(
    "Tracks the # of open PRs each week.",
  );
});

test("a # outside quotes still starts a comment", () => {
  expect(valueOfLine('a = "x" # trailing comment')).toBe("x");
});

test("a value that is only a hash survives", () => {
  expect(valueOfLine('a = "#"')).toBe("#");
});

test("a # in the key position still comments the line out", () => {
  expect(stripComment('a# = "x"')).toBe("a");
});

test("a value with no hash is unchanged", () => {
  expect(valueOfLine('a = "no hash here"')).toBe("no hash here");
});

test("an escaped quote unescapes to a bare quote", () => {
  expect(valueOfLine(String.raw`a = "The team calls it the \"waist\"."`)).toBe(
    'The team calls it the "waist".',
  );
});

test("a Windows path round-trips byte-identical", () => {
  // Regression guard for spec §3.3: this fails the moment someone "completes"
  // parseString into a full escape decoder. \n and \t must stay literal.
  const line = String.raw`piper_path = "C:\tools\new\table.onnx"`;
  expect(valueOfLine(line)).toBe(String.raw`C:\tools\new\table.onnx`);
});

test("a Windows path ending in a backslash is still accepted", () => {
  const line = String.raw`path = "C:\dev\"`;
  expect(hasUnterminatedString(line)).toBe(false);
  // Not String.raw`C:\dev\` — a raw template literal cannot end in a single
  // backslash immediately before its closing backtick (the backslash
  // escapes the backtick, so the literal never terminates). Same value,
  // spelled with an ordinary escaped string instead.
  expect(valueOfLine(line)).toBe("C:\\dev\\"); // cross-platform-ok: TOML content under test, not a filesystem path
});

test("a genuinely unterminated string is reported", () => {
  expect(hasUnterminatedString('a = "oops # x')).toBe(true);
});

test("a well-formed line is not reported as unterminated", () => {
  expect(hasUnterminatedString('a = "fine"')).toBe(false);
  expect(hasUnterminatedString(String.raw`a = "he said \"hi\""`)).toBe(false);
});

describe("parseIntDec rejects partial tokens", () => {
  // `Number.parseInt` alone reads a PREFIX, so a value carrying a suffix TOML does not have was
  // silently half-read. The inconsistency that surfaced it: once `[fleet] retention_days` refused
  // values below 1, `0days` threw a config error while `1day` was accepted as 1.
  test("a unit suffix is not a number", () => {
    expect(parseIntDec("1day")).toBeUndefined();
    expect(parseIntDec("0days")).toBeUndefined();
    expect(parseIntDec("3abc")).toBeUndefined();
  });

  test("a hex literal is not a decimal integer", () => {
    // Previously `0x10` read as 0 — the worst shape, since 0 is a meaningful value for several keys.
    expect(parseIntDec("0x10")).toBeUndefined();
  });

  test("whole decimal tokens still parse, sign and surrounding space included", () => {
    expect(parseIntDec("7")).toBe(7);
    expect(parseIntDec("  12  ")).toBe(12);
    expect(parseIntDec("-5")).toBe(-5);
    expect(parseIntDec("+5")).toBe(5);
    expect(parseIntDec("0")).toBe(0);
  });

  test("an empty or non-numeric value is still undefined", () => {
    expect(parseIntDec("")).toBeUndefined();
    expect(parseIntDec("abc")).toBeUndefined();
  });
});

describe("parseStringArray keeps a comma inside a quoted entry", () => {
  test("splits only on commas outside quotes, and an escaped quote does not end the string", () => {
    expect(parseStringArray('["checkout,prod", "pay"]')).toEqual(["checkout,prod", "pay"]);
    expect(parseStringArray('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseStringArray('["say \\"hi, you\\"", "x"]')).toEqual(['say "hi, you"', "x"]);
    expect(parseStringArray("[]")).toEqual([]);
  });

  test("a Windows path that ends in a backslash does not swallow its closing quote", () => {
    // The TOML text is ["C:\services\web\", "C:\services\worker\"]: each backslash below is doubled for JS.
    expect(parseStringArray('["C:servicesweb\\", "C:servicesworker\\"]')).toEqual([
      "C:servicesweb\\",
      "C:servicesworker\\",
    ]);
    expect(parseStringArray('["C:a\\", "x", "D:\b\\"]')).toEqual(["C:a\\", "x", "D:\b\\"]);
    expect(parseStringArray('["C:a\\"]')).toEqual(["C:a\\"]);
  });
});
