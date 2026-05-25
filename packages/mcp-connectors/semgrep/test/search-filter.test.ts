import { describe, expect, test } from "bun:test";

import { filterSemgrepFindings } from "../src/search-filter.ts";

function finding(fields: {
  id?: string;
  rule_name?: string;
  rule_message?: string;
  file_path?: string;
  repo?: string;
}): Record<string, unknown> {
  return {
    id: fields.id ?? "f-1",
    rule_name: fields.rule_name ?? "",
    rule_message: fields.rule_message ?? "",
    location: { file_path: fields.file_path ?? "", line: 1 },
    repository: { name: fields.repo ?? "" },
  };
}

describe("filterSemgrepFindings", () => {
  test("matches rule_name (case-insensitive)", () => {
    const out = filterSemgrepFindings(
      [finding({ rule_name: "javascript.lang.security.audit.xss.direct-response-write" })],
      { query: "XSS" },
    );
    expect(out).toHaveLength(1);
  });

  test("matches rule_message text", () => {
    const out = filterSemgrepFindings(
      [finding({ rule_message: "Unsanitized input flows into HTTP response" })],
      { query: "unsanitized" },
    );
    expect(out).toHaveLength(1);
  });

  test("matches nested location.file_path", () => {
    const out = filterSemgrepFindings(
      [finding({ file_path: "src/api/user.js" }), finding({ file_path: "src/api/admin.js" })],
      { query: "user.js" },
    );
    expect(out).toHaveLength(1);
    const loc = (out[0] as { location: { file_path: string } }).location;
    expect(loc.file_path).toBe("src/api/user.js");
  });

  test("matches nested repository.name", () => {
    const out = filterSemgrepFindings([finding({ repo: "acme/payments" })], {
      query: "payments",
    });
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterSemgrepFindings([42, null, "string", finding({ rule_name: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches truncate in encounter order", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      finding({ id: `f-${i}`, rule_name: `vuln-${i}` }),
    );
    const out = filterSemgrepFindings(findings, { query: "vuln", limit: 3 });
    expect(out).toHaveLength(3);
    const ids = out.map((it) => (it as { id: string }).id);
    expect(ids).toEqual(["f-0", "f-1", "f-2"]);
  });

  test("default limit is 50", () => {
    const findings = Array.from({ length: 100 }, (_, i) =>
      finding({ id: `f-${i}`, rule_name: "vuln" }),
    );
    const out = filterSemgrepFindings(findings, { query: "vuln" });
    expect(out).toHaveLength(50);
  });

  test("malformed nested fields (number instead of object) are tolerated", () => {
    const oddities: unknown[] = [
      { id: "weird", rule_name: "x", location: 42, repository: 99 },
      finding({ rule_name: "match me" }),
    ];
    const out = filterSemgrepFindings(oddities, { query: "match" });
    expect(out).toHaveLength(1);
  });

  test("empty findings list returns empty", () => {
    expect(filterSemgrepFindings([], { query: "anything" })).toEqual([]);
  });
});
