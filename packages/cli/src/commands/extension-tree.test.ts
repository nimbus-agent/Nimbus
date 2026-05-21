import { describe, expect, it } from "bun:test";
import { renderTree } from "./extension-tree.ts";

describe("renderTree", () => {
  it("emits a forest with leaf-last indentation", () => {
    const out = renderTree([
      {
        id: "com.example.foo",
        version: "1.0.0",
        forwardDeps: [
          { id: "com.shared.utils", range: "^1.0.0" },
          { id: "com.shared.crypto", range: "^2.0.0" },
        ],
      },
      {
        id: "com.shared.utils",
        version: "1.5.0",
        forwardDeps: [{ id: "com.shared.crypto", range: "^2.0.0" }],
      },
      {
        id: "com.shared.crypto",
        version: "2.4.1",
        forwardDeps: [],
      },
    ]);
    expect(out).toContain("com.example.foo@1.0.0");
    // crypto appears somewhere under foo's branch
    expect(out).toMatch(/com\.shared\.crypto@2\.4\.1/);
    // crypto's second appearance (inside utils' subtree) is suffixed
    expect(out).toMatch(/com\.shared\.crypto@2\.4\.1\s+\(already shown\)/);
  });

  it("empty input → empty string", () => {
    expect(renderTree([])).toBe("");
  });

  it("isolated extensions with no forward deps render as roots without indentation", () => {
    const out = renderTree([
      { id: "com.a", version: "1.0.0", forwardDeps: [] },
      { id: "com.b", version: "1.0.0", forwardDeps: [] },
    ]);
    // Both roots, each on its own line, alphabetical.
    expect(out.split("\n")).toEqual(["com.a@1.0.0", "com.b@1.0.0"]);
  });

  it("single extension with no deps renders as a single root line", () => {
    const out = renderTree([{ id: "com.solo", version: "0.1.0", forwardDeps: [] }]);
    expect(out).toBe("com.solo@0.1.0");
  });

  it("deep linear chain renders with correct connectors", () => {
    const out = renderTree([
      { id: "a", version: "1.0.0", forwardDeps: [{ id: "b", range: "*" }] },
      { id: "b", version: "2.0.0", forwardDeps: [{ id: "c", range: "*" }] },
      { id: "c", version: "3.0.0", forwardDeps: [] },
    ]);
    const lines = out.split("\n");
    // a is root (no connector)
    expect(lines[0]).toBe("a@1.0.0");
    // b is last child of a → └─
    expect(lines[1]).toContain("└─ b@2.0.0");
    // c is last child of b → └─ with deeper indent
    expect(lines[2]).toContain("└─ c@3.0.0");
  });

  it("diamond dependency marks second occurrence as already shown", () => {
    // shared is a dep of both left and right; root → left, right → shared
    const out = renderTree([
      {
        id: "root",
        version: "1.0.0",
        forwardDeps: [
          { id: "left", range: "*" },
          { id: "right", range: "*" },
        ],
      },
      { id: "left", version: "1.0.0", forwardDeps: [{ id: "shared", range: "*" }] },
      { id: "right", version: "1.0.0", forwardDeps: [{ id: "shared", range: "*" }] },
      { id: "shared", version: "1.0.0", forwardDeps: [] },
    ]);
    // shared should appear at least twice
    const occurrences = [...out.matchAll(/shared@1\.0\.0/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    // At least one occurrence is suffixed with (already shown)
    expect(out).toMatch(/shared@1\.0\.0\s+\(already shown\)/);
  });
});
