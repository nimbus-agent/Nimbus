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
 *
 * A pure function so the decision is unit-testable; `assemble.ts` is too large to execute in a
 * unit test, and `security-invariants.test.ts` pins that it consults this.
 */
export type BootPolicy = {
  readonly reapAppContainers: boolean;
  readonly envSidecars: boolean;
  readonly syncScheduler: boolean;
};

export function bootPolicyFor(paths: PlatformPaths): BootPolicy {
  const demo = paths.demo === true;
  return { reapAppContainers: !demo, envSidecars: !demo, syncScheduler: !demo };
}
