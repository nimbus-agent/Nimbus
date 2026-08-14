import { expect, test } from "bun:test";
import { usableActorEmail } from "./actor-email.ts";

test("accepts a well-formed address and preserves it verbatim", () => {
  expect(usableActorEmail("Jane.Doe@Example.com")).toBe("Jane.Doe@Example.com");
});

test("trims surrounding whitespace", () => {
  expect(usableActorEmail("  jane@example.com  ")).toBe("jane@example.com");
});

// Lowercasing is deliberately NOT done here: resolvePersonForSync already
// normalises via normalizeEmail (people/linker.ts:44). A second lowercasing at
// the call site is duplicated logic that can drift out of sync with it.
test("does not lowercase — normalisation belongs to the linker", () => {
  expect(usableActorEmail("JANE@EXAMPLE.COM")).toBe("JANE@EXAMPLE.COM");
});

test.each([
  ["empty", ""],
  ["whitespace only", "   "],
  ["a placeholder word", "unknown"],
  ["n/a", "n/a"],
  ["a display name", "Jane Doe"],
  ["no domain dot", "jane@example"],
  ["no local part", "@example.com"],
  ["two at signs", "jane@@example.com"],
  ["internal whitespace", "jane doe@example.com"],
  ["over the RFC 5321 ceiling", `${"a".repeat(250)}@example.com`],
])("rejects %s", (_label, input) => {
  expect(usableActorEmail(input)).toBeNull();
});

test.each([
  ["a number", 42],
  ["null", null],
  ["undefined", undefined],
  ["an object", { email: "jane@example.com" }],
])("rejects non-string %s", (_label, input) => {
  expect(usableActorEmail(input)).toBeNull();
});
