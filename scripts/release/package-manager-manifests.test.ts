import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuildOptions,
  buildManifestsToDir,
  type ManifestInputs,
  parseSha256Sums,
  renderHomebrewFormula,
  renderScoopManifest,
} from "./package-manager-manifests.ts";

const INPUTS: ManifestInputs = {
  version: "0.1.0",
  repo: "nimbus-agent/Nimbus",
  assets: {
    macArm64Sha256: "a".repeat(64),
    macX64Sha256: "b".repeat(64),
    linuxX64Sha256: "c".repeat(64),
    winX64Sha256: "d".repeat(64),
  },
};

describe("parseSha256Sums", () => {
  test("parses `<hash>  <filename>` lines into a filename→hash map", () => {
    const text = [
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  nimbus-headless-macos-arm64.tar.gz",
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  nimbus-headless-windows-x64.zip",
      "",
    ].join("\n");
    const map = parseSha256Sums(text);
    expect(map.get("nimbus-headless-macos-arm64.tar.gz")).toBe(
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    );
    expect(map.get("nimbus-headless-windows-x64.zip")).toBe(
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    );
  });
  test("tolerates single-space separators and ignores blank lines", () => {
    const map = parseSha256Sums(
      "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333 file.tar.gz\n\n",
    );
    expect(map.get("file.tar.gz")).toBe(
      "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333",
    );
  });
});

describe("renderHomebrewFormula", () => {
  const rb = renderHomebrewFormula(INPUTS);
  test("declares class Nimbus and version 0.1.0", () => {
    expect(rb).toContain("class Nimbus < Formula");
    expect(rb).toContain('version "0.1.0"');
  });
  test("uses the macOS arm64 + x64 release URLs and their sha256", () => {
    expect(rb).toContain(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-macos-arm64.tar.gz",
    );
    expect(rb).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(rb).toContain(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-macos-x64.tar.gz",
    );
    expect(rb).toContain(`sha256 "${"b".repeat(64)}"`);
  });
  test("supports Homebrew on Linux x64", () => {
    expect(rb).toContain("nimbus-headless-linux-amd64-v0.1.0.tar.gz");
    expect(rb).toContain(`sha256 "${"c".repeat(64)}"`);
  });
  test("installs both binaries and has a version smoke test", () => {
    expect(rb).toContain('bin.install "nimbus"');
    expect(rb).toContain('bin.install "nimbus-gateway"');
    expect(rb).toContain("--version");
  });
});

describe("renderScoopManifest", () => {
  const json = renderScoopManifest(INPUTS);
  const parsed = JSON.parse(json) as {
    version: string;
    architecture: { "64bit": { url: string; hash: string } };
    bin: string[];
    checkver: unknown;
    autoupdate: unknown;
  };
  test("is valid JSON with version + windows url + hash", () => {
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.architecture["64bit"].url).toBe(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-windows-x64.zip",
    );
    expect(parsed.architecture["64bit"].hash).toBe("d".repeat(64));
  });
  test("exposes both executables on PATH", () => {
    expect(parsed.bin).toEqual(["nimbus.exe", "nimbus-gateway.exe"]);
  });
  test("includes checkver + autoupdate for Scoop self-bumping", () => {
    expect(parsed.checkver).toBeDefined();
    expect(parsed.autoupdate).toBeDefined();
  });
  test("autoupdate URL keeps the LITERAL $version token (Scoop substitutes it, not us)", () => {
    const auto = parsed.autoupdate as { architecture: { "64bit": { url: string } } };
    expect(auto.architecture["64bit"].url).toContain("/download/v$version/");
    expect(auto.architecture["64bit"].url).not.toContain("/download/v0.1.0/");
  });
});

describe("buildManifestsToDir", () => {
  test("writes nimbus.rb + nimbus.json resolving hashes from SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mf-"));
    try {
      const sums = [
        `${"a".repeat(64)}  nimbus-headless-macos-arm64.tar.gz`,
        `${"b".repeat(64)}  nimbus-headless-macos-x64.tar.gz`,
        `${"c".repeat(64)}  nimbus-headless-linux-amd64-v0.1.0.tar.gz`,
        `${"d".repeat(64)}  nimbus-headless-windows-x64.zip`,
      ].join("\n");
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(sumsPath, sums, "utf8");
      const opts: BuildOptions = {
        version: "0.1.0",
        repo: "nimbus-agent/Nimbus",
        sha256SumsPath: sumsPath,
        outDir: dir,
      };
      const written = buildManifestsToDir(opts);
      expect(written.formulaPath.endsWith("nimbus.rb")).toBe(true);
      expect(written.scoopPath.endsWith("nimbus.json")).toBe(true);
      expect(readFileSync(written.formulaPath, "utf8")).toContain(`sha256 "${"a".repeat(64)}"`);
      const scoop = JSON.parse(readFileSync(written.scoopPath, "utf8")) as {
        architecture: { "64bit": { hash: string } };
      };
      expect(scoop.architecture["64bit"].hash).toBe("d".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("throws a clear error if a required asset is missing from SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mf-"));
    try {
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(
        sumsPath,
        `${[
          `${"a".repeat(64)}  nimbus-headless-macos-arm64.tar.gz`,
          `${"b".repeat(64)}  nimbus-headless-macos-x64.tar.gz`,
          `${"c".repeat(64)}  nimbus-headless-linux-amd64-v0.1.0.tar.gz`,
        ].join("\n")}\n`,
        "utf8",
      );
      expect(() =>
        buildManifestsToDir({
          version: "0.1.0",
          repo: "nimbus-agent/Nimbus",
          sha256SumsPath: sumsPath,
          outDir: dir,
        }),
      ).toThrow(/nimbus-headless-windows-x64\.zip/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the output directory if it does not yet exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mf-"));
    try {
      const sums = [
        `${"a".repeat(64)}  nimbus-headless-macos-arm64.tar.gz`,
        `${"b".repeat(64)}  nimbus-headless-macos-x64.tar.gz`,
        `${"c".repeat(64)}  nimbus-headless-linux-amd64-v0.1.0.tar.gz`,
        `${"d".repeat(64)}  nimbus-headless-windows-x64.zip`,
      ].join("\n");
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(sumsPath, sums, "utf8");
      // outDir is a not-yet-existing nested path under the temp dir.
      const outDir = join(dir, "nested", "out");
      const written = buildManifestsToDir({
        version: "0.1.0",
        repo: "nimbus-agent/Nimbus",
        sha256SumsPath: sumsPath,
        outDir,
      });
      expect(readFileSync(written.formulaPath, "utf8")).toContain("class Nimbus < Formula");
      expect(readFileSync(written.scoopPath, "utf8")).toContain("nimbus.exe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
