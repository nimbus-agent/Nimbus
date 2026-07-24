import { describe, expect, test } from "bun:test";

import { isStrict, strictSkip } from "./_gh-audit.ts";

describe("isStrict", () => {
  test("false with neither flag nor env", () => {
    expect(isStrict([], {})).toBe(false);
  });
  test("true when --strict is passed", () => {
    expect(isStrict(["--strict"], {})).toBe(true);
  });
  test("true under GitHub Actions even without the flag", () => {
    expect(isStrict([], { GITHUB_ACTIONS: "true" })).toBe(true);
  });
});

describe("strictSkip", () => {
  test("soft skip (exit 0, ::warning::) when not strict", () => {
    const out = strictSkip("audit:x", false);
    expect(out.code).toBe(0);
    expect(out.message).toContain("::warning::");
    expect(out.message).toContain("skipped");
  });
  test("hard red (exit 1, ::error::) when strict", () => {
    const out = strictSkip("audit:x", true);
    expect(out.code).toBe(1);
    expect(out.message).toContain("::error::");
    expect(out.message).toContain("could not authenticate");
  });
  test("uses a gate-specific reason when provided (soft)", () => {
    const out = strictSkip(
      "audit:x",
      false,
      "reachability indeterminate — could not read all teams/repos",
    );
    expect(out.code).toBe(0);
    expect(out.message).toContain("::warning::");
    expect(out.message).toContain("reachability indeterminate");
    expect(out.message).not.toContain("gh unavailable");
  });
  test("uses a gate-specific reason when provided (strict)", () => {
    const out = strictSkip(
      "audit:x",
      true,
      "reachability indeterminate — could not read all teams/repos",
    );
    expect(out.code).toBe(1);
    expect(out.message).toContain("::error::");
    expect(out.message).toContain("reachability indeterminate");
  });
});
