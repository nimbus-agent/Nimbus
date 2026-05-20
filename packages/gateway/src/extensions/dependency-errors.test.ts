import { describe, expect, it } from "bun:test";
import {
  DependencyConflictError,
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
  OfflineDependencyResolutionError,
} from "./dependency-errors.ts";

describe("DependencyConflictError", () => {
  it("carries the structured conflict payload", () => {
    const e = new DependencyConflictError({
      kind: "unsatisfiable",
      id: "com.shared.utils",
      constraints: [{ from: "com.example.foo", range: "^2.0.0" }],
    });
    expect(e.name).toBe("DependencyConflictError");
    expect(e.conflict.kind).toBe("unsatisfiable");
    expect(e.conflict.id).toBe("com.shared.utils");
    expect(e.message).toContain("com.shared.utils");
  });

  it("narrows via isDependencyConflictError", () => {
    const e: unknown = new DependencyConflictError({
      kind: "cycle",
      id: "com.a",
      chain: ["com.a", "com.b", "com.a"],
    });
    expect(isDependencyConflictError(e)).toBe(true);
    expect(isDependencyConflictError(new Error("other"))).toBe(false);
  });
});

describe("OfflineDependencyResolutionError", () => {
  it("carries missingId + parent and prints both", () => {
    const e = new OfflineDependencyResolutionError({
      missingId: "com.shared.utils",
      parent: "com.example.foo",
    });
    expect(e.missingId).toBe("com.shared.utils");
    expect(e.parent).toBe("com.example.foo");
    expect(e.message).toContain("com.shared.utils");
    expect(e.message).toContain("com.example.foo");
  });

  it("narrows via isOfflineDependencyResolutionError", () => {
    const e: unknown = new OfflineDependencyResolutionError({
      missingId: "x",
      parent: "y",
    });
    expect(isOfflineDependencyResolutionError(e)).toBe(true);
  });
});
