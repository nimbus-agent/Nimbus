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
    expect(out).toMatch(/com\.shared\.crypto@2\.4\.1/);
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
    expect(out.split("\n")).toEqual(["com.a@1.0.0", "com.b@1.0.0"]);
  });

  it("roots render in deterministic locale order regardless of input order (S2871)", () => {
    const out = renderTree([
      { id: "com.zebra", version: "1.0.0", forwardDeps: [] },
      { id: "com.alpha", version: "1.0.0", forwardDeps: [] },
      { id: "com.mango", version: "1.0.0", forwardDeps: [] },
    ]);
    expect(out.split("\n")).toEqual(["com.alpha@1.0.0", "com.mango@1.0.0", "com.zebra@1.0.0"]);
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
    expect(lines[0]).toBe("a@1.0.0");
    expect(lines[1]).toContain("└─ b@2.0.0");
    expect(lines[2]).toContain("└─ c@3.0.0");
  });

  it("diamond dependency marks second occurrence as already shown", () => {
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
    const occurrences = [...out.matchAll(/shared@1\.0\.0/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(out).toMatch(/shared@1\.0\.0\s+\(already shown\)/);
  });
});
