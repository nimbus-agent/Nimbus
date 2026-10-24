import { describe, expect, test } from "bun:test";

import { MAX_ROLE_PACK_MANIFEST_BYTES } from "./caps.ts";
import { RegistryError } from "./errors.ts";
import {
  parseRolePackManifest,
  parseRolePackManifestValue,
  type RolePackManifest,
  rolePackDigest,
} from "./role-pack.ts";

type Json = Record<string, unknown>;

function valid(): Json {
  return {
    schema: 1,
    id: "devops",
    name: "DevOps",
    version: "1.0.0",
    description: "On-call and delivery.",
    roles: ["devops", "sre"],
    suggestedConnectors: ["pagerduty", "github"],
    members: [],
    defaults: "[fleet]\nenabled = true\n",
  };
}

function withField(key: string, value: unknown): string {
  return JSON.stringify({ ...valid(), [key]: value });
}

function without(...keys: string[]): string {
  const o = valid();
  for (const k of keys) delete o[k];
  return JSON.stringify(o);
}

/** Asserts a RegistryError with the role-pack code whose detail starts with `path`. */
function expectRefused(fn: () => unknown, path: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RegistryError);
  const err = caught as RegistryError;
  expect(err.code).toBe("ERR_REGISTRY_ROLE_PACK_INVALID");
  expect(err.detail.startsWith(`${path}:`)).toBe(true);
}

const refusedField = (key: string, value: unknown, path = key): void =>
  expectRefused(() => parseRolePackManifest(withField(key, value)), path);

const acceptedField = (key: string, value: unknown): RolePackManifest =>
  parseRolePackManifest(withField(key, value));

describe("parseRolePackManifest", () => {
  test("parses a valid manifest", () => {
    expect(parseRolePackManifest(JSON.stringify(valid()))).toEqual(
      valid() as unknown as RolePackManifest,
    );
  });

  test("absent optional arrays and defaults normalise", () => {
    const m = parseRolePackManifest(without("roles", "suggestedConnectors", "members", "defaults"));
    expect(m.roles).toEqual([]);
    expect(m.suggestedConnectors).toEqual([]);
    expect(m.members).toEqual([]);
    expect(m.defaults).toBe("");
  });

  test("refuses schema other than 1", () => {
    refusedField("schema", 2);
    refusedField("schema", "1");
    expectRefused(() => parseRolePackManifest(without("schema")), "schema");
  });

  test("refuses unknown top-level keys", () => {
    refusedField("sourceMapping", {});
    const text = `{"__proto__":{},${JSON.stringify(valid()).slice(1)}`;
    expectRefused(() => parseRolePackManifest(text), "__proto__");
  });

  test("refuses a non-object document", () => {
    for (const text of ["[]", "null", '"x"', "{not json"]) {
      expectRefused(() => parseRolePackManifest(text), "manifest");
    }
  });

  test("refuses a non-plain or inheriting value", () => {
    const own = valid();
    delete own["defaults"];
    const inheriting = Object.assign(Object.create({ defaults: "x" }) as Json, own);
    expectRefused(() => parseRolePackManifestValue(inheriting), "manifest");
    class Box {
      schema = 1;
    }
    expectRefused(() => parseRolePackManifestValue(new Box()), "manifest");
  });

  test("accepts a null-prototype object", () => {
    const o = Object.assign(Object.create(null) as Json, valid());
    expect(parseRolePackManifestValue(o).id).toBe("devops");
  });

  test("id rules", () => {
    for (const bad of ["", "PM", "-pm", "con", "lpt1", "a".repeat(65), 7]) refusedField("id", bad);
    expect(acceptedField("id", "a".repeat(64)).id).toBe("a".repeat(64));
    expect(acceptedField("id", "pm_2-x").id).toBe("pm_2-x");
  });

  test("name rules", () => {
    for (const bad of ["", "   ", " DevOps", "DevOps ", "x".repeat(81), 3])
      refusedField("name", bad);
    expect(acceptedField("name", "x".repeat(80)).name).toBe("x".repeat(80));
    expect(acceptedField("name", "Dev Ops").name).toBe("Dev Ops");
  });

  test("version must be strict semver", () => {
    for (const bad of ["1.0", "v1.0.0", " 1.0.0", 1]) refusedField("version", bad);
    expect(acceptedField("version", "1.2.3-beta.1").version).toBe("1.2.3-beta.1");
  });

  test("description rules", () => {
    for (const bad of ["", "x".repeat(501), "text\n", null]) refusedField("description", bad);
    expect(acceptedField("description", "x".repeat(500)).description).toBe("x".repeat(500));
    expect(acceptedField("description", "a\nb").description).toBe("a\nb");
  });

  test("roles rules", () => {
    refusedField(
      "roles",
      Array.from({ length: 9 }, (_, i) => `r${String(i)}`),
    );
    refusedField("roles", ["Dev"], "roles[0]");
    refusedField("roles", ["1dev"], "roles[0]");
    refusedField("roles", ["sre", "sre"], "roles[1]");
    refusedField("roles", "sre");
  });

  test("suggestedConnectors rules", () => {
    refusedField(
      "suggestedConnectors",
      Array.from({ length: 33 }, (_, i) => `c${String(i)}`),
    );
    for (const bad of ["Slack", "a/b", "a b", 5]) {
      refusedField("suggestedConnectors", [bad], "suggestedConnectors[0]");
    }
    refusedField("suggestedConnectors", ["slack", "slack"], "suggestedConnectors[1]");
    expect(acceptedField("suggestedConnectors", ["google_drive"]).suggestedConnectors).toEqual([
      "google_drive",
    ]);
  });

  test("members are shape-checked, not refused", () => {
    expect(acceptedField("members", ["com.nimbus.readwise"]).members).toEqual([
      "com.nimbus.readwise",
    ]);
    refusedField("members", ["../evil"], "members[0]");
    refusedField("members", ["a", "a"], "members[1]");
    refusedField(
      "members",
      Array.from({ length: 33 }, (_, i) => `m${String(i)}`),
    );
  });

  test("defaults byte cap counts UTF-8 bytes", () => {
    expect(acceptedField("defaults", "é".repeat(30_000)).defaults).toHaveLength(30_000);
    refusedField("defaults", "é".repeat(33_000));
    refusedField("defaults", 42);
  });

  test("whole-document cap", () => {
    const text = JSON.stringify({ ...valid(), pad: "x".repeat(MAX_ROLE_PACK_MANIFEST_BYTES) });
    expectRefused(() => parseRolePackManifest(text), "manifest");
  });

  test("strips a leading BOM", () => {
    expect(parseRolePackManifest(`﻿${JSON.stringify(valid())}`).id).toBe("devops");
  });

  test("parseRolePackManifestValue accepts the parsed object", () => {
    expect(parseRolePackManifestValue(valid())).toEqual(
      parseRolePackManifest(JSON.stringify(valid())),
    );
  });
});

describe("rolePackDigest", () => {
  test("is stable across formatting and key order", () => {
    const reversed = Object.fromEntries(Object.entries(valid()).reverse());
    const a = rolePackDigest(parseRolePackManifest(JSON.stringify(valid(), null, 2)));
    const b = rolePackDigest(parseRolePackManifest(JSON.stringify(valid())));
    const c = rolePackDigest(parseRolePackManifestValue(reversed));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("absent and empty arrays digest the same", () => {
    const absent = parseRolePackManifest(without("roles", "members", "suggestedConnectors"));
    const empty = parseRolePackManifest(
      JSON.stringify({ ...valid(), roles: [], members: [], suggestedConnectors: [] }),
    );
    expect(rolePackDigest(absent)).toBe(rolePackDigest(empty));
  });

  test("a description-only change changes the digest", () => {
    const a = parseRolePackManifest(JSON.stringify(valid()));
    const b = acceptedField("description", "Something else.");
    expect(rolePackDigest(b)).not.toBe(rolePackDigest(a));
  });
});
