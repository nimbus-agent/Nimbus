/**
 * SCIM resource parsing arms `scim-service.test.ts` leaves unexercised: the `id` fallback for a
 * missing `externalId` and the 400 when neither is usable, the primary-email selection rules,
 * the `active` default, and the PatchOp shapes that set nothing (non-array `Operations`, a
 * non-object op, an op that is not replace/add) — plus `add` and last-op-wins.
 */
import { describe, expect, test } from "bun:test";
import { parseScimPatchActive, ScimError, toScimUser } from "./scim-service.ts";

function refusal(resource: Record<string, unknown>): ScimError {
  try {
    toScimUser(resource);
  } catch (e) {
    if (e instanceof ScimError) return e;
    throw e;
  }
  throw new Error(`expected toScimUser to refuse ${JSON.stringify(resource)}`);
}

describe("toScimUser — identity", () => {
  test("falls back to the SCIM id when no externalId is supplied", () => {
    expect(toScimUser({ id: "okta-00u1" }).externalId).toBe("okta-00u1");
    // A supplied externalId wins over the id.
    expect(toScimUser({ id: "okta-00u1", externalId: "emp-7" }).externalId).toBe("emp-7");
  });

  test.each([
    ["neither externalId nor id", {}],
    ["an empty externalId", { externalId: "" }],
    ["a numeric externalId", { externalId: 7 }],
    ["a null externalId and a numeric id", { externalId: null, id: 42 }],
  ])("%s is a 400, not a user", (_label, resource) => {
    const e = refusal(resource);
    expect(e.status).toBe(400);
    expect(e.message).toBe("missing externalId");
  });
});

describe("toScimUser — profile fields", () => {
  test("a non-string userName is stored as null", () => {
    expect(toScimUser({ externalId: "u1", userName: 12 }).userName).toBeNull();
  });

  test("an absent active means active; anything but a JSON true is inactive", () => {
    expect(toScimUser({ externalId: "u1" }).active).toBe(true);
    expect(toScimUser({ externalId: "u1", active: true }).active).toBe(true);
    expect(toScimUser({ externalId: "u1", active: false }).active).toBe(false);
    expect(toScimUser({ externalId: "u1", active: "true" }).active).toBe(false);
  });

  test.each([
    ["emails that are not an array", { emails: "a@acme.com" }, null],
    [
      "no email flagged primary — the first is taken",
      { emails: [{ value: "first@acme.com" }, { value: "second@acme.com" }] },
      "first@acme.com",
    ],
    [
      "a primary flag among several — that one is taken",
      { emails: [{ value: "first@acme.com" }, { value: "work@acme.com", primary: true }] },
      "work@acme.com",
    ],
    ["a primary whose value is not a string", { emails: [{ value: 5, primary: true }] }, null],
    ["an empty email list", { emails: [] }, null],
  ] as const)("%s", (_label, extra, expected) => {
    expect(toScimUser({ externalId: "u1", ...extra }).email).toBe(expected);
  });
});

describe("parseScimPatchActive — ops that set nothing", () => {
  test.each([
    [
      "Operations that is not an array",
      { Operations: { op: "replace", path: "active", value: false } },
    ],
    ["an op that is not an object", { Operations: ["replace"] }],
    // `null` is the non-object op that would THROW rather than read as "no op" if the object
    // guard ever went: a string answers `undefined` for any property it is asked for.
    ["a null op, and a numeric one", { Operations: [null, 7] }],
    ["an op whose name is not a string", { Operations: [{ op: 1, path: "active", value: false }] }],
    ["a remove op", { Operations: [{ op: "remove", path: "active", value: false }] }],
  ])("%s yields undefined", (_label, patch) => {
    expect(parseScimPatchActive(patch)).toBeUndefined();
  });

  test("an add op sets active, case-insensitively, and the last op that sets it wins", () => {
    expect(
      parseScimPatchActive({ Operations: [{ op: "Add", path: "active", value: false }] }),
    ).toBe(false);
    expect(
      parseScimPatchActive({
        Operations: [
          { op: "replace", path: "active", value: false },
          { op: "remove", path: "active" },
          { op: "add", value: { active: true } },
        ],
      }),
    ).toBe(true);
  });
});
