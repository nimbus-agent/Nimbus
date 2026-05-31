import { describe, expect, test } from "bun:test";
import { derivePlatformTarget } from "./platform-target.ts";

describe("derivePlatformTarget", () => {
  test("darwin + x64 → darwin-x86_64", () => {
    expect(derivePlatformTarget("darwin", "x64")).toBe("darwin-x86_64");
  });

  test("darwin + arm64 → darwin-aarch64", () => {
    expect(derivePlatformTarget("darwin", "arm64")).toBe("darwin-aarch64");
  });

  test("linux + x64 → linux-x86_64", () => {
    expect(derivePlatformTarget("linux", "x64")).toBe("linux-x86_64");
  });

  test("win32 + x64 → windows-x86_64", () => {
    expect(derivePlatformTarget("win32", "x64")).toBe("windows-x86_64");
  });

  test("linux + arm64 → undefined (linux-aarch64 deferred)", () => {
    expect(derivePlatformTarget("linux", "arm64")).toBeUndefined();
  });

  test("win32 + arm64 → undefined (Copilot+/WoA deferred — needs PlatformTarget union update + manifest schema + Windows ARM build target)", () => {
    expect(derivePlatformTarget("win32", "arm64")).toBeUndefined();
  });

  test("freebsd + x64 → undefined (no FreeBSD release)", () => {
    expect(derivePlatformTarget("freebsd", "x64")).toBeUndefined();
  });

  test("with no arguments uses process.platform + process.arch (smoke)", () => {
    const result = derivePlatformTarget();
    if (result !== undefined) {
      expect(["darwin-x86_64", "darwin-aarch64", "linux-x86_64", "windows-x86_64"]).toContain(
        result,
      );
    }
  });
});
