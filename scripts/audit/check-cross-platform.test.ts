import { describe, expect, test } from "bun:test";
import { findCrossPlatformIssues } from "./check-cross-platform.ts";

describe("cross-platform audit detector", () => {
  test("flags a hardcoded-separator path in a toBe assertion", () => {
    const src = `expect(p).toBe("/tmp/nimbus/data.db");\n`;
    const issues = findCrossPlatformIssues(src, "x.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]?.line).toBe(1);
  });

  test("flags a backslash path in toContain", () => {
    const src = `expect(out).toContain("data\\\\nimbus.db");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(1);
  });

  test("ignores a line with the // cross-platform-ok escape hatch", () => {
    const src = `expect(p).toBe("/tmp/x.db"); // cross-platform-ok\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });

  test("ignores URLs and non-path strings", () => {
    const src = `expect(u).toBe("https://api.example.com/v1/x");\nexpect(s).toBe("hello world");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });
});
