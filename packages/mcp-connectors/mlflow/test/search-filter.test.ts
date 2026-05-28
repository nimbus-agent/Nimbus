import { describe, expect, test } from "bun:test";

import { filterMlflowModels } from "../src/search-filter.ts";

function model(over: {
  name?: string | null;
  description?: string;
  tags?: Array<{ key: string; value: string }>;
}): Record<string, unknown> {
  return {
    name: over.name === undefined ? "fraud-detector" : over.name,
    description: over.description ?? "",
    ...(over.tags === undefined ? {} : { tags: over.tags }),
  };
}

describe("filterMlflowModels", () => {
  test("matches against name (case-insensitive)", () => {
    expect(filterMlflowModels([model({})], { query: "FRAUD" })).toHaveLength(1);
  });

  test("matches against description", () => {
    expect(
      filterMlflowModels([model({ name: "X", description: "churn prediction model" })], {
        query: "churn",
      }),
    ).toHaveLength(1);
  });

  test("matches against flattened key=value tags", () => {
    expect(
      filterMlflowModels([model({ name: "X", tags: [{ key: "team", value: "ml-platform" }] })], {
        query: "ml-platform",
      }),
    ).toHaveLength(1);
    expect(
      filterMlflowModels([model({ name: "X", tags: [{ key: "team", value: "ml-platform" }] })], {
        query: "team=ml-platform",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMlflowModels([model({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterMlflowModels([null, 42, "x", model({})], { query: "fraud" })).toHaveLength(1);
  });

  test("tolerates a missing tags array without throwing", () => {
    const noTags = { name: "isolation-forest", description: "anomaly" };
    expect(filterMlflowModels([noTags], { query: "isolation" })).toHaveLength(1);
    expect(filterMlflowModels([noTags], { query: "fraud" })).toHaveLength(0);
  });

  test("tolerates a null name", () => {
    const nullName = { name: null, description: "ranker" };
    expect(filterMlflowModels([nullName], { query: "ranker" })).toHaveLength(1);
  });

  test("tolerates a non-object tag entry inside the tags array", () => {
    const weirdTags = { name: "m", tags: [null, 5, { key: "env", value: "prod" }] };
    expect(filterMlflowModels([weirdTags], { query: "env=prod" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => model({ name: `model-${String(i)}` }));
    expect(filterMlflowModels(many, { query: "model-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => model({ name: `model-${String(i)}` }));
    expect(filterMlflowModels(many, { query: "model-" })).toHaveLength(50);
  });
});
