import { describe, expect, test } from "bun:test";

import {
  compareSemver,
  parseBrewVersion,
  parseLinuxVersion,
  parseScoopVersion,
  resolveWingetCoverage,
  selectPublished,
  wingetDirPath,
} from "./check-release-staleness.ts";

describe("parseBrewVersion", () => {
  test("reads version from a Formula .rb", () => {
    expect(parseBrewVersion('class Nimbus < Formula\n  version "0.26.0"\n  url "..."')).toBe(
      "0.26.0",
    );
  });
  test("null when absent", () => {
    expect(parseBrewVersion('class Nimbus < Formula\n  url "..."')).toBeNull();
  });
});

describe("parseScoopVersion", () => {
  test("reads .version from a scoop manifest", () => {
    expect(parseScoopVersion('{"version":"0.26.0","url":"x"}')).toBe("0.26.0");
  });
  test("null on malformed json or missing key", () => {
    expect(parseScoopVersion("{not json")).toBeNull();
    expect(parseScoopVersion('{"url":"x"}')).toBeNull();
  });
});

describe("parseLinuxVersion", () => {
  test("reads the Version: field from the nimbus-headless block", () => {
    const pkgs = "Package: nimbus-headless\nVersion: 0.26.0\nArchitecture: amd64\n";
    expect(parseLinuxVersion(pkgs)).toBe("0.26.0");
  });
  test("picks the nimbus-headless block, not another package that sorts first", () => {
    const pkgs =
      "Package: aardvark-tool\nVersion: 9.9.9\nArchitecture: amd64\n\n" +
      "Package: nimbus-headless\nVersion: 0.26.0\nArchitecture: amd64\n";
    expect(parseLinuxVersion(pkgs)).toBe("0.26.0");
  });
  test("strips a Debian epoch prefix and revision suffix to the core version", () => {
    const pkgs = "Package: nimbus-headless\nVersion: 1:0.26.0-1\nArchitecture: amd64\n";
    expect(parseLinuxVersion(pkgs)).toBe("0.26.0");
  });
  test("null when the package block is absent", () => {
    expect(parseLinuxVersion("Package: something-else\nVersion: 1.0.0\n")).toBeNull();
  });
});

describe("compareSemver", () => {
  test("orders valid versions (v-prefix tolerated)", () => {
    expect(compareSemver("v0.26.0", "0.25.0")).toBe(1);
    expect(compareSemver("0.25.0", "0.26.0")).toBe(-1);
    expect(compareSemver("0.26.0", "0.26.0")).toBe(0);
  });
  test("returns null (never throws) on an unparseable version", () => {
    expect(compareSemver("not-a-version", "0.26.0")).toBeNull();
    expect(compareSemver("0.26.0", "garbage")).toBeNull();
  });
});

describe("selectPublished", () => {
  const base = { draft: false, prerelease: false, publishedAt: "2026-07-01T00:00:00Z" };
  test("picks the highest stable tag whose SHA256SUMS asset exists", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.26.0", assets: ["SHA256SUMS"], publishedAt: "2026-07-10T00:00:00Z" },
      ],
      "SHA256SUMS",
    );
    expect(r).toEqual({ version: "0.26.0", publishedAt: "2026-07-10T00:00:00Z" });
  });
  test("skips a release missing the asset (asset-less phantom)", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.26.0", assets: [] },
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
      ],
      "SHA256SUMS",
    );
    expect(r?.version).toBe("0.25.0");
  });
  test("skips prereleases, drafts, and non-vX.Y.Z tags", () => {
    const r = selectPublished(
      [
        { ...base, tag: "v0.27.0-rc.1", prerelease: true, assets: ["SHA256SUMS"] },
        { ...base, tag: "sdk-v1.6.0", assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.26.0", draft: true, assets: ["SHA256SUMS"] },
        { ...base, tag: "v0.25.0", assets: ["SHA256SUMS"] },
      ],
      "SHA256SUMS",
    );
    expect(r?.version).toBe("0.25.0");
  });
  test("null when nothing qualifies", () => {
    expect(selectPublished([{ ...base, tag: "v0.26.0", assets: [] }], "SHA256SUMS")).toBeNull();
  });
});

describe("wingetDirPath", () => {
  test("derives the manifests path from a two-part package id", () => {
    expect(wingetDirPath("NimbusAgent.Nimbus", "0.26.0")).toBe(
      "manifests/n/NimbusAgent/Nimbus/0.26.0",
    );
  });
  test("maps every dot-segment to its own path segment (multi-part id)", () => {
    expect(wingetDirPath("Acme.Tools.Cli", "1.2.3")).toBe("manifests/a/Acme/Tools/Cli/1.2.3");
  });
});

describe("resolveWingetCoverage", () => {
  test("covered when the dir exists", () => {
    expect(resolveWingetCoverage(true, false)).toEqual({ status: "read", covered: true });
  });
  test("covered when an open PR exists", () => {
    expect(resolveWingetCoverage(false, true)).toEqual({ status: "read", covered: true });
  });
  test("genuinely not covered when both are known-false", () => {
    expect(resolveWingetCoverage(false, false)).toEqual({ status: "read", covered: false });
  });
  test("indeterminate when either signal is unknown and neither is true", () => {
    expect(resolveWingetCoverage(null, false)).toEqual({ status: "indeterminate", covered: false });
    expect(resolveWingetCoverage(false, null)).toEqual({ status: "indeterminate", covered: false });
  });
});
