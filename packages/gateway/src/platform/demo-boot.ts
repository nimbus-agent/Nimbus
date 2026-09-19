import type { PlatformPaths } from "./paths.ts";

/**
 * The host-global boot actions a demo-rooted gateway must NOT perform (invariant I41 clause 4).
 *
 * - `reapAppContainers`: `sandbox/win32-reap.ts` deletes every `nimbus-*` AppContainer profile whose
 *   extension id is absent from `liveExtensionIds(db)` — THIS gateway's index. A demo index holds
 *   none of the owner's installed extensions, so a demo boot would delete the real gateway's
 *   profiles (possibly in use) and then sweep their ACEs.
 * - `envSidecars`: the HTTP API and metrics servers are selected by `NIMBUS_HTTP_PORT` /
 *   `NIMBUS_METRICS_PORT`, not config. A demo gateway inheriting them would crash on the port or,
 *   with the real gateway stopped, serve the demo index on the owner's real port.
 * - `syncScheduler`: construct the scheduler with `syncDisabled`, register no syncable, never
 *   `start()` it — a demo gateway must never sync (§ 11.2).
 * - `updaterStartupCheck`: `wireUpdaterIntoIpc` builds the updater and runs its startup
 *   `checkNow()`, which defaults to `checkOnStartup: true` — a real outbound release check a
 *   throwaway demo root has no business making.
 * - `telemetryFlush`: `startTelemetryFlushScheduler` posts to the telemetry endpoint on its own
 *   interval, independent of the `NIMBUS_TELEMETRY_ENABLED` env selector a seeded config cannot
 *   reach in time.
 * - `embeddingRuntime`: the embedding runtime downloads `Xenova/all-MiniLM-L6-v2` into
 *   `<dataDir>/models`, which for a demo gateway is the empty, throwaway demo data dir.
 * - `extensionsAutoUpdate`: the extension auto-update daemon polls a registry URL on its own
 *   interval, selected by `NIMBUS_EXTENSIONS_REGISTRY_URL`, not config.
 *
 * A pure function so the decision is unit-testable; `assemble.ts` is too large to execute in a
 * unit test, and `security-invariants.test.ts` pins that it consults this.
 */
export type BootPolicy = {
  readonly reapAppContainers: boolean;
  readonly envSidecars: boolean;
  readonly syncScheduler: boolean;
  readonly updaterStartupCheck: boolean;
  readonly telemetryFlush: boolean;
  readonly embeddingRuntime: boolean;
  readonly extensionsAutoUpdate: boolean;
};

export function bootPolicyFor(paths: PlatformPaths): BootPolicy {
  const demo = paths.demo === true;
  return {
    reapAppContainers: !demo,
    envSidecars: !demo,
    syncScheduler: !demo,
    updaterStartupCheck: !demo,
    telemetryFlush: !demo,
    embeddingRuntime: !demo,
    extensionsAutoUpdate: !demo,
  };
}
