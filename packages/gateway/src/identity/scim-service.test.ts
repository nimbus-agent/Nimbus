// scim-service.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import {
  applyScimCreate,
  parseScimPatchActive,
  projectScimAttrs,
  ScimError,
} from "./scim-service.ts";

function freshStore(): { db: Database; store: IdentityStore } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return { db, store: new IdentityStore(db) };
}

describe("projectScimAttrs — PII allowlist (S2)", () => {
  test("keeps only allowlisted non-PII fields; drops phone/address/enterprise extension", () => {
    const attrs = projectScimAttrs({
      userName: "alice",
      displayName: "Alice A",
      name: { formatted: "Alice A", familyName: "A" },
      phoneNumbers: [{ value: "+1-555-0100" }],
      addresses: [{ streetAddress: "1 Main St" }],
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
        department: "Eng",
        manager: { value: "m1" },
      },
      meta: { lastModified: "2026-06-05T00:00:00Z", resourceType: "User" },
    });
    expect(attrs).toEqual({
      displayName: "Alice A",
      name: { formatted: "Alice A" },
      meta: { lastModified: "2026-06-05T00:00:00Z" },
    });
  });
});

describe("applyScimCreate", () => {
  test("promotes externalId/userName/email/active and stores allowlisted attrs", () => {
    const { store } = freshStore();
    applyScimCreate(
      store,
      {
        externalId: "u1",
        userName: "alice",
        emails: [{ value: "a@acme.com", primary: true }],
        active: true,
        phoneNumbers: [{ value: "x" }],
      },
      100,
    );
    const u = store.getScimUser("u1");
    expect(u?.email).toBe("a@acme.com");
    expect(u?.active).toBe(true);
    expect(JSON.stringify(u?.attrs).includes("phoneNumbers")).toBe(false);
  });
});

describe("parseScimPatchActive", () => {
  test("detects active:false from a replace PatchOp", () => {
    expect(
      parseScimPatchActive({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    ).toBe(false);
  });
  test("detects active:false from a value-object replace", () => {
    expect(
      parseScimPatchActive({ Operations: [{ op: "replace", value: { active: false } }] }),
    ).toBe(false);
  });
  test("returns undefined when no active op present", () => {
    expect(
      parseScimPatchActive({ Operations: [{ op: "replace", path: "displayName", value: "x" }] }),
    ).toBeUndefined();
  });
  test("throws ScimError(400) on a non-boolean active (path form) — no silent deprovision", () => {
    expect(() =>
      parseScimPatchActive({ Operations: [{ op: "replace", path: "active", value: "false" }] }),
    ).toThrow(ScimError);
  });
  test("throws ScimError(400) on a non-boolean active (value-object form)", () => {
    expect(() =>
      parseScimPatchActive({ Operations: [{ op: "replace", value: { active: "true" } }] }),
    ).toThrow(ScimError);
  });
});
