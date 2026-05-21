import { describe, expect, test } from "bun:test";

import { filterSnykAggregatedIssues } from "../src/search-filter.ts";

function issue(fields: {
  id?: string;
  title?: string;
  cves?: string[];
  pkgName?: string;
}): Record<string, unknown> {
  return {
    id: fields.id ?? "SNYK-X-Y",
    issueData: {
      title: fields.title ?? "",
      cve: fields.cves ?? [],
    },
    pkgName: fields.pkgName ?? "",
  };
}

describe("filterSnykAggregatedIssues", () => {
  test("matches against issueData.title (case-insensitive)", () => {
    const out = filterSnykAggregatedIssues([issue({ title: "Prototype Pollution in lodash" })], {
      query: "POLLUTION",
    });
    expect(out).toHaveLength(1);
  });

  test("matches against issueData.cve entries", () => {
    const out = filterSnykAggregatedIssues([issue({ cves: ["CVE-2020-8203", "GHSA-p6mc"] })], {
      query: "cve-2020-8203",
    });
    expect(out).toHaveLength(1);
  });

  test("matches against pkgName", () => {
    const out = filterSnykAggregatedIssues(
      [issue({ pkgName: "openssl" }), issue({ pkgName: "lodash" })],
      { query: "open" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { pkgName: string }).pkgName).toBe("openssl");
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterSnykAggregatedIssues([42, null, "string", issue({ title: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches are truncated in encounter order", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      issue({ id: `id-${i}`, title: `vuln-${i}` }),
    );
    const out = filterSnykAggregatedIssues(issues, { query: "vuln", limit: 3 });
    expect(out).toHaveLength(3);
    const ids = out.map((it) => (it as { id: string }).id);
    expect(ids).toEqual(["id-0", "id-1", "id-2"]);
  });

  test("default limit is 50", () => {
    const issues = Array.from({ length: 100 }, (_, i) => issue({ id: `id-${i}`, title: "vuln" }));
    const out = filterSnykAggregatedIssues(issues, { query: "vuln" });
    expect(out).toHaveLength(50);
  });

  test("non-array issueData / missing fields are tolerated", () => {
    const oddities: unknown[] = [
      { id: "no-issueData" },
      { id: "weird", issueData: 42 },
      { id: "ok", issueData: { title: "match me" } },
    ];
    const out = filterSnykAggregatedIssues(oddities, { query: "match" });
    expect(out).toHaveLength(1);
  });

  test("empty issue list returns empty", () => {
    expect(filterSnykAggregatedIssues([], { query: "anything" })).toEqual([]);
  });
});
