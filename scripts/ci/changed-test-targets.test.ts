import { describe, expect, it } from "bun:test";

import { testTargetsFor } from "./changed-test-targets.ts";

/** Every candidate sibling "exists" — isolates the mapping rules from the filesystem. */
const allExist = () => true;
const noneExist = () => false;

describe("testTargetsFor", () => {
  it("runs a changed test file directly", () => {
    expect(testTargetsFor(["packages/gateway/src/a.test.ts"], noneExist)).toEqual([
      "packages/gateway/src/a.test.ts",
    ]);
  });

  it("maps a changed source file to its colocated sibling", () => {
    expect(testTargetsFor(["packages/gateway/src/egress/sink.ts"], allExist)).toEqual([
      "packages/gateway/src/egress/sink.test.ts",
    ]);
  });

  it("drops a source file whose sibling does not exist — never invents a path", () => {
    expect(testTargetsFor(["packages/gateway/src/egress/sink.ts"], noneExist)).toEqual([]);
  });

  it("normalises Windows separators before matching a root", () => {
    expect(testTargetsFor(["packages\\gateway\\src\\egress\\sink.ts"], allExist)).toEqual([
      "packages/gateway/src/egress/sink.test.ts",
    ]);
  });

  it("ignores files outside a colocated root", () => {
    expect(
      testTargetsFor(["docs/roadmap.md", "scripts/foo.ts", ".github/workflows/ci.yml"], allExist),
    ).toEqual([]);
  });

  it("ignores non-TypeScript files inside a colocated root", () => {
    expect(testTargetsFor(["packages/gateway/src/schema.sql"], allExist)).toEqual([]);
  });

  it("handles .tsx, keeping the extension on the sibling", () => {
    expect(testTargetsFor(["packages/cli/src/Panel.tsx"], allExist)).toEqual([
      "packages/cli/src/Panel.test.tsx",
    ]);
  });

  it("deduplicates when a source file and its test both changed", () => {
    const out = testTargetsFor(
      ["packages/gateway/src/a.ts", "packages/gateway/src/a.test.ts"],
      allExist,
    );
    expect(out).toEqual(["packages/gateway/src/a.test.ts"]);
  });

  it("returns a sorted list so the runner's output is stable", () => {
    const out = testTargetsFor(
      ["packages/gateway/src/z.test.ts", "packages/cli/src/a.test.ts"],
      allExist,
    );
    expect(out).toEqual(["packages/cli/src/a.test.ts", "packages/gateway/src/z.test.ts"]);
  });

  it("covers all three colocated roots", () => {
    const out = testTargetsFor(
      ["packages/gateway/src/a.ts", "packages/cli/src/b.ts", "packages/mcp-connectors/slack/c.ts"],
      allExist,
    );
    expect(out).toHaveLength(3);
  });

  it("an empty change set yields an empty list, never a whole-suite fallback", () => {
    expect(testTargetsFor([], allExist)).toEqual([]);
  });
});
