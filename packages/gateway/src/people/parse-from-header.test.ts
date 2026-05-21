import { expect, test } from "bun:test";

import { parseFromHeaderForPerson } from "./parse-from-header.ts";

test("parseFromHeaderForPerson: named angle address", () => {
  const r = parseFromHeaderForPerson(`Jane Doe <Jane.Doe@Example.COM>`);
  expect(r.email).toBe("jane.doe@example.com");
  expect(r.displayName).toBe("Jane Doe");
});

test("parseFromHeaderForPerson: bare email", () => {
  const r = parseFromHeaderForPerson("a@b.co");
  expect(r.email).toBe("a@b.co");
  expect(r.displayName).toBe("a@b.co");
});

test("parseFromHeaderForPerson: empty", () => {
  expect(parseFromHeaderForPerson(null)).toEqual({});
  expect(parseFromHeaderForPerson("   ")).toEqual({});
});

test("parseFromHeaderForPerson: malformed quoted name (unbalanced quote)", () => {
  // Display-name has an unbalanced double quote. The named-angle path strips
  // leading/trailing quote characters from the display name; the unbalanced
  // quote drops only the matching side, leaving the rest intact.
  const r = parseFromHeaderForPerson(`"Jane Doe <jane.doe@example.com>`);
  expect(r.email).toBe("jane.doe@example.com");
  // The opening `"` is stripped by the leading-quote replace; "Jane Doe" remains.
  expect(r.displayName).toBe("Jane Doe");
});

test("parseFromHeaderForPerson: multiple comma-separated addresses (last named pair wins)", () => {
  // RFC-style address list: the named-angle parser scans from the trailing
  // `>` back to the nearest `<`, so for an address list the LAST mailbox is
  // what gets returned (the display name spans all preceding text). This
  // documents the current behavior so a future change is intentional.
  const r = parseFromHeaderForPerson(
    "First Person <first@example.com>, Second Person <second@example.com>",
  );
  expect(r.email).toBe("second@example.com");
});

test("parseFromHeaderForPerson: angle-bracket-only (no display name)", () => {
  // No leading display name → tryParseNamedAngleMailbox returns null →
  // extractFirstAngleBracketEmail kicks in, returning email-only (no
  // displayName field set).
  const r = parseFromHeaderForPerson("<addr@host.com>");
  expect(r.email).toBe("addr@host.com");
  expect(r.displayName).toBeUndefined();
});
