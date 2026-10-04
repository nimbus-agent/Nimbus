import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostActivity, HostActivityProbe, HostPower } from "../host-activity-types.ts";
import { UNKNOWN_PROBE } from "../host-activity-types.ts";

const DEFAULT_ROOT = "/sys/class/power_supply";
const MAINS_TYPES = new Set(["mains", "ac"]);

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Scans every supply entry rather than globbing `AC*`. Mains adapters are named `ADP1`, `ACAD`,
 * `AC`, `Mains` and more depending on distribution and hardware, and a glob that misses the name
 * reports `unknown` forever on a machine that knows perfectly well it is plugged in.
 *
 * `root` is injectable so the scan is testable on any OS without a real sysfs.
 */
export function createLinuxHostActivity(root: string = DEFAULT_ROOT): HostActivity {
  return {
    probe: (): Promise<HostActivityProbe> => Promise.resolve(scanPowerSupplies(root)),
  };
}

/** One synchronous sysfs scan. Never throws: every read that can fail degrades instead. */
function scanPowerSupplies(root: string): HostActivityProbe {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return UNKNOWN_PROBE;
  }

  let sawOnlineMains = false;
  for (const name of names) {
    const dir = join(root, name);
    const type = read(dir, "type")?.toLowerCase();
    if (type === "battery" && read(dir, "status")?.toLowerCase() === "discharging") {
      // A discharging battery is decisive: the machine is running down regardless of what
      // any adapter claims.
      return { power: "battery", idleMs: null, source: "power_only" };
    }
    if (type !== undefined && MAINS_TYPES.has(type) && read(dir, "online") === "1") {
      sawOnlineMains = true;
    }
  }

  const power: HostPower = sawOnlineMains ? "ac" : "unknown";
  // Idle is deliberately unmeasured on Linux: X11, Wayland and headless each answer
  // differently and a server has no session to be idle from. Stated, not faked.
  return { power, idleMs: null, source: "power_only" };
}
