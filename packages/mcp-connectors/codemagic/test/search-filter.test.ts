import { describe, expect, test } from "bun:test";

import { filterCodemagicBuilds } from "../src/search-filter.ts";

function build(fields: {
  _id?: string;
  branch?: string;
  message?: string;
  workflowId?: string;
  status?: string;
}): Record<string, unknown> {
  return {
    _id: fields._id ?? "abc123",
    branch: fields.branch ?? "main",
    message: fields.message ?? "",
    workflowId: fields.workflowId ?? "primary",
    status: fields.status ?? "finished",
  };
}

describe("filterCodemagicBuilds", () => {
  test("matches against branch (case-insensitive)", () => {
    const out = filterCodemagicBuilds([build({ branch: "feature/login" })], { query: "LOGIN" });
    expect(out).toHaveLength(1);
  });

  test("matches against message", () => {
    const out = filterCodemagicBuilds([build({ message: "Fix crash on launch" })], {
      query: "crash",
    });
    expect(out).toHaveLength(1);
  });

  test("matches against workflowId", () => {
    const out = filterCodemagicBuilds(
      [build({ workflowId: "primary" }), build({ workflowId: "release" })],
      { query: "release" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { workflowId: string }).workflowId).toBe("release");
  });

  test("matches against status", () => {
    const out = filterCodemagicBuilds(
      [build({ status: "finished" }), build({ status: "failed" })],
      { query: "failed" },
    );
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterCodemagicBuilds([42, null, "string", build({ branch: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches are truncated in encounter order", () => {
    const builds = Array.from({ length: 10 }, (_, i) =>
      build({ _id: `id-${i}`, branch: `feat-${i}` }),
    );
    const out = filterCodemagicBuilds(builds, { query: "feat", limit: 3 });
    expect(out).toHaveLength(3);
    const ids = out.map((it) => (it as { _id: string })._id);
    expect(ids).toEqual(["id-0", "id-1", "id-2"]);
  });

  test("default limit is 50", () => {
    const builds = Array.from({ length: 100 }, (_, i) => build({ _id: `s-${i}`, branch: "main" }));
    const out = filterCodemagicBuilds(builds, { query: "main" });
    expect(out).toHaveLength(50);
  });

  test("missing fields are tolerated", () => {
    const oddities: unknown[] = [
      { _id: "missing-fields" },
      { _id: "weird", branch: 42 },
      { _id: "ok", branch: "match-me" },
    ];
    const out = filterCodemagicBuilds(oddities, { query: "match" });
    expect(out).toHaveLength(1);
  });

  test("empty list returns empty", () => {
    expect(filterCodemagicBuilds([], { query: "anything" })).toEqual([]);
  });
});
