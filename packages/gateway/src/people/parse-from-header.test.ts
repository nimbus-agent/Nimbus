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

test("parseFromHeaderForPerson: angle-bracket-only (no display name)", () => {
  const r = parseFromHeaderForPerson("<addr@host.com>");
  expect(r.email).toBe("addr@host.com");
  expect(r.displayName).toBeUndefined();
});
