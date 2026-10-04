import { platform } from "node:os";
import type { HostActivity, HostActivityProbe } from "./host-activity-types.ts";
import { UNKNOWN_PROBE } from "./host-activity-types.ts";

// Re-exported so existing importers (`platform/types.ts`, `platform/assemble.ts`,
// `fleet/fleet-store.ts`) keep working unchanged — the types/values themselves live in the leaf
// module `host-activity-types.ts` to avoid a runtime import cycle: the three backends below need
// `UNKNOWN_PROBE` as a VALUE, and this file dynamically imports the backends, so a value defined
// here and imported back by a backend would be a real cycle (`audit:boundaries` enforces this).
export type {
  HostActivity,
  HostActivityProbe,
  HostPower,
  HostProbeSource,
} from "./host-activity-types.ts";
export { UNKNOWN_HOST_ACTIVITY, UNKNOWN_PROBE } from "./host-activity-types.ts";

/**
 * Each platform answers for its own mechanism, so this knowledge stays in the PAL rather than
 * leaking a `process.platform` branch into the scheduler — the same shape as
 * `platform/sandbox/sandbox-runner.ts`'s `createSandboxRunner`.
 */
export async function createHostActivity(): Promise<HostActivity> {
  switch (platform()) {
    case "linux":
      return (await import("./host-activity/linux.ts")).createLinuxHostActivity();
    case "darwin":
      return (await import("./host-activity/darwin.ts")).createDarwinHostActivity();
    case "win32":
      return (await import("./host-activity/win32.ts")).createWin32HostActivity();
    default:
      return { probe: (): Promise<HostActivityProbe> => Promise.resolve(UNKNOWN_PROBE) };
  }
}
