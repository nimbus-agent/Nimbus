import { describe, expect, test } from "bun:test";
import { findCrossPlatformIssues } from "./check-cross-platform.ts";

describe("cross-platform audit detector (Windows-separator scope)", () => {
  test("flags a drive-letter absolute path in a toBe assertion", () => {
    const src = `expect(p).toBe("C:\\\\Users\\\\me\\\\data.db");\n`;
    const issues = findCrossPlatformIssues(src, "x.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]?.line).toBe(1);
  });

  test("flags a backslash-separated path in toContain", () => {
    const src = `expect(out).toContain("data\\\\nimbus.db");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(1);
  });

  test("flags a UNC path", () => {
    const src = `expect(p).toEqual("\\\\\\\\server\\\\share\\\\f.db");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(1);
  });

  test("ignores a line with the // cross-platform-ok escape hatch", () => {
    const src = `expect(p).toBe("C:\\\\tmp\\\\x.db"); // cross-platform-ok\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });

  test("ignores POSIX-absolute paths, URLs, and non-path strings (Windows-only scope)", () => {
    const src =
      `expect(u).toBe("https://api.example.com/v1/x");\n` +
      `expect(s).toBe("hello world");\n` +
      // POSIX data value — intentionally NOT flagged (regex can't tell it from a real bug)
      `expect(sock).toBe("/tmp/nimbus/data.sock");\n` +
      // URL/router route — intentionally NOT flagged
      `expect(route).toBe("/oauth/v2/authorize");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });
});
