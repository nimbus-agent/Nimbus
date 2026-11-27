import type { Syncable } from "../sync/types.ts";
import { createFlagsmithSyncable } from "./flagsmith-sync.ts";
import { createLaunchdarklySyncable } from "./launchdarkly-sync.ts";
import { createSplitSyncable } from "./split-sync.ts";
import { createUnleashSyncable } from "./unleash-sync.ts";

/**
 * Registers the feature-flag syncables: LaunchDarkly, Flagsmith, Unleash and Split. Each indexes flag
 * DEFINITIONS only (per-environment state is a live read), and each first ensures the phase-3 bundle its
 * MCP server runs in. An unconfigured one is skipped by the scheduler's configured check.
 */
export function registerFlagSyncables(
  scheduler: { register(syncable: Syncable): void },
  ensurePhase3BundleRunning: () => Promise<void>,
): void {
  scheduler.register(
    createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: ensurePhase3BundleRunning }),
  );
  scheduler.register(
    createFlagsmithSyncable({ ensureFlagsmithMcpRunning: ensurePhase3BundleRunning }),
  );
  scheduler.register(createUnleashSyncable({ ensureUnleashMcpRunning: ensurePhase3BundleRunning }));
  scheduler.register(createSplitSyncable({ ensureSplitMcpRunning: ensurePhase3BundleRunning }));
}
