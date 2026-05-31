import type { Logger } from "pino";
import type { NimbusUpdaterToml } from "../config/nimbus-toml.ts";
import { derivePlatformTarget } from "./platform-target.ts";
import { loadUpdaterPublicKey } from "./public-key.ts";
import type { PlatformTarget } from "./types.ts";
import { Updater, type UpdaterEmit } from "./updater.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CreateUpdaterFromConfigArgs {
  updaterCfg: NimbusUpdaterToml;
  currentVersion: string;
  emit: UpdaterEmit;
  logger: Logger;
  _platformOverride?: PlatformTarget | undefined;
  _forceUnsupported?: boolean;
}

export function createUpdaterFromConfig(args: CreateUpdaterFromConfigArgs): Updater | undefined {
  const { updaterCfg, currentVersion, emit, logger } = args;

  if (!updaterCfg.enabled) {
    return undefined;
  }

  const target = args._forceUnsupported
    ? undefined
    : (args._platformOverride ?? derivePlatformTarget());
  if (target === undefined) {
    logger.warn(
      { platform: process.platform, arch: process.arch },
      "updater: unsupported platform/arch combo; auto-update disabled for this host",
    );
    return undefined;
  }

  return new Updater({
    currentVersion,
    manifestUrl: updaterCfg.url,
    publicKey: loadUpdaterPublicKey(),
    target,
    emit,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}
