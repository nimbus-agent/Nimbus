import type { HostActivity, HostActivityProbe, HostPower } from "../host-activity-types.ts";
import { UNKNOWN_PROBE } from "../host-activity-types.ts";

const SPAWN_TIMEOUT_MS = 2_000;

/**
 * Injectable purely so a test can capture the options `run()` passes to `Bun.spawn` (`windowsHide`
 * in particular) without widening `HostActivity`'s own public `probe()` contract — the same shape
 * as `ownership/repo-remote.ts`'s `RemoteSpawn`.
 */
export type DarwinSpawn = typeof Bun.spawn;

export async function run(
  cmd: string[],
  spawn: DarwinSpawn = Bun.spawn,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = spawn(cmd, { stdout: "pipe", stderr: "ignore", windowsHide: true });
    timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text : undefined;
  } catch {
    return undefined;
  } finally {
    // Must run on every path, including a throw while reading stdout — otherwise the timer
    // outlives this call and can `kill()` an unrelated `proc` up to SPAWN_TIMEOUT_MS later.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function parseDarwinPower(pmsetOut: string): HostPower {
  if (/Now drawing from 'AC Power'/i.test(pmsetOut)) return "ac";
  if (/Now drawing from 'Battery Power'/i.test(pmsetOut)) return "battery";
  return "unknown";
}

/** `HIDIdleTime` is in NANOseconds. Missing or unparseable means unmeasurable, not zero. */
export function parseDarwinIdleMs(ioregOut: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOut);
  if (m?.[1] === undefined) return null;
  const ns = Number(m[1]);
  return Number.isFinite(ns) ? Math.floor(ns / 1_000_000) : null;
}

/** `spawn` defaults to `Bun.spawn`; a test passes its own so the probe runs on any host. */
export function createDarwinHostActivity(spawn: DarwinSpawn = Bun.spawn): HostActivity {
  return {
    probe: async (): Promise<HostActivityProbe> => {
      const pmset = await run(["pmset", "-g", "batt"], spawn);
      if (pmset === undefined) return UNKNOWN_PROBE;
      const power = parseDarwinPower(pmset);
      const ioreg = await run(["ioreg", "-c", "IOHIDSystem", "-d", "1"], spawn);
      const idleMs = ioreg === undefined ? null : parseDarwinIdleMs(ioreg);
      return { power, idleMs, source: idleMs === null ? "power_only" : "measured" };
    },
  };
}
