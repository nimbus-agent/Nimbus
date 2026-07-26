import { describe, expect, test } from "bun:test";

import { classifyReadFailure, isStrict, parseHttpStatus, strictSkip } from "./_gh-audit.ts";

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

describe("parseHttpStatus", () => {
  test("extracts the status from gh's '(HTTP NNN)' stderr", () => {
    expect(parseHttpStatus("gh: Not Found (HTTP 404)")).toBe(404);
    expect(parseHttpStatus("gh: Server Error (HTTP 500)")).toBe(500);
    expect(parseHttpStatus("API rate limit exceeded (HTTP 403)")).toBe(403);
  });
  test("returns undefined when no HTTP status is present", () => {
    expect(parseHttpStatus("some other failure")).toBeUndefined();
    expect(parseHttpStatus("")).toBeUndefined();
  });
});

describe("classifyReadFailure", () => {
  test("404 is a genuine absence", () => {
    expect(classifyReadFailure(404)).toBe("absent");
  });
  test("5xx / 403 / unknown are indeterminate (transient), never absent", () => {
    expect(classifyReadFailure(500)).toBe("indeterminate");
    expect(classifyReadFailure(403)).toBe("indeterminate");
    expect(classifyReadFailure(undefined)).toBe("indeterminate");
  });
});
