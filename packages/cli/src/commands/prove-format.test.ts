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
    const out = formatProveResult({
      delta: 0,
      completeness: COVERED,
      chainOk: true,
      label: "during this query",
    });
    // Assert the whole first line, not just that a "0" appears somewhere: the defect being fixed
    // is a count printed WITHOUT its scope, so the scope must be on the same line as the number.
    expect(out.split("\n")[0]).toBe(
      "outbound egress events during this query: 0 (scope: gated connector actions)",
    );
    expect(out).toContain("not observed: model, peer, session, sync");
  });

  // Fix wave: the label must be the caller-supplied scope, not a hardcoded "during this query" —
  // `nimbus egress`'s whole-window report is a different number over a different scope from
  // `nimbus prove`'s query delta, and printing both under an identical label was the defect.
  test("the printed label is exactly what the caller supplies, not hardcoded", () => {
    const out = formatProveResult({
      delta: 3,
      completeness: COVERED,
      chainOk: true,
      label: "in this window",
    });
    expect(out.split("\n")[0]).toBe(
      "outbound egress events in this window: 3 (scope: gated connector actions)",
    );
    expect(out).not.toContain("during this query");
  });

  // Fix wave: when MULTIPLE classes are observed (unreachable in Phase 1, since every non-task
  // class is hardcoded "none" — but the collapsing logic was wrong regardless), the scope line
  // must name every observed class, not collapse to just "gated connector actions" and silently
  // drop the others from both the scope line AND the "not observed" line.
  test("scope names every observed class when more than one is observed", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: {
        coverage: {
          task: "per-call",
          session: "per-run",
          sync: "none",
          model: "none",
          peer: "none",
        },
        outboundEgressEvents: 0,
        indeterminate: false,
      },
      chainOk: true,
      label: "during this query",
    });
    // `observed` is alphabetically sorted before mapping to display names, so "session" (< "task")
    // sorts ahead of the "gated connector actions" label task maps to.
    expect(out.split("\n")[0]).toBe(
      "outbound egress events during this query: 0 (scope: session, gated connector actions)",
    );
    expect(out).toContain("not observed: model, peer, sync");
  });

  test("an indeterminate window reports indeterminate, never zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: { ...COVERED, indeterminate: true },
      chainOk: true,
      label: "during this query",
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });

  test("a broken chain reports indeterminate even when the count is zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: COVERED,
      chainOk: false,
      label: "during this query",
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });
});
