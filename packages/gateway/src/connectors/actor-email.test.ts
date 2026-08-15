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

test("accepts multi-label local and domain parts", () => {
  expect(usableActorEmail("a.b.c@sub.example.co.uk")).toBe("a.b.c@sub.example.co.uk");
});

test("accepts exactly 254 chars (RFC 5321 ceiling)", () => {
  // Build an address that is exactly 254 chars total
  // Domain: "a.example.com" = 13 chars, @: 1 char, local: 240 chars
  // Local part respects label limits: 64 + 1 + 63 + 1 + 63 + 1 + 47 = 240
  const domain = "a.example.com";
  const localPart = `${"a".repeat(64)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(47)}`;
  const addr = `${localPart}@${domain}`;
  expect(addr).toHaveLength(254);
  expect(usableActorEmail(addr)).toBe(addr);
});

test("rejects exactly 255 chars (over RFC 5321 ceiling)", () => {
  // Build an address that is exactly 255 chars total
  // Domain: "a.example.com" = 13 chars, @: 1 char, local: 241 chars
  // Local part respects label limits: 64 + 1 + 63 + 1 + 63 + 1 + 48 = 241
  const domain = "a.example.com";
  const localPart = `${"a".repeat(64)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(48)}`;
  const addr = `${localPart}@${domain}`;
  expect(addr).toHaveLength(255);
  expect(usableActorEmail(addr)).toBeNull();
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
  ["double dot in domain", "jane@example..com"],
  ["leading dot in domain", "jane@.example.com"],
  ["double dot in domain middle", "jane@ex..ample.com"],
  ["leading dot in local part", ".jane@example.com"],
  ["trailing dot in local part", "jane.@example.com"],
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
