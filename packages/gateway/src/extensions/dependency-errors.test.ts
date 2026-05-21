import { describe, expect, it } from "bun:test";
import {
  DependencyConflictError,
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
  isReverseDepBlockedError,
  OfflineDependencyResolutionError,
  ReverseDepBlockedError,
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

describe("ReverseDepBlockedError", () => {
  it("carries target + blockers and encodes them in the message", () => {
    const e = new ReverseDepBlockedError({
      target: "com.shared.A",
      blockers: [{ id: "com.example.B", range: "^1.0.0" }],
    });
    expect(e.name).toBe("ReverseDepBlockedError");
    expect(e.target).toBe("com.shared.A");
    expect(e.blockers).toHaveLength(1);
    expect(e.blockers[0]?.id).toBe("com.example.B");
    expect(e.blockers[0]?.range).toBe("^1.0.0");
    expect(e.message).toContain("reverse_dep_blocked");
    expect(e.message).toContain("com.shared.A");
    expect(e.message).toContain("1"); // blocker count
  });

  it("narrows via isReverseDepBlockedError", () => {
    const e: unknown = new ReverseDepBlockedError({
      target: "com.shared.A",
      blockers: [{ id: "com.example.B", range: "^1.0.0" }],
    });
    expect(isReverseDepBlockedError(e)).toBe(true);
    expect(isReverseDepBlockedError(new Error("other"))).toBe(false);
    expect(isReverseDepBlockedError("not an error")).toBe(false);
  });

  it("handles multiple blockers", () => {
    const e = new ReverseDepBlockedError({
      target: "com.shared.core",
      blockers: [
        { id: "com.example.alpha", range: "^2.0.0" },
        { id: "com.example.beta", range: "~3.1.0" },
      ],
    });
    expect(e.blockers).toHaveLength(2);
    expect(e.message).toContain("2");
  });
});
