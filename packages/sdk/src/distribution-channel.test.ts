import { describe, expect, test } from "bun:test";
import { channelUpgradeHint, resolveDistributionChannel } from "./distribution-channel.ts";

describe("resolveDistributionChannel", () => {
  test("returns null for an ordinary install path with no env marker", () => {
    expect(
      resolveDistributionChannel({ env: {}, execPath: "/home/u/.local/bin/nimbus" }),
    ).toBeNull();
  });

  test("honors a valid NIMBUS_DISTRIBUTION_CHANNEL env marker", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "msi" },
        execPath: "/home/u/.local/bin/nimbus",
      }),
    ).toBe("msi");
  });

  test("ignores an unknown env marker value (fails closed to path detection)", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "bogus" },
        execPath: "/home/u/.local/bin/nimbus",
      }),
    ).toBeNull();
  });

  test("detects a macOS Homebrew Cellar path", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "/opt/homebrew/Cellar/nimbus/0.1.0/bin/nimbus",
      }),
    ).toBe("homebrew");
  });

  test("detects a Linuxbrew path", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "/home/linuxbrew/.linuxbrew/Cellar/nimbus/0.1.0/bin/nimbus-gateway",
      }),
    ).toBe("homebrew");
  });

  test("detects a Scoop apps path (Windows-style backslashes)", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "C:\\Users\\u\\scoop\\apps\\nimbus\\current\\nimbus.exe",
      }),
    ).toBe("scoop");
  });

  test("env marker wins over a conflicting path", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "homebrew" },
        execPath: "C:\\Users\\u\\scoop\\apps\\nimbus\\current\\nimbus.exe",
      }),
    ).toBe("homebrew");
  });

  test("resolves a Homebrew bin symlink to its Cellar target before matching", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "/opt/homebrew/bin/nimbus",
        realpath: (p) =>
          p === "/opt/homebrew/bin/nimbus" ? "/opt/homebrew/Cellar/nimbus/0.1.0/bin/nimbus" : p,
      }),
    ).toBe("homebrew");
  });
});

describe("channelUpgradeHint", () => {
  test.each([
    ["homebrew", "brew upgrade nimbus"],
    ["scoop", "scoop update nimbus"],
    ["winget", "winget upgrade nimbus"],
    ["apt", "apt upgrade nimbus"],
    ["yum", "dnf upgrade nimbus"],
    ["msi", ".msi"],
    ["pkg", ".pkg"],
  ] as const)("%s hint mentions the right command", (channel, needle) => {
    expect(channelUpgradeHint(channel)).toContain(needle);
  });
});
