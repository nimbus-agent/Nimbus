import { describe, expect, test } from "bun:test";

import { validateAndNormalizePermissions } from "@nimbus-dev/registry-format";

import { observationFindings } from "./observation-findings.ts";

const row = (destination: string, port = 0, count = 1) => ({ destination, port, count });

describe("observationFindings", () => {
  test("Linux: an undeclared refused name is a finding naming it; count is distinct rows", () => {
    expect(
      observationFindings({
        os: "linux",
        declared: ["api.example.com"],
        refused: [row("evil.test", 0, 500), row("bad.test")],
        unmatched: [],
      }),
    ).toEqual({
      kind: "refused-undeclared",
      count: 2,
      destinations: [row("evil.test", 0, 500), row("bad.test")],
    });
  });

  test("Linux: a declared host refused is no finding (case, trailing dot, explicit port)", () => {
    for (const declared of ["api.example.com", "api.example.com:443", "API.Example.com."]) {
      expect(
        observationFindings({
          os: "linux",
          declared: [declared],
          refused: [row("Api.Example.com."), row("api.example.com")],
          unmatched: [],
        }),
      ).toBeNull();
    }
  });

  test("Linux: only the undeclared one of a mixed set is reported", () => {
    const f = observationFindings({
      os: "linux",
      declared: ["a.test:8443"],
      refused: [row("a.test"), row("b.test")],
      unmatched: [],
    });
    expect(f?.count).toBe(1);
    expect(f?.destinations).toEqual([row("b.test")]);
  });

  test("Windows and macOS: unmatched is a finding with a count and no names", () => {
    for (const os of ["win32", "darwin"] as const) {
      const f = observationFindings({
        os,
        declared: [],
        refused: [row("ignored.test")],
        unmatched: [row("1.2.3.4", 80), row("5.6.7.8", 443)],
      });
      expect(f).toEqual({ kind: "unmatched", count: 2 });
      expect(f).not.toHaveProperty("destinations");
    }
  });

  test("used-only, nothing, refused off Linux, and unmatched on Linux are all null", () => {
    expect(
      observationFindings({ os: "linux", declared: [], refused: [], unmatched: [row("x", 80)] }),
    ).toBeNull();
    expect(
      observationFindings({ os: "win32", declared: [], refused: [row("x")], unmatched: [] }),
    ).toBeNull();
  });
});

describe("extension manifests cannot declare wildcards", () => {
  test("the permissions validator refuses * entries", () => {
    for (const entry of ["*", "*.example.com", "*:443"]) {
      expect(() => validateAndNormalizePermissions({ network: [entry] })).toThrow();
    }
  });
});
