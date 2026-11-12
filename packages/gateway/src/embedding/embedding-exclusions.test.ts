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
    expect(EMBEDDING_EXCLUDED_TYPES).toEqual(["cost_allocation"]);
  });

  test("the SQL fragment is exact", () => {
    expect(notEmbeddingExcludedSql("i")).toBe("i.type NOT IN ('cost_allocation')");
  });
});
