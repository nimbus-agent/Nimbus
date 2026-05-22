import { describe, expect, test } from "bun:test";

import { filterBitriseBuilds } from "../src/search-filter.ts";

function build(fields: {
  slug?: string;
  branch?: string;
  commit_message?: string;
  triggered_workflow?: string;
  status_text?: string;
}): Record<string, unknown> {
  return {
    slug: fields.slug ?? "abc123",
    branch: fields.branch ?? "main",
    commit_message: fields.commit_message ?? "",
    triggered_workflow: fields.triggered_workflow ?? "primary",
    status_text: fields.status_text ?? "success",
  };
}

describe("filterBitriseBuilds", () => {
  test("matches against branch (case-insensitive)", () => {
    const out = filterBitriseBuilds([build({ branch: "feature/login" })], { query: "LOGIN" });
    expect(out).toHaveLength(1);
  });

  test("matches against commit_message", () => {
    const out = filterBitriseBuilds([build({ commit_message: "Fix crash on launch" })], {
      query: "crash",
    });
    expect(out).toHaveLength(1);
  });

  test("matches against triggered_workflow", () => {
    const out = filterBitriseBuilds(
      [build({ triggered_workflow: "primary" }), build({ triggered_workflow: "release" })],
      { query: "release" },
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { triggered_workflow: string }).triggered_workflow).toBe("release");
  });

  test("matches against status_text", () => {
    const out = filterBitriseBuilds(
      [build({ status_text: "success" }), build({ status_text: "error" })],
      { query: "error" },
    );
    expect(out).toHaveLength(1);
  });

  test("skips non-object entries (numbers, nulls, strings)", () => {
    const out = filterBitriseBuilds([42, null, "string", build({ branch: "hit" })], {
      query: "hit",
    });
    expect(out).toHaveLength(1);
  });

  test("respects limit; matches are truncated in encounter order", () => {
    const builds = Array.from({ length: 10 }, (_, i) =>
      build({ slug: `slug-${i}`, branch: `feat-${i}` }),
    );
    const out = filterBitriseBuilds(builds, { query: "feat", limit: 3 });
    expect(out).toHaveLength(3);
    const slugs = out.map((it) => (it as { slug: string }).slug);
    expect(slugs).toEqual(["slug-0", "slug-1", "slug-2"]);
  });

  test("default limit is 50", () => {
    const builds = Array.from({ length: 100 }, (_, i) => build({ slug: `s-${i}`, branch: "main" }));
    const out = filterBitriseBuilds(builds, { query: "main" });
    expect(out).toHaveLength(50);
  });

  test("missing fields are tolerated", () => {
    const oddities: unknown[] = [
      { slug: "missing-fields" },
      { slug: "weird", branch: 42 },
      { slug: "ok", branch: "match-me" },
    ];
    const out = filterBitriseBuilds(oddities, { query: "match" });
    expect(out).toHaveLength(1);
  });

  test("empty list returns empty", () => {
    expect(filterBitriseBuilds([], { query: "anything" })).toEqual([]);
  });
});
