import { expect, test } from "bun:test";
import { assetNameFor, assetUrl, SUPPORTED_TARGETS } from "./release-assets.ts";

test("linux x64 asset name carries the version", () => {
  expect(assetNameFor({ os: "linux", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-linux-amd64-v2.2.0.tar.gz",
  );
});

test("macOS and Windows asset names are unversioned", () => {
  expect(assetNameFor({ os: "darwin", arch: "arm64" }, "2.2.0")).toBe(
    "nimbus-headless-macos-arm64.tar.gz",
  );
  expect(assetNameFor({ os: "darwin", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-macos-x64.tar.gz",
  );
  expect(assetNameFor({ os: "win32", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-windows-x64.zip",
  );
});

test("linux arm64 is not published and must fail loudly", () => {
  expect(() => assetNameFor({ os: "linux", arch: "arm64" }, "2.2.0")).toThrow(
    /no Linux arm64 build is published/,
  );
});

// The whole point of the review's finding #2: a pinned version must be honoured
// on EVERY platform, including the ones whose asset name has no version in it.
test("every supported target resolves under the tag-pinned base", () => {
  for (const target of SUPPORTED_TARGETS) {
    const url = assetUrl("nimbus-agent/Nimbus", "v2.1.0", assetNameFor(target, "2.1.0"));
    expect(url).toStartWith("https://github.com/nimbus-agent/Nimbus/releases/download/v2.1.0/");
    expect(url).not.toContain("/releases/latest/");
  }
});
