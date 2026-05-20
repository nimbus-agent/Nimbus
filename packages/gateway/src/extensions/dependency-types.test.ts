import { describe, expect, it } from "bun:test";
import type {
  DependencyConflict,
  InstallPlan,
  ResolveClosureOptions,
  ResolvedNode,
} from "./dependency-types.ts";

describe("dependency types", () => {
  it("ResolvedNode shape", () => {
    const node: ResolvedNode = {
      id: "com.example.foo",
      version: "1.0.0",
      newlyInstalled: true,
      deps: [{ id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" }],
    };
    expect(node.deps).toHaveLength(1);
  });

  it("ResolveClosureOptions activeConstraints is nested map", () => {
    const opts: ResolveClosureOptions = {
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      activeConstraints: new Map([["com.example.bar", new Map([["com.shared.utils", "^1.0.0"]])]]),
    };
    expect(opts.activeConstraints.get("com.example.bar")?.get("com.shared.utils")).toBe("^1.0.0");
  });

  it("DependencyConflict supports cycle + unsatisfiable variants", () => {
    const cycle: DependencyConflict = {
      kind: "cycle",
      id: "com.example.a",
      chain: ["com.example.a", "com.example.b", "com.example.a"],
    };
    const conflict: DependencyConflict = {
      kind: "unsatisfiable",
      id: "com.shared.utils",
      constraints: [
        { from: "com.example.foo", range: "^2.0.0" },
        { from: "com.example.bar", range: "^1.0.0" },
      ],
    };
    expect(cycle.chain).toHaveLength(3);
    expect(conflict.constraints).toHaveLength(2);
  });

  it("InstallPlan nodes is readonly array of ResolvedNode", () => {
    const plan: InstallPlan = { nodes: [] };
    expect(plan.nodes).toHaveLength(0);
  });
});
