import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { DEFAULT_NIMBUS_UPDATER_TOML } from "../../../src/config/nimbus-toml.ts";
import { dispatchUpdaterRpc } from "../../../src/ipc/updater-rpc.ts";
import { expectRpcError } from "../../../src/ipc/updater-rpc-test-helpers.ts";
import { createUpdaterFromConfig } from "../../../src/updater/factory.ts";

type BunHttpServer = ReturnType<typeof Bun.serve>;

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

let server: BunHttpServer | undefined;

beforeEach(() => {
  server = undefined;
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("S6-F1: Updater wiring — factory + dispatch end-to-end", () => {
  test("configured Updater returns CheckNowResult instead of ERR_UPDATER_NOT_CONFIGURED", async () => {
    const manifest = {
      version: "0.0.99",
      pub_date: new Date().toISOString(),
      platforms: {
        "linux-x86_64": {
          url: "http://example.invalid/nimbus-linux-x86_64.tar.gz",
          sha256: "0".repeat(64),
          signature: "AAAA",
        },
        "darwin-x86_64": {
          url: "http://example.invalid/nimbus-darwin-x86_64.tar.gz",
          sha256: "0".repeat(64),
          signature: "AAAA",
        },
        "darwin-aarch64": {
          url: "http://example.invalid/nimbus-darwin-aarch64.tar.gz",
          sha256: "0".repeat(64),
          signature: "AAAA",
        },
        "windows-x86_64": {
          url: "http://example.invalid/nimbus-windows-x86_64.zip",
          sha256: "0".repeat(64),
          signature: "AAAA",
        },
      },
    };

    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(manifest), {
          headers: { "content-type": "application/json" },
        }),
    });

    const updaterCfg = {
      ...DEFAULT_NIMBUS_UPDATER_TOML,
      enabled: true,
      url: `http://127.0.0.1:${server.port}/latest.json`,
    };

    const updater = createUpdaterFromConfig({
      updaterCfg,
      currentVersion: "0.1.0",
      emit: () => {},
      logger: noopLogger,
      _platformOverride: "linux-x86_64",
      // null = "direct install"; do not probe the environment. Without this the
      // factory calls resolveDistributionChannel(), which honours the ambient
      // NIMBUS_DISTRIBUTION_CHANNEL marker — so on a developer machine that
      // installed Nimbus via MSI/Homebrew/apt the factory correctly returns
      // undefined and this assertion fails for a reason that has nothing to do
      // with updater wiring (#967). CI has the var unset, which is why it only
      // ever failed locally.
      _channelOverride: null,
    });
    expect(updater).toBeDefined();

    const result = (await dispatchUpdaterRpc("updater.checkNow", {}, { updater })) as {
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
    };

    expect(result.currentVersion).toBe("0.1.0");
    expect(result.latestVersion).toBe("0.0.99");
    expect(result.updateAvailable).toBe(false);
  });

  test("disabled config still returns ERR_UPDATER_NOT_CONFIGURED via the dispatcher", async () => {
    const updaterCfg = { ...DEFAULT_NIMBUS_UPDATER_TOML, enabled: false };
    const updater = createUpdaterFromConfig({
      updaterCfg,
      currentVersion: "0.1.0",
      emit: () => {},
      logger: noopLogger,
      // Pinned for the same reason as above. This case passes either way today
      // because the `enabled: false` guard returns before the channel probe —
      // but that ordering is incidental, and pinning it keeps the assertion
      // about the disabled flag rather than about the developer's environment.
      _channelOverride: null,
    });
    expect(updater).toBeUndefined();

    await expectRpcError(
      dispatchUpdaterRpc("updater.checkNow", {}, { updater: undefined }),
      -32602,
      /ERR_UPDATER_NOT_CONFIGURED/,
    );
  });
});
