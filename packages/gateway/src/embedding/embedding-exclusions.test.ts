import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_EXCLUDED_TYPES,
  isEmbeddingExcludedType,
  notEmbeddingExcludedSql,
} from "./embedding-exclusions.ts";

describe("embedding exclusions", () => {
  test("cost_allocation is excluded; cost_recommendation and other types are not", () => {
    expect(isEmbeddingExcludedType("cost_allocation")).toBe(true);
    expect(isEmbeddingExcludedType("cost_recommendation")).toBe(false);
    expect(isEmbeddingExcludedType("incident")).toBe(false);
    expect(isEmbeddingExcludedType("email")).toBe(false);
    expect(EMBEDDING_EXCLUDED_TYPES).toEqual(["cost_allocation", "dag_run", "job_run", "flow_run"]);
    for (const t of ["dag_run", "job_run", "flow_run"])
      expect(isEmbeddingExcludedType(t)).toBe(true);
  });

  test("the SQL fragment is exact", () => {
    expect(notEmbeddingExcludedSql("i")).toBe(
      "i.type NOT IN ('cost_allocation', 'dag_run', 'job_run', 'flow_run')",
    );
  });
});

describe("local-only types", () => {
  test("cost_recommendation is excluded only for a remote embedder", () => {
    expect(isEmbeddingExcludedType("cost_recommendation")).toBe(false);
    expect(isEmbeddingExcludedType("cost_recommendation", true)).toBe(true);
    expect(isEmbeddingExcludedType("email", true)).toBe(false);
    expect(notEmbeddingExcludedSql("i", true)).toBe(
      "i.type NOT IN ('cost_allocation', 'dag_run', 'job_run', 'flow_run', 'cost_recommendation')",
    );
  });
});
