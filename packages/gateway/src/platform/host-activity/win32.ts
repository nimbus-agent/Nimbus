import { dlopen, FFIType, ptr } from "bun:ffi";
import type { HostActivity, HostActivityProbe, HostPower } from "../host-activity-types.ts";
import { UNKNOWN_PROBE } from "../host-activity-types.ts";

/**
 * `GetTickCount` and `LASTINPUTINFO.dwTime` are both 32-bit unsigned millisecond counters that
 * wrap every 49.7 days. Signed subtraction goes negative or absurd after a wrap — which would
 * either freeze admission permanently or admit falsely, on exactly the long-uptime workstation
 * this feature targets. `>>> 0` restores unsigned 32-bit semantics.
 */
export function idleMsFromTicks(tick: number, lastInput: number): number {
  return (tick - lastInput) >>> 0;
}

export function powerFromAcLineStatus(status: number): HostPower {
  if (status === 0) return "battery";
  if (status === 1) return "ac";
  return "unknown"; // 255 = unknown, and anything else is not a documented value.
}

/**
 * `dlopen` ONCE at construction, not per probe. The scheduler probes on a 60-second tick and again
 * at each job BOUNDARY within a run (before every job after the first, unless `--force` was given),
 * so a per-call `dlopen` would re-resolve the symbol tables thousands of times
 * a night and — since nothing ever calls `.close()` on the returned library — accumulate handles
 * for the life of the gateway. That makes it a leak, not just waste.
 *
 * A `dlopen` failure at construction is permanent and returns an always-unknown probe. That is the
 * right shape: if kernel32 cannot be opened once it will not open on the next tick either, and a
 * deterministic answer beats a per-call retry that re-throws forever.
 *
 * `open` defaults to bun:ffi's `dlopen` and exists only so a test can stand in for kernel32/user32
 * on any host; production passes nothing.
 */
export function createWin32HostActivity(open: typeof dlopen = dlopen): HostActivity {
  try {
    // `dlopen`'d directly into `const`s rather than through an outer `let ... | undefined`:
    // spreading the assignment across a `try` and a later read erases the precise symbol-map
    // type bun:ffi infers (it widens to `ReturnType<typeof dlopen>`, an index-signature type that
    // fails typecheck on every `.symbols.<Name>` access below). Keeping both in one scope, closed
    // over by the returned `probe`, keeps the inferred type intact.
    const kernel = open("kernel32.dll", {
      GetSystemPowerStatus: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetTickCount: { args: [], returns: FFIType.u32 },
    });
    const user = open("user32.dll", {
      GetLastInputInfo: { args: [FFIType.ptr], returns: FFIType.i32 },
    });

    // SYSTEM_POWER_STATUS: 4 BYTEs then 3 DWORDs. Only ACLineStatus (byte 0) is read.
    const sps = new Uint8Array(16);
    // LASTINPUTINFO: { cbSize: DWORD, dwTime: DWORD }. cbSize MUST be set before the call, and is
    // set once here because it never changes. Reused across probes: single-threaded, one call at
    // a time, and the kernel overwrites dwTime on every successful call.
    const lii = new Uint32Array(2);
    lii[0] = 8;

    // Synchronous FFI, all of it inside the `try`: any failure degrades to UNKNOWN_PROBE, never a
    // throw, so `probe` can hand back an already-settled promise.
    const probeNow = (): HostActivityProbe => {
      try {
        const power =
          kernel.symbols.GetSystemPowerStatus(ptr(sps)) === 0
            ? "unknown"
            : powerFromAcLineStatus(sps[0] ?? 255);

        let idleMs: number | null = null;
        if (user.symbols.GetLastInputInfo(ptr(lii)) !== 0) {
          idleMs = idleMsFromTicks(kernel.symbols.GetTickCount(), lii[1] ?? 0);
        }
        return { power, idleMs, source: idleMs === null ? "power_only" : "measured" };
      } catch {
        return UNKNOWN_PROBE;
      }
    };
    return {
      probe: (): Promise<HostActivityProbe> => Promise.resolve(probeNow()),
    };
  } catch {
    return { probe: (): Promise<HostActivityProbe> => Promise.resolve(UNKNOWN_PROBE) };
  }
}
