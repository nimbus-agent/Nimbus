import { describe, expect, test } from "bun:test";
import { type DistributionChannel, resolveDistributionChannel } from "@nimbus-dev/sdk";
import type { Logger } from "pino";
import type { NimbusUpdaterToml } from "../config/nimbus-toml.ts";
import { DEFAULT_NIMBUS_UPDATER_TOML } from "../config/nimbus-toml.ts";
import { createUpdaterFromConfig } from "./factory.ts";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const noopEmit = (): void => {};

const baseArgs = {
  currentVersion: "0.1.0",
  emit: noopEmit,
  logger: noopLogger,
  // Isolate construction tests from the test runner's own binary path: without
  // this, resolveDistributionChannel() reads the real process.execPath, so a bun
  // installed via Homebrew/Scoop would trip the channel gate and fail these tests.
  // The channel-gate test below opts back in by overriding to "homebrew".
  _channelOverride: null as DistributionChannel | null,
};

describe("createUpdaterFromConfig", () => {
  test("returns undefined when [updater].enabled = false", () => {
    const updaterCfg: NimbusUpdaterToml = {
      ...DEFAULT_NIMBUS_UPDATER_TOML,
      enabled: false,
    };
    const result = createUpdaterFromConfig({ ...baseArgs, updaterCfg });
    expect(result).toBeUndefined();
  });

  test("returns Updater when enabled and platform supported", () => {
    const updaterCfg: NimbusUpdaterToml = {
      ...DEFAULT_NIMBUS_UPDATER_TOML,
      enabled: true,
    };
    const result = createUpdaterFromConfig({
      ...baseArgs,
      updaterCfg,
      _platformOverride: "linux-x86_64",
    });
    expect(result).toBeDefined();
    expect(result?.getStatus().currentVersion).toBe("0.1.0");
    expect(result?.getStatus().configUrl).toBe(updaterCfg.url);
  });

  test("returns undefined and logs a warning when platform is unsupported", () => {
    const warnings: unknown[] = [];
    const captureLogger = {
      warn: (...args: unknown[]) => warnings.push(args),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Logger;
    const updaterCfg: NimbusUpdaterToml = {
      ...DEFAULT_NIMBUS_UPDATER_TOML,
      enabled: true,
    };
    const result = createUpdaterFromConfig({
      ...baseArgs,
      updaterCfg,
      logger: captureLogger,
      _platformOverride: undefined, // explicit "unsupported"
      _forceUnsupported: true,
    });
    expect(result).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  test("returns undefined when running from a package-manager channel", () => {
    const updaterCfg: NimbusUpdaterToml = {
      ...DEFAULT_NIMBUS_UPDATER_TOML,
      enabled: true,
    };
    const result = createUpdaterFromConfig({
      ...baseArgs,
      updaterCfg,
      _channelOverride: "homebrew",
    });
    expect(result).toBeUndefined();
  });

  test("resolver returns null for a plain install path (default behavior unchanged)", () => {
    expect(resolveDistributionChannel({ env: {}, execPath: "/usr/bin/nimbus" })).toBeNull();
  });
});
