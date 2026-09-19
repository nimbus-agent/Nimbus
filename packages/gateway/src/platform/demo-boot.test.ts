import { describe, expect, test } from "bun:test";

import { bootPolicyFor } from "./demo-boot.ts";
import type { PlatformPaths } from "./paths.ts";

const base: PlatformPaths = {
  configDir: "c",
  dataDir: "d",
  logDir: "l",
  socketPath: "s",
  extensionsDir: "e",
  tempDir: "t",
};

describe("bootPolicyFor", () => {
  test("a real gateway reaps AppContainers and honours the env sidecars", () => {
    expect(bootPolicyFor(base)).toEqual({
      reapAppContainers: true,
      envSidecars: true,
      syncScheduler: true,
      updaterStartupCheck: true,
      telemetryFlush: true,
      embeddingRuntime: true,
      extensionsAutoUpdate: true,
    });
  });

  test("a demo gateway does neither", () => {
    expect(bootPolicyFor({ ...base, demo: true })).toEqual({
      reapAppContainers: false,
      envSidecars: false,
      syncScheduler: false,
      updaterStartupCheck: false,
      telemetryFlush: false,
      embeddingRuntime: false,
      extensionsAutoUpdate: false,
    });
  });
});
