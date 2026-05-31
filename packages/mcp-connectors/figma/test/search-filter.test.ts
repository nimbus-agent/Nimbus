import { describe, expect, test } from "bun:test";

import { filterFigmaFiles } from "../src/search-filter.ts";

function file(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "abc123",
    name: "Q2 Roadmap",
    thumbnail_url: "https://figma.com/thumb/abc123",
    last_modified: "2026-05-20T00:00:00Z",
    project_id: "111",
    project_name: "Design System",
    ...over,
  };
}

describe("filterFigmaFiles", () => {
  test("matches against the file name (case-insensitive)", () => {
    expect(filterFigmaFiles([file()], { query: "q2 roadmap" })).toHaveLength(1);
  });

  test("matches against the project name", () => {
    expect(filterFigmaFiles([file()], { query: "design system" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterFigmaFiles([file()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(filterFigmaFiles([null, 42, "x", file()], { query: "roadmap" })).toHaveLength(1);
  });

  test("tolerates a missing project_name", () => {
    const noProject = file();
    delete (noProject as Record<string, unknown>)["project_name"];
    // still matches on file name
    expect(filterFigmaFiles([noProject], { query: "roadmap" })).toHaveLength(1);
    // project-only query no longer matches
    expect(filterFigmaFiles([noProject], { query: "design system" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => file({ key: String(i), name: "Roadmap" }));
    expect(filterFigmaFiles(many, { query: "roadmap", limit: 3 })).toHaveLength(3);
  });
});
