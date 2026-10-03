/**
 * The shared surface between `host-activity.ts` (the factory) and its three per-platform
 * backends (`host-activity/{linux,darwin,win32}.ts`). Kept in its own leaf module — rather than
 * in `host-activity.ts` itself — because the backends need `UNKNOWN_PROBE` (a VALUE, not just a
 * type), and `host-activity.ts` dynamically imports the backends: a value re-exported from
 * `host-activity.ts` back into the backends would be a real runtime import cycle
 * (`audit:boundaries` catches this; type-only imports would not have tripped it, but this one
 * is not type-only).
 */

/** Mains state. `unknown` is a real answer — a desktop or VM has no battery to report. */
export type HostPower = "ac" | "battery" | "unknown";

/**
 * How much of a probe is real. `power_only` means user-idle could not be measured on this host
 * (headless Linux, a CI runner with no HID) — the fleet still admits, and says so. It never
 * claims a check it did not perform.
 */
export type HostProbeSource = "measured" | "power_only";

export interface HostActivityProbe {
  readonly power: HostPower;
  /** Milliseconds since last user input, or null when genuinely unmeasurable. */
  readonly idleMs: number | null;
  readonly source: HostProbeSource;
}

export interface HostActivity {
  probe(): Promise<HostActivityProbe>;
}

/** The probe returned when a backend cannot answer at all. Never throws upward. */
export const UNKNOWN_PROBE: HostActivityProbe = Object.freeze({
  power: "unknown",
  idleMs: null,
  source: "power_only",
});

/**
 * A shared stub for tests/fixtures that need a `HostActivity` value but do not exercise it.
 * `hostActivity` is a required `PlatformServices` member (never optional — an omitted field must
 * fail typecheck, not go silently inert), so every literal that predates this feature needs one of
 * these to keep compiling.
 */
export const UNKNOWN_HOST_ACTIVITY: HostActivity = {
  probe: (): Promise<HostActivityProbe> => Promise.resolve(UNKNOWN_PROBE),
};
