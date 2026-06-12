/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
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
