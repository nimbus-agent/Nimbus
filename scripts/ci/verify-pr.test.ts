// scripts/ci/verify-pr.test.ts
import { describe, expect, test } from "bun:test";
import { evaluatePrState, parseGhOutput } from "./verify-pr.ts";

describe("evaluatePrState", () => {
  test("CONFLICTING is reported as suppressed CI, not as passing checks", () => {
    const v = evaluatePrState({ mergeable: "CONFLICTING", checks: [{ name: "a", state: "pass" }] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/suppress/i);
  });

  test("a failing check is not green", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [{ name: "x", state: "fail" }] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toContain("x");
  });

  test("pending is not green — not-yet-failed is not passed", () => {
    const v = evaluatePrState({
      mergeable: "MERGEABLE",
      checks: [{ name: "y", state: "pending" }],
    });
    expect(v.green).toBe(false);
    // Pin the REASON, not just the verdict: a pending check must be reported as still running,
    // never folded into the generic failure text. Without this the test passes against an
    // implementation that mislabels every unrecognised state as a failure.
    expect(v.reasons.join(" ")).toContain("y");
    expect(v.reasons.join(" ")).toMatch(/pending/i);
  });

  test("all pass + mergeable is green", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [{ name: "a", state: "pass" }] });
    expect(v.green).toBe(true);
  });

  test("a skipped check is not green — skipped is not passed", () => {
    const v = evaluatePrState({
      mergeable: "MERGEABLE",
      checks: [{ name: "z", state: "skipping" }],
    });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toContain("z");
  });

  test("zero checks is not green — absent is not evidence of passing", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/no checks/i);
  });

  test("an unresolved mergeable state (neither MERGEABLE nor CONFLICTING) is not green", () => {
    // gh reports "UNKNOWN" while the mergeability check hasn't completed yet — this is the
    // real shape returned for a MERGED pr (#1038), so this must not crash and must not report green.
    const v = evaluatePrState({ mergeable: "UNKNOWN", checks: [{ name: "a", state: "pass" }] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/UNKNOWN/);
  });

  test("multiple failures are all reported, not just the first", () => {
    const v = evaluatePrState({
      mergeable: "MERGEABLE",
      checks: [
        { name: "a", state: "fail" },
        { name: "b", state: "fail" },
      ],
    });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toContain("a");
    expect(v.reasons.join(" ")).toContain("b");
  });
});

describe("parseGhOutput", () => {
  test("a non-zero exit throws with the captured stderr, never a raw JSON.parse crash", () => {
    expect(() => parseGhOutput("pr view", 1, "", "HTTP 401: Bad credentials")).toThrow(
      /Bad credentials/,
    );
  });

  test("human-readable non-JSON stdout on a zero exit throws a clear message, not a SyntaxError", () => {
    expect(() =>
      parseGhOutput("pr view", 0, 'no pull requests found for branch "dev/x"', ""),
    ).toThrow(/non-JSON output/);
  });

  test("valid JSON on a zero exit parses through", () => {
    expect(parseGhOutput("pr view", 0, '{"mergeable":"MERGEABLE"}', "")).toEqual({
      mergeable: "MERGEABLE",
    });
  });

  test("a non-zero exit with empty stderr still throws (never silently swallowed)", () => {
    expect(() => parseGhOutput("pr checks", 1, "", "")).toThrow(/no output/);
  });
});
