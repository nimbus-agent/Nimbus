import { describe, expect, test } from "bun:test";

import { filterSonarIssues } from "../src/search-filter.ts";

function issue(fields: {
  key?: string;
  message?: string;
  rule?: string;
  component?: string;
  tags?: string[];
}): Record<string, unknown> {
  return {
    key: fields.key ?? "AYxr-key",
    message: fields.message ?? "",
    rule: fields.rule ?? "",
    component: fields.component ?? "",
    tags: fields.tags ?? [],
  };
}

describe("filterSonarIssues", () => {
  test("matches against message (case-insensitive)", () => {
    const out = filterSonarIssues([issue({ message: "Replace null check with Optional" })], {
      query: "OPTIONAL",
    });
    expect(out).toHaveLength(1);
  });

  test("matches against rule id", () => {
    const out = filterSonarIssues([issue({ rule: "java:S1234" })], { query: "S1234" });
    expect(out).toHaveLength(1);
  });

  test("matches against component path", () => {
    const out = filterSonarIssues(
      [
        issue({ component: "myorg_myproject:src/Foo.java" }),
        issue({ component: "myorg_myproject:src/Bar.java" }),
      ],
      { query: "foo.java" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { component: string }).component).toBe("myorg_myproject:src/Foo.java");
  });

  test("matches against tags", () => {
    const out = filterSonarIssues([issue({ tags: ["security", "owasp-a3"] })], {
      query: "owasp",
    });
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterSonarIssues([42, null, "string", issue({ message: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches are truncated in encounter order", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      issue({ key: `k-${i}`, message: `vuln-${i}` }),
    );
    const out = filterSonarIssues(issues, { query: "vuln", limit: 3 });
    expect(out).toHaveLength(3);
    const keys = out.map((it) => (it as { key: string }).key);
    expect(keys).toEqual(["k-0", "k-1", "k-2"]);
  });

  test("default limit is 50", () => {
    const issues = Array.from({ length: 100 }, (_, i) => issue({ key: `k-${i}`, message: "vuln" }));
    const out = filterSonarIssues(issues, { query: "vuln" });
    expect(out).toHaveLength(50);
  });

  test("non-array tags are tolerated", () => {
    const out = filterSonarIssues(
      [
        { key: "weird", message: "x", rule: "", component: "", tags: 42 },
        issue({ message: "match me" }),
      ],
      { query: "match" },
    );
    expect(out).toHaveLength(1);
  });

  test("empty issue list returns empty", () => {
    expect(filterSonarIssues([], { query: "anything" })).toEqual([]);
  });
});
