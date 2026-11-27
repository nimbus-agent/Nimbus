// packages/gateway/src/connectors/connector-writes/installed-schema-keys.test.ts
// The 0.19.0 row-test helpers fail loudly rather than yield nothing: a missing anchor, object, row
// or registration throws, so a renamed schema or tool fails its test instead of passing vacuously.
import { describe, expect, test } from "bun:test";

import {
  installedRegistration,
  installedToolsSource,
  objectKeysAt,
} from "./installed-schema-keys.test-helpers.ts";
import { rowOf } from "./issue-edit-rows.test-helpers.ts";

describe("objectKeysAt", () => {
  test("reads only the top-level keys of the first object after the anchor", () => {
    const src =
      "const s = z.object({ owner: z.string(), inner: z.object({ deep: x }), a.b: 1, n: 2 });";
    expect(objectKeysAt(src, "const s")).toEqual(["owner", "inner", "n"]);
  });

  test("throws on a missing anchor or a missing object", () => {
    expect(() => objectKeysAt("const s = 1;", "const t")).toThrow("anchor not found: const t");
    expect(() => objectKeysAt("const s = 1;", "const s")).toThrow("no object after: const s");
  });
});

describe("the installed-package readers", () => {
  test("read the installed github tools and its one review registration", () => {
    expect(installedToolsSource("github")).toContain("github_pr_review_create");
    expect(installedRegistration("github_pr_review_create", "github")).toContain(
      "github_pr_review_create",
    );
  });

  test("an unknown registration or row throws", () => {
    expect(() => installedRegistration("github_no_such_tool", "github")).toThrow(
      "github_no_such_tool: 0 registrations",
    );
    expect(() => rowOf("github_no_such_tool")).toThrow("no row github_no_such_tool");
  });
});
