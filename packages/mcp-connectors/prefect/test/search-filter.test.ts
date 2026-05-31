import { describe, expect, test } from "bun:test";

import { filterPrefectDeployments } from "../src/search-filter.ts";

function deployment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "nightly-etl",
    flow_id: "22222222-2222-2222-2222-222222222222",
    description: "Nightly extract-transform-load flow",
    tags: ["etl", "tier-1"],
    paused: false,
    work_pool_name: "default-pool",
    work_queue_name: "default-queue",
    status: "READY",
    ...over,
  };
}

describe("filterPrefectDeployments", () => {
  test("matches against the name (case-insensitive)", () => {
    expect(filterPrefectDeployments([deployment()], { query: "NIGHTLY" })).toHaveLength(1);
  });

  test("matches against description, work pool/queue, status, and tags", () => {
    expect(filterPrefectDeployments([deployment()], { query: "extract-transform" })).toHaveLength(
      1,
    );
    expect(filterPrefectDeployments([deployment()], { query: "default-pool" })).toHaveLength(1);
    expect(filterPrefectDeployments([deployment()], { query: "default-queue" })).toHaveLength(1);
    expect(filterPrefectDeployments([deployment()], { query: "READY" })).toHaveLength(1);
    expect(filterPrefectDeployments([deployment()], { query: "etl" })).toHaveLength(1);
    expect(filterPrefectDeployments([deployment()], { query: "tier-1" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterPrefectDeployments([deployment()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips entries that are not objectish", () => {
    expect(
      filterPrefectDeployments([null, 42, "x", deployment()], { query: "nightly" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields and a non-array tags value", () => {
    const sparse = deployment({ description: undefined, tags: "nope" });
    expect(filterPrefectDeployments([sparse], { query: "nightly" })).toHaveLength(1);
    expect(filterPrefectDeployments([sparse], { query: "tier-1" })).toHaveLength(0);
  });

  test("tolerates non-string tag entries", () => {
    const odd = deployment({ tags: [null, 7, "ok-tag"] });
    expect(filterPrefectDeployments([odd], { query: "ok-tag" })).toHaveLength(1);
    expect(filterPrefectDeployments([odd], { query: "7" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      deployment({ name: `nightly-etl-${String(i)}` }),
    );
    expect(filterPrefectDeployments(many, { query: "nightly", limit: 3 })).toHaveLength(3);
  });
});
