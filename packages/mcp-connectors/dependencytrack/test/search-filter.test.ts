import { describe, expect, test } from "bun:test";

import { filterDependencyTrackProjects } from "../src/search-filter.ts";

function project(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "b1c2d3e4-0000-4000-8000-000000000001",
    name: "payment-service",
    version: "2.3.1",
    classifier: "APPLICATION",
    active: true,
    lastBomImport: 1_700_000_000_000,
    tags: [{ name: "tier-1" }, { name: "pci" }],
    metrics: { critical: 2, high: 5, medium: 9, low: 3, vulnerabilities: 19, components: 142 },
    ...over,
  };
}

describe("filterDependencyTrackProjects", () => {
  test("matches against the name (case-insensitive)", () => {
    expect(filterDependencyTrackProjects([project()], { query: "PAYMENT" })).toHaveLength(1);
  });

  test("matches against version, classifier, and tag names", () => {
    expect(filterDependencyTrackProjects([project()], { query: "2.3.1" })).toHaveLength(1);
    expect(filterDependencyTrackProjects([project()], { query: "application" })).toHaveLength(1);
    expect(filterDependencyTrackProjects([project()], { query: "tier-1" })).toHaveLength(1);
    expect(filterDependencyTrackProjects([project()], { query: "pci" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterDependencyTrackProjects([project()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips entries that are not objectish", () => {
    expect(
      filterDependencyTrackProjects([null, 42, "x", project()], { query: "payment" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields and a non-array / non-object tags value", () => {
    const sparse = project({ version: undefined, classifier: undefined, tags: "nope" });
    expect(filterDependencyTrackProjects([sparse], { query: "payment" })).toHaveLength(1);
    expect(filterDependencyTrackProjects([sparse], { query: "tier-1" })).toHaveLength(0);
  });

  test("tolerates non-object tag entries and tags without a name", () => {
    const odd = project({ tags: [null, 7, { foo: "bar" }, { name: "zzqtag" }] });
    expect(filterDependencyTrackProjects([odd], { query: "zzqtag" })).toHaveLength(1);
    expect(filterDependencyTrackProjects([odd], { query: "bar" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      project({ uuid: `u${String(i)}`, name: `payment-${String(i)}` }),
    );
    expect(filterDependencyTrackProjects(many, { query: "payment", limit: 3 })).toHaveLength(3);
  });
});
