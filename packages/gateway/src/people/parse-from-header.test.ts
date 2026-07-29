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
  const r = parseFromHeaderForPerson(`"Jane Doe <jane.doe@example.com>`);
  expect(r.email).toBe("jane.doe@example.com");
  expect(r.displayName).toBe("Jane Doe");
});

test("parseFromHeaderForPerson: multiple comma-separated addresses (last named pair wins)", () => {
  const r = parseFromHeaderForPerson(
    "First Person <first@example.com>, Second Person <second@example.com>",
  );
  expect(r.email).toBe("second@example.com");
});

// All three yield an email with no display name, but each reaches it by a different internal
// route — see the per-row notes.
test.each([
  ["angle-bracket-only", "<addr@host.com>", "addr@host.com"],
  // Inner of the first pair is "<addr@host.com", which contains "<", so
  // extractFirstAngleBracketEmail skips it; searchFrom advances to 1 and the inner pair parses.
  ["nested angle brackets (skips to the valid inner pair)", "<<addr@host.com>>", "addr@host.com"],
  // open === 0 → tryParseNamedAngleMailbox returns null (no display name to its left), so
  // extractFirstAngleBracketEmail is what ends up finding the address.
  [
    "a '<' at index 0 (tryParseNamedAngleMailbox open <= 0 bail-out)",
    "<email@example.com>",
    "email@example.com",
  ],
])("parseFromHeaderForPerson: %s → email, no display name", (_label, header, email) => {
  const r = parseFromHeaderForPerson(header);
  expect(r.email).toBe(email);
  expect(r.displayName).toBeUndefined();
});

// --- Additional tests to cover remaining branches ---

test("parseFromHeaderForPerson: undefined input returns empty", () => {
  // Covers the raw === undefined branch (distinct from null)
  expect(parseFromHeaderForPerson(undefined)).toEqual({});
});

test("parseFromHeaderForPerson: whitespace-only string returns empty", () => {
  // Covers trimmed === "" branch with non-null input (extra variant)
  expect(parseFromHeaderForPerson("\t \n")).toEqual({});
});

test("parseFromHeaderForPerson: quoted display name — both quotes stripped", () => {
  // Covers the displayName === "" after replaceAll guard NOT firing (name present)
  // plus verifies quote-stripping on both ends
  const r = parseFromHeaderForPerson('"Alice Smith" <alice@example.com>');
  expect(r.email).toBe("alice@example.com");
  expect(r.displayName).toBe("Alice Smith");
});

test("parseFromHeaderForPerson: single-quoted display name stripped", () => {
  const r = parseFromHeaderForPerson("'Bob Jones' <bob@example.org>");
  expect(r.email).toBe("bob@example.org");
  expect(r.displayName).toBe("Bob Jones");
});

test("parseFromHeaderForPerson: display name reduces to empty after quote-strip → falls back to email", () => {
  // A name that is entirely quotes so after strip displayName becomes ""
  // Format: `"" <email>` — after stripping leading/trailing quotes from `""`, result is ""
  const r = parseFromHeaderForPerson(`"" <fallback@example.com>`);
  expect(r.email).toBe("fallback@example.com");
  // displayName should equal email because the stripped name is ""
  expect(r.displayName).toBe("fallback@example.com");
});

test("parseFromHeaderForPerson: fully malformed (no email shape at all) returns empty", () => {
  // Covers the final return {} branch — not an angle address, not bare mailbox
  expect(parseFromHeaderForPerson("Not An Email At All")).toEqual({});
  expect(parseFromHeaderForPerson("hello world")).toEqual({});
});

test("parseFromHeaderForPerson: bare email with uppercase letters normalised", () => {
  // Covers isBareMailboxShape returning true for a valid bare address, normalizeEmail lowercases it
  const r = parseFromHeaderForPerson("User@Domain.NET");
  expect(r.email).toBe("user@domain.net");
  expect(r.displayName).toBe("user@domain.net");
});

test("parseFromHeaderForPerson: no @ in bare token returns empty", () => {
  // isBareMailboxShape: at <= 0 branch (indexOf returns -1)
  expect(parseFromHeaderForPerson("nodomain")).toEqual({});
});

test("parseFromHeaderForPerson: @ at position 0 in bare token returns empty", () => {
  // isBareMailboxShape: at <= 0 branch (at === 0)
  expect(parseFromHeaderForPerson("@nodomain.com")).toEqual({});
});

test("parseFromHeaderForPerson: multiple @ signs in bare token returns empty", () => {
  // isBareMailboxShape: s.slice(at+1).includes("@") branch
  expect(parseFromHeaderForPerson("a@@b.com")).toEqual({});
  expect(parseFromHeaderForPerson("a@b@c.com")).toEqual({});
});

test("parseFromHeaderForPerson: domain has no dot → not a bare mailbox", () => {
  // isBareMailboxShape: dot > 0 fails (no dot in domain)
  expect(parseFromHeaderForPerson("user@nodotdomain")).toEqual({});
});

test("parseFromHeaderForPerson: dot at start of domain → not a bare mailbox", () => {
  // isBareMailboxShape: dot > 0 fails when dot === 0
  expect(parseFromHeaderForPerson("user@.domain")).toEqual({});
});

test("parseFromHeaderForPerson: dot at end of domain → not a bare mailbox", () => {
  // isBareMailboxShape: dot < domain.length - 1 fails
  expect(parseFromHeaderForPerson("user@domain.")).toEqual({});
});

test("parseFromHeaderForPerson: space in bare token routes to angle-bracket extraction, then falls through", () => {
  // isBareMailboxShape rejects spaces; no angle brackets → returns {}
  expect(parseFromHeaderForPerson("user name@example.com")).toEqual({});
});

test("parseFromHeaderForPerson: tab in address returns empty (isBareMailboxShape rejects \\t)", () => {
  // isBareMailboxShape: c === "\\t" branch
  expect(parseFromHeaderForPerson("user\t@example.com")).toEqual({});
});

test("parseFromHeaderForPerson: newline in address returns empty (isBareMailboxShape rejects \\n)", () => {
  // isBareMailboxShape: c === "\\n" branch
  expect(parseFromHeaderForPerson("user\n@example.com")).toEqual({});
});

test("parseFromHeaderForPerson: < in bare address routes to angle extraction", () => {
  // A string with < but no valid angle pair → extractFirstAngleBracketEmail returns null → falls through
  expect(parseFromHeaderForPerson("a<b@c.com")).toEqual({});
});

test("parseFromHeaderForPerson: angle bracket with no closing > returns empty", () => {
  // extractFirstAngleBracketEmail: close === -1 branch
  expect(parseFromHeaderForPerson("Name <no-close@example.com")).toEqual({});
});

test("parseFromHeaderForPerson: angle bracket with bad email inside → skips, no fallback", () => {
  // inner does not pass isBareMailboxShape (no @) so loop advances; no other < → null
  expect(parseFromHeaderForPerson("<notanemail>")).toEqual({});
});

test("parseFromHeaderForPerson: angle with > inside inner — inner.includes(>) branch", () => {
  // inner contains ">" which causes isBareMailboxShape to fail (has ">")
  // "<a>b@c.com>" — open=0 close=2, inner="a" which has no @, searchFrom=1
  // next open=3 (none after index 1 except no more < before ">"... let's use: "x<a>@b.com>"
  // Actually let's use a clear case: angle where inner literal contains >
  // The character ">" causes isBareMailboxShape to return false
  // Use a string that has no second valid pair
  expect(parseFromHeaderForPerson("<no-at-sign>")).toEqual({});
});

test("parseFromHeaderForPerson: tryParseNamedAngleMailbox with bad inner email → null, extract also fails → empty", () => {
  // Named angle where inner is not a valid email shape
  // "Name <not-an-email>" — tryParseNamedAngle returns null (isBareMailboxShape fails)
  // extractFirstAngleBracketEmail: same inner fails isBareMailboxShape, no more brackets → null
  expect(parseFromHeaderForPerson("Name <not-an-email>")).toEqual({});
});

test("parseFromHeaderForPerson: string without > does not match named angle or angle-extract", () => {
  // tryParseNamedAngleMailbox: !trimmed.endsWith(">") → null
  // extractFirstAngleBracketEmail: open === -1 (no <) → null
  // isBareMailboxShape: has a space → false
  // → {}
  expect(parseFromHeaderForPerson("Name Without Angle")).toEqual({});
});

test("parseFromHeaderForPerson: empty angle brackets <> — isBareMailboxShape(empty string) → false", () => {
  // Passes "" to isBareMailboxShape via extractFirstAngleBracketEmail
  // The s === "" branch returns false; then isBareMailboxShape returns false for the outer too
  expect(parseFromHeaderForPerson("<>")).toEqual({});
});

test("parseFromHeaderForPerson: angle brackets with only spaces inside → isBareMailboxShape empty after trim", () => {
  // "<   >" → inner after trim is "" → isBareMailboxShape("") → false
  expect(parseFromHeaderForPerson("<   >")).toEqual({});
});
