import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ageHours,
  type ChannelReading,
  compareSemver,
  decideExit,
  evaluateTrain,
  loadTrainManifest,
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

const ch = (over: Partial<ChannelReading>): ChannelReading => ({
  kind: "brew",
  status: "read",
  version: null,
  covered: null,
  ...over,
});

describe("evaluateTrain", () => {
  const green = {
    name: "t",
    intended: "0.26.0",
    intendedBumpAgeHours: 48,
    published: { version: "0.26.0", publishedAt: "x" },
    publishedAgeHours: 48,
    graceHours: 6,
  };

  test("all heads equal + channels current => all ok", () => {
    const r = evaluateTrain({
      ...green,
      channels: [
        ch({ kind: "brew", version: "0.26.0" }),
        ch({ kind: "scoop", version: "0.26.0" }),
        ch({ kind: "linux", version: "0.26.0" }),
        ch({ kind: "winget", version: null, covered: true }),
      ],
    });
    expect(r.every((e) => e.verdict === "ok")).toBe(true);
  });

  test("channel behind published, past grace => stale", () => {
    const r = evaluateTrain({ ...green, channels: [ch({ kind: "brew", version: "0.25.0" })] });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("stale");
  });

  test("channel behind published but within grace => ok", () => {
    const r = evaluateTrain({
      ...green,
      publishedAgeHours: 2,
      channels: [ch({ kind: "brew", version: "0.25.0" })],
    });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("ok");
  });

  test("manifest ahead of published + aged bump => phantom", () => {
    const r = evaluateTrain({
      ...green,
      intended: "0.27.0",
      published: { version: "0.26.0", publishedAt: "x" },
      channels: [],
    });
    expect(r.find((e) => e.edge === "t:phantom")?.verdict).toBe("phantom");
  });

  test("manifest ahead but bump within grace => ok (build window)", () => {
    const r = evaluateTrain({
      ...green,
      intended: "0.27.0",
      intendedBumpAgeHours: 1,
      published: { version: "0.26.0", publishedAt: "x" },
      channels: [],
    });
    expect(r.find((e) => e.edge === "t:phantom")?.verdict).toBe("ok");
  });

  test("winget not covered, past grace => stale", () => {
    const r = evaluateTrain({
      ...green,
      channels: [ch({ kind: "winget", version: null, covered: false })],
    });
    expect(r.find((e) => e.edge === "t:winget")?.verdict).toBe("stale");
  });

  test("transient channel read => indeterminate, never stale", () => {
    const r = evaluateTrain({
      ...green,
      channels: [ch({ kind: "brew", status: "indeterminate" })],
    });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("indeterminate");
  });

  test("absent channel file, past grace => stale", () => {
    const r = evaluateTrain({ ...green, channels: [ch({ kind: "brew", status: "absent" })] });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("stale");
  });

  test("unparseable channel version => indeterminate, never a crash", () => {
    const r = evaluateTrain({
      ...green,
      channels: [ch({ kind: "brew", version: "not-a-version" })],
    });
    expect(r.find((e) => e.edge === "t:brew")?.verdict).toBe("indeterminate");
  });

  test("unparseable manifest version => phantom edge indeterminate, never a crash", () => {
    const r = evaluateTrain({ ...green, intended: "not-a-version", channels: [] });
    expect(r.find((e) => e.edge === "t:phantom")?.verdict).toBe("indeterminate");
  });
});

describe("decideExit", () => {
  test("a stale or phantom edge => exit 1 with ::error::", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "stale", detail: "d" }], true);
    expect(out.code).toBe(1);
    expect(out.messages.join("\n")).toContain("::error::");
  });
  test("only ok + indeterminate => exit 0 with a warning", () => {
    const out = decideExit(
      [
        { edge: "t:brew", verdict: "ok", detail: "d" },
        { edge: "t:scoop", verdict: "indeterminate", detail: "d" },
      ],
      true,
    );
    expect(out.code).toBe(0);
    expect(out.messages.join("\n")).toContain("::warning::");
  });
  test("everything indeterminate under --strict => exit 1 (not 'all clear')", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "indeterminate", detail: "d" }], true);
    expect(out.code).toBe(1);
  });
  test("everything indeterminate when NOT strict => exit 0 (soft)", () => {
    const out = decideExit([{ edge: "t:brew", verdict: "indeterminate", detail: "d" }], false);
    expect(out.code).toBe(0);
  });
});

describe("ageHours", () => {
  test("a valid past timestamp yields a finite non-negative age", () => {
    const h = ageHours("2020-01-01T00:00:00Z");
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });
  test("an unparseable timestamp fails closed to +Infinity", () => {
    expect(ageHours("not-a-date")).toBe(Number.POSITIVE_INFINITY);
  });
  test("a timestamp with no timezone fails closed rather than being read as local", () => {
    expect(ageHours("2026-07-26T12:00:00")).toBe(Number.POSITIVE_INFINITY);
  });
  test("an explicit numeric offset is accepted", () => {
    expect(Number.isFinite(ageHours("2020-01-01T00:00:00+02:00"))).toBe(true);
  });
});

describe("loadTrainManifest", () => {
  test("parses graceHours + trains", () => {
    const m = loadTrainManifest(
      '{"graceHours":6,"trains":[{"name":"x","source":{"manifestRepo":"a/b","manifestFile":"m.json","manifestKey":".","releaseAsset":"S"},"channels":[]}]}',
    );
    expect(m.graceHours).toBe(6);
    expect(m.trains[0]?.name).toBe("x");
  });
  test("throws on a malformed manifest", () => {
    expect(() => loadTrainManifest("{}")).toThrow();
  });
  test("the committed .github/release-train.json is valid", () => {
    const raw = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "release-train.json"),
      "utf8",
    );
    const m = loadTrainManifest(raw);
    expect(m.trains.length).toBeGreaterThan(0);
    expect(m.trains[0]?.channels.some((c) => c.kind === "winget")).toBe(true);
  });
  test("parses packages[] with consumers", () => {
    const m = loadTrainManifest(
      '{"graceHours":6,"trains":[],"packages":[{"name":"sdk","npm":"@x/sdk","repo":"o/r","tagPattern":"^sdk-v(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)$","consumers":[{"repo":"o/c","lockfile":"bun.lock"}]}]}',
    );
    expect(m.packages[0]?.name).toBe("sdk");
    expect(m.packages[0]?.consumers[0]?.lockfile).toBe("bun.lock");
  });
  test("throws when packages is present but not an array", () => {
    expect(() => loadTrainManifest('{"graceHours":6,"trains":[],"packages":{}}')).toThrow();
  });
  test("the committed manifest declares both packages with a capture-group tagPattern", () => {
    const raw = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "release-train.json"),
      "utf8",
    );
    const m = loadTrainManifest(raw);
    expect(m.packages.map((p) => p.name).sort()).toEqual(["client", "sdk"]);
    for (const p of m.packages) {
      expect(p.tagPattern).toContain("(");
      expect(p.consumers.length).toBeGreaterThan(0);
    }
  });
});
