import { expect, test } from "bun:test";

import {
  hasUnterminatedString,
  parseString,
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
