// packages/cli/src/commands/prove-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatProveResult } from "./prove.ts";

const COVERED = {
  coverage: { task: "per-call", session: "none", sync: "none", model: "none", peer: "none" },
  outboundEgressEvents: 0,
  indeterminate: false,
} as const;

describe("formatProveResult", () => {
  test("a zero window never prints a bare 0 — it names what was observed", () => {
    const out = formatProveResult({ delta: 0, completeness: COVERED, chainOk: true });
    // Assert the whole first line, not just that a "0" appears somewhere: the defect being fixed
    // is a count printed WITHOUT its scope, so the scope must be on the same line as the number.
    expect(out.split("\n")[0]).toBe(
      "outbound egress events during this query: 0 (scope: gated connector actions)",
    );
    expect(out).toContain("not observed: model, peer, session, sync");
  });

  test("an indeterminate window reports indeterminate, never zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: { ...COVERED, indeterminate: true },
      chainOk: true,
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });

  test("a broken chain reports indeterminate even when the count is zero", () => {
    const out = formatProveResult({ delta: 0, completeness: COVERED, chainOk: false });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });
});
