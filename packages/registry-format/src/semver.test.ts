import { describe, expect, test } from "bun:test";
import { isValidSemver } from "./semver.ts";

describe("isValidSemver (strict SemVer 2.0.0)", () => {
  test.each([
    "0.0.0",
    "1.2.3",
    "10.20.30",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.0.0-x-y-z.--",
    "1.0.0-0a",
    "1.0.0-a-b",
    "1.0.0--",
    "1.0.0+20130313144700",
    "1.0.0+001",
    "1.0.0-beta+exp.sha.5114f85",
    "1.0.0-rc.1+build.1-x",
  ])("accepts %p", (v) => {
    expect(isValidSemver(v)).toBe(true);
  });

  test.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3\n",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3-alpha.",
    "1.2.3+build..1",
    "1.2.3+a+b",
    "1.2.3-a_b",
    "1.2.3+a_b",
    "1.2.3-α",
    "1.2.-3",
    "-1.2.3",
    "^1.2.3",
    "1.2.x",
  ])("refuses %p", (v) => {
    expect(isValidSemver(v)).toBe(false);
  });
});
