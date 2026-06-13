import { describe, expect, test } from "bun:test";
import {
  msiAssetSha256,
  msiReleaseUrl,
  WINGET_MSI_ASSET,
  WINGET_PACKAGE_IDENTIFIER,
} from "./winget-manifest.ts";

// A minimal GNU-coreutils SHA256SUMS sample (hash + two spaces + filename).
const SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless-linux-amd64-v1.2.3.tar.gz",
  "2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-windows-x64.msi",
  "3333333333333333333333333333333333333333333333333333333333333333  nimbus-headless-windows-x64.zip",
  "",
].join("\n");

describe("winget-manifest", () => {
  test("PackageIdentifier is the confirmed NimbusAgent.Nimbus", () => {
    expect(WINGET_PACKAGE_IDENTIFIER).toBe("NimbusAgent.Nimbus");
  });

  test("WINGET_MSI_ASSET is the Slice-2 Windows installer filename", () => {
    expect(WINGET_MSI_ASSET).toBe("nimbus-headless-windows-x64.msi");
  });

  test("msiReleaseUrl points at the released .msi, normalizing a leading v", () => {
    const expected =
      "https://github.com/nimbus-agent/Nimbus/releases/download/v1.2.3/nimbus-headless-windows-x64.msi";
    expect(msiReleaseUrl("nimbus-agent/Nimbus", "1.2.3")).toBe(expected);
    expect(msiReleaseUrl("nimbus-agent/Nimbus", "v1.2.3")).toBe(expected);
  });

  test("msiAssetSha256 extracts the .msi hash from SHA256SUMS", () => {
    expect(msiAssetSha256(SUMS)).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("msiAssetSha256 throws if the .msi is missing (never submit a guessed hash)", () => {
    const noMsi = "4444444444444444444444444444444444444444444444444444444444444444  other.zip";
    expect(() => msiAssetSha256(noMsi)).toThrow(WINGET_MSI_ASSET);
  });
});
