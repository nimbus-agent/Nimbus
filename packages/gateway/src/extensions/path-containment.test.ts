import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isStrictlyInside } from "./path-containment.ts";

describe("isStrictlyInside (win32 rules)", () => {
  const w = path.win32;
  test("a child is inside; the root itself and a sibling are not", () => {
    expect(isStrictlyInside("C:\\stage\\m-1", "C:\\stage\\m-1\\dist\\index.js", w)).toBe(true);
    expect(isStrictlyInside("C:\\stage\\m-1", "C:\\stage\\m-1", w)).toBe(false);
    expect(isStrictlyInside("C:\\stage\\m-1", "C:\\stage\\m-2\\x", w)).toBe(false);
    expect(isStrictlyInside("C:\\stage\\m-1", "C:\\stage\\m-1\\..\\x", w)).toBe(false);
  });

  test("a path on another drive is not inside", () => {
    expect(isStrictlyInside("C:\\stage\\m-1", "D:\\x", w)).toBe(false);
    expect(isStrictlyInside("C:\\stage\\m-1", "D:\\stage\\m-1\\x", w)).toBe(false);
  });

  test("a UNC path is not inside a drive path", () => {
    expect(isStrictlyInside("C:\\stage\\m-1", "\\\\server\\share\\x", w)).toBe(false);
  });

  test("the comparison ignores case on win32", () => {
    expect(isStrictlyInside("C:\\Stage\\M-1", "c:\\stage\\m-1\\X", w)).toBe(true);
    expect(isStrictlyInside("C:\\Stage\\M-1", "c:\\stage\\m-2\\X", w)).toBe(false);
  });
});

describe("isStrictlyInside (posix rules)", () => {
  const p = path.posix;
  test("case matters and parents are refused", () => {
    expect(isStrictlyInside("/stage/m-1", "/stage/m-1/a", p)).toBe(true);
    expect(isStrictlyInside("/stage/m-1", "/Stage/m-1/a", p)).toBe(false);
    expect(isStrictlyInside("/stage/m-1", "/stage", p)).toBe(false);
    expect(isStrictlyInside("/stage/m-1", "/stage/m-1/../m-2", p)).toBe(false);
  });
});
