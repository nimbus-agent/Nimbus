/**
 * Boot wiring for the trust feed (marketplace trust layer), kept out of `platform/assemble.ts`:
 * - `prepareTrustAtBoot` runs BEFORE the extension boot verification pass, so the spawn gate opens
 *   only after every installed extension's verifying key is recorded and the baked snapshot's
 *   statements are stored; it never throws;
 * - `startTrustFeedForBoot` starts the timer after the gate opens. A demo-rooted gateway (I41)
 *   fetches nothing and gets no handle.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { loadNimbusExtensionsFromConfigDir } from "../../config/nimbus-toml.ts";
import type { NimbusVault } from "../../vault/index.ts";
import type { RegistryFetchDeps } from "../registry/registry-fetch.ts";
import { backfillPublisherKeyFingerprints } from "./publisher-key-fingerprint.ts";
import {
  applyTrustSnapshot,
  BUILTIN_TRUST_FEED,
  BUILTIN_TRUST_SNAPSHOT,
  refreshTrustFeed,
  type TrustFeedConfig,
  type TrustFeedResult,
} from "./trust-feed.ts";
import { TrustFeedDaemon } from "./trust-feed-daemon.ts";

/** What the IPC layer gets: the configured feed (or `null`), its interval, and a refresh trigger. */
export interface TrustFeedHandle {
  readonly config: TrustFeedConfig | null;
  readonly intervalHours: number;
  refreshNow(): Promise<TrustFeedResult>;
}

export async function prepareTrustAtBoot(deps: {
  db: Database;
  vault: NimbusVault;
  logger: Pick<Logger, "info" | "warn">;
  trustFeed?: TrustFeedConfig | null;
  snapshot?: string | null;
}): Promise<void> {
  try {
    const filled = await backfillPublisherKeyFingerprints(deps.db, deps.vault);
    if (filled > 0) deps.logger.info({ filled }, "recorded verifying-key fingerprints");
  } catch (e) {
    deps.logger.warn({ err: e }, "verifying-key fingerprint backfill failed");
  }
  const cfg = deps.trustFeed === undefined ? BUILTIN_TRUST_FEED : deps.trustFeed;
  const snapshot = deps.snapshot === undefined ? BUILTIN_TRUST_SNAPSHOT : deps.snapshot;
  const result = await applyTrustSnapshot(deps.db, snapshot, cfg, Date.now());
  if (result.status === "refused") {
    deps.logger.warn({ code: result.code, detail: result.detail }, "baked trust snapshot refused");
  }
}

export function startTrustFeedForBoot(deps: {
  db: Database;
  configDir: string;
  demoRooted: boolean;
  registryFetch: Omit<RegistryFetchDeps, "db">;
  logger: Pick<Logger, "info" | "warn">;
  sidecarStops: Array<() => void>;
  trustFeed?: TrustFeedConfig | null;
}): TrustFeedHandle | undefined {
  if (deps.demoRooted) return undefined;
  const config = deps.trustFeed === undefined ? BUILTIN_TRUST_FEED : deps.trustFeed;
  const intervalHours = loadNimbusExtensionsFromConfigDir(deps.configDir).trustCheckIntervalHours;
  const daemon = new TrustFeedDaemon({
    refresh: () => refreshTrustFeed({ ...deps.registryFetch, db: deps.db, trustFeed: config }),
    intervalHours,
    logger: deps.logger,
  });
  // With no feed configured there is nothing to fetch; the handle still answers `trust.status`.
  if (config !== null) {
    daemon.start();
    deps.sidecarStops.push(() => daemon.stop());
  }
  return { config, intervalHours, refreshNow: () => daemon.refreshNow() };
}
