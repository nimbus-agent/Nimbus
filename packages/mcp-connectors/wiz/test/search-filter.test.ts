import { describe, expect, test } from "bun:test";

import { filterWizIssues } from "../src/search-filter.ts";

function issue(fields: {
  id?: string;
  rule_name?: string;
  description?: string;
  entity_name?: string;
  entity_type?: string;
  projects?: string[];
}): Record<string, unknown> {
  return {
    id: fields.id ?? "iss-1",
    sourceRule: { id: "rule-1", name: fields.rule_name ?? "" },
    description: fields.description ?? "",
    entity: { id: "ent-1", name: fields.entity_name ?? "", type: fields.entity_type ?? "" },
    projects: (fields.projects ?? []).map((n, i) => ({
      id: `proj-${String(i)}`,
      name: n,
    })),
  };
}

describe("filterWizIssues", () => {
  test("matches sourceRule.name (case-insensitive)", () => {
    const out = filterWizIssues([issue({ rule_name: "Public S3 bucket detected" })], {
      query: "S3",
    });
    expect(out).toHaveLength(1);
  });

  test("matches description text", () => {
    const out = filterWizIssues(
      [issue({ description: "Bucket allows unauthenticated public read access." })],
      { query: "unauthenticated" },
    );
    expect(out).toHaveLength(1);
  });

  test("matches nested entity.name", () => {
    const out = filterWizIssues(
      [issue({ entity_name: "acme-prod-storage" }), issue({ entity_name: "acme-dev-storage" })],
      { query: "prod-storage" },
    );
    expect(out).toHaveLength(1);
  });

  test("matches nested entity.type", () => {
    const out = filterWizIssues([issue({ entity_type: "VIRTUAL_MACHINE" })], {
      query: "virtual_machine",
    });
    expect(out).toHaveLength(1);
  });

  test("matches across project names", () => {
    const out = filterWizIssues([issue({ projects: ["payments-prod", "core-infra"] })], {
      query: "payments",
    });
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterWizIssues([42, null, "string", issue({ rule_name: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches truncate in encounter order", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      issue({ id: `i-${String(i)}`, rule_name: `vuln-${String(i)}` }),
    );
    const out = filterWizIssues(issues, { query: "vuln", limit: 3 });
    expect(out).toHaveLength(3);
    const ids = out.map((it) => (it as { id: string }).id);
    expect(ids).toEqual(["i-0", "i-1", "i-2"]);
  });

  test("default limit is 50", () => {
    const issues = Array.from({ length: 100 }, (_, i) =>
      issue({ id: `i-${String(i)}`, rule_name: "vuln" }),
    );
    const out = filterWizIssues(issues, { query: "vuln" });
    expect(out).toHaveLength(50);
  });

  test("malformed nested fields (numbers instead of objects) are tolerated", () => {
    const oddities: unknown[] = [
      { id: "weird", sourceRule: 42, description: "x", entity: 99, projects: 7 },
      issue({ rule_name: "match me" }),
    ];
    const out = filterWizIssues(oddities, { query: "match" });
    expect(out).toHaveLength(1);
  });

  test("empty issue list returns empty", () => {
    expect(filterWizIssues([], { query: "anything" })).toEqual([]);
  });
});
