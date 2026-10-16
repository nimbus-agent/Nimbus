import { describe, expect, test } from "bun:test";

import { findProtectedOverlap, isSameOrInside, pathsOverlap } from "./path-overlap.ts";

const identity = (p: string): string => p;

describe("isSameOrInside", () => {
  test("posix: same, inside, and a sibling that only shares a prefix", () => {
    expect(isSameOrInside("linux", "/a/b", "/a/b")).toBe(true);
    expect(isSameOrInside("linux", "/a/b/c", "/a/b")).toBe(true);
    expect(isSameOrInside("linux", "/a/bc", "/a/b")).toBe(false);
    expect(isSameOrInside("linux", "/a", "/a/b")).toBe(false);
  });

  test("win32: case-insensitive, and a different drive is never inside", () => {
    expect(isSameOrInside("win32", "C:\\Users\\X\\Data\\f", "c:\\users\\x\\data")).toBe(true);
    expect(isSameOrInside("win32", "D:\\data", "C:\\data")).toBe(false);
  });
});

describe("pathsOverlap", () => {
  test("either direction counts", () => {
    expect(pathsOverlap("linux", "/home/u", "/home/u/.local/share/nimbus")).toBe(true);
    expect(
      pathsOverlap("linux", "/home/u/.local/share/nimbus/x", "/home/u/.local/share/nimbus"),
    ).toBe(true);
    expect(pathsOverlap("linux", "/srv/a", "/srv/b")).toBe(false);
  });
});

describe("findProtectedOverlap", () => {
  test("returns the configured root a candidate overlaps", () => {
    expect(findProtectedOverlap("/data/x", ["/cfg", "/data"], "linux", identity)).toBe("/data");
  });

  test("a parent of a protected root overlaps it", () => {
    expect(findProtectedOverlap("/", ["/data"], "linux", identity)).toBe("/data");
  });

  test("matches against the root's realpath too", () => {
    const realpath = (p: string): string => (p === "/link/data" ? "/real/data" : p);
    expect(findProtectedOverlap("/real/data/f", ["/link/data"], "linux", realpath)).toBe(
      "/link/data",
    );
  });

  test("a root that does not exist yet is compared by its spelling", () => {
    const realpath = (p: string): string => {
      throw new Error(`ENOENT ${p}`);
    };
    expect(findProtectedOverlap("/data/f", ["/data"], "linux", realpath)).toBe("/data");
    expect(findProtectedOverlap("/elsewhere", ["/data"], "linux", realpath)).toBeUndefined();
  });
});
