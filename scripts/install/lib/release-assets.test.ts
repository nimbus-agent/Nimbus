import { expect, test } from "bun:test";
import {
  assetNameFor,
  assetUrl,
  findSupportedTarget,
  SUPPORTED_TARGETS,
} from "./release-assets.ts";

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

test("findSupportedTarget resolves every published (os, arch) pair", () => {
  for (const target of SUPPORTED_TARGETS) {
    expect(findSupportedTarget(target.os, target.arch)).toEqual(target);
  }
});

/**
 * The two must agree exactly, or a caller that gates on `findSupportedTarget`
 * still reaches an `assetNameFor` that throws. Asserting BOTH halves per pair
 * is what makes this a lock rather than two independent checks: adding a target
 * to `SUPPORTED_TARGETS` without teaching `assetNameFor` about it fails here,
 * and so does the reverse.
 */
test("findSupportedTarget returns null for exactly the pairs assetNameFor rejects", () => {
  const oses = ["linux", "darwin", "win32", "freebsd"];
  const arches = ["x64", "arm64", "ia32"];
  let unsupported = 0;
  for (const os of oses) {
    for (const arch of arches) {
      const found = findSupportedTarget(os, arch);
      if (found !== null) {
        expect(() => assetNameFor(found, "2.2.0")).not.toThrow();
        continue;
      }
      unsupported++;
      // Cast: the point is that this pair is NOT a valid InstallTarget, and
      // assetNameFor must refuse it rather than return a name.
      expect(() => assetNameFor({ os, arch } as never, "2.2.0")).toThrow();
    }
  }
  // 12 combinations, 4 of them published — guards against the loop silently
  // testing nothing if the lists are edited.
  expect(unsupported).toBe(8);
});

// Windows arm64 is the pair that actually bit: it is a plausible dev machine,
// it is NOT published, and a guard that only special-cased Linux arm64 let it
// through into assetNameFor's throw.
test("windows arm64 and linux arm64 are both unsupported", () => {
  expect(findSupportedTarget("win32", "arm64")).toBeNull();
  expect(findSupportedTarget("linux", "arm64")).toBeNull();
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
