import { describe, expect, test } from "bun:test";
import { checkVersionSkew, classify, floorOf, report } from "./check-connector-version-skew.ts";

describe("floorOf", () => {
  test.each([
    ["^0.1.1", "0.1.1"],
    ["~2.3.4", "2.3.4"],
    ["1.0.0", "1.0.0"],
    [" ^0.1.1 ", "0.1.1"],
  ])("%s -> %s", (range, want) => {
    expect(floorOf(range)).toBe(want);
  });

  // Anything this does not recognise must return undefined so the audit degrades to indeterminate.
  // Guessing a floor here would mean comparing a number nobody wrote.
  test.each(["*", "latest", ">=1.0.0 <2.0.0", "workspace:*", "npm:other@1.0.0", ""])(
    "%s is unrecognised",
    (range) => {
      expect(floorOf(range)).toBeUndefined();
    },
  );
});

describe("classify", () => {
  test("equal is ok", () => {
    expect(classify("0.1.1", "0.1.1").kind).toBe("ok");
  });

  // A release in flight pins the new version before it is published. Failing that would red every
  // PR between the bump and the publish.
  test("ahead of the registry is ok, not a failure", () => {
    expect(classify("0.2.0", "0.1.9").kind).toBe("ok");
  });

  test("a patch gap warns", () => {
    expect(classify("0.1.1", "0.1.4").kind).toBe("patch");
  });

  // A minor gap means a connector capability shipped that this gateway cannot load.
  test("a minor gap fails", () => {
    expect(classify("0.1.1", "0.2.0").kind).toBe("behind");
  });

  test("a major gap fails", () => {
    expect(classify("0.9.9", "1.0.0").kind).toBe("behind");
  });

  test("an unparseable version is indeterminate, not a failure", () => {
    expect(classify("0.1.1", "not-a-version").kind).toBe("indeterminate");
  });
});

describe("checkVersionSkew", () => {
  test("reads the real gateway pin and agrees with the registry shape", async () => {
    const skew = await checkVersionSkew(async () => "0.1.1");
    expect(skew.kind).toBe("ok");
  });

  test("detects a minor gap against the real pin", async () => {
    const skew = await checkVersionSkew(async () => "9.9.9");
    expect(skew.kind).toBe("behind");
  });

  // An unreachable registry must never fail this gate. Offline development and a registry outage
  // are not version skew, and a gate that reds for them is one people learn to ignore.
  test("an unreachable registry is indeterminate, not a failure", async () => {
    const skew = await checkVersionSkew(async () => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    });
    expect(skew.kind).toBe("indeterminate");
    if (skew.kind === "indeterminate") expect(skew.reason).toContain("registry unreachable");
  });
});

describe("report", () => {
  test("behind exits non-zero", () => {
    expect(report({ kind: "behind", pinned: "0.1.1", latest: "0.2.0" })).toBe(1);
  });

  // The three non-failing verdicts must all exit 0. A patch gap and an unreachable registry are
  // information, not grounds to red a PR.
  test.each([
    { kind: "ok", pinned: "0.1.1", latest: "0.1.1" } as const,
    { kind: "patch", pinned: "0.1.1", latest: "0.1.4" } as const,
    { kind: "indeterminate", reason: "registry unreachable: offline" } as const,
  ])("$kind exits zero", (skew) => {
    expect(report(skew)).toBe(0);
  });
});
