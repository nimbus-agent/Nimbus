/**
 * The Windows host-activity probe, driven on ANY host through its `open` seam: the fakes below stand
 * in for kernel32/user32 and write their answers through the very pointers the probe passes, the way
 * the real Win32 calls do.
 */

import { type dlopen, type Pointer, toArrayBuffer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { UNKNOWN_PROBE } from "../host-activity-types.ts";
import { createWin32HostActivity } from "./win32.ts";

interface FakeWin32 {
  /** ACLineStatus to report, or `"fail"` for GetSystemPowerStatus returning 0. */
  readonly acLine: number | "fail";
  readonly tick: number;
  /** LASTINPUTINFO.dwTime to report, or `"fail"` for GetLastInputInfo returning 0. */
  readonly lastInput: number | "fail";
  readonly tickThrows?: boolean;
  /** Library names whose open throws, as `dlopen` does when the DLL is absent. */
  readonly missing?: readonly string[];
}

interface Recorder {
  readonly opened: string[];
  /** `LASTINPUTINFO.cbSize` as the fake saw it on each GetLastInputInfo call. */
  readonly cbSizes: number[];
}

function fakeOpen(w: FakeWin32, rec: Recorder): typeof dlopen {
  const open = (name: string) => {
    rec.opened.push(name);
    if (w.missing?.includes(name) === true) throw new Error(`${name}: cannot open shared object`);
    if (name === "kernel32.dll") {
      return {
        close: () => {},
        symbols: {
          GetSystemPowerStatus: (p: Pointer): number => {
            if (w.acLine === "fail") return 0;
            new Uint8Array(toArrayBuffer(p, 0, 16))[0] = w.acLine;
            return 1;
          },
          GetTickCount: (): number => {
            if (w.tickThrows === true) throw new Error("access violation");
            return w.tick;
          },
        },
      };
    }
    return {
      close: () => {},
      symbols: {
        GetLastInputInfo: (p: Pointer): number => {
          const lii = new Uint32Array(toArrayBuffer(p, 0, 8));
          rec.cbSizes.push(lii[0] ?? -1);
          if (w.lastInput === "fail") return 0;
          lii[1] = w.lastInput;
          return 1;
        },
      },
    };
  };
  return open as unknown as typeof dlopen;
}

function recorder(): Recorder {
  return { opened: [], cbSizes: [] };
}

describe("createWin32HostActivity", () => {
  test("reads AC power and the idle time since the last input", async () => {
    const rec = recorder();
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: 1, tick: 10_000, lastInput: 4_000 }, rec),
    );
    expect(await ha.probe()).toEqual({ power: "ac", idleMs: 6_000, source: "measured" });
    // The struct contract: cbSize must be set BEFORE the call, or Windows rejects it.
    expect(rec.cbSizes).toEqual([8]);
  });

  test("reports battery power", async () => {
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: 0, tick: 500, lastInput: 500 }, recorder()),
    );
    expect(await ha.probe()).toEqual({ power: "battery", idleMs: 0, source: "measured" });
  });

  test("a failed power query reads unknown power and still measures idle", async () => {
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: "fail", tick: 9_000, lastInput: 1_000 }, recorder()),
    );
    expect(await ha.probe()).toEqual({ power: "unknown", idleMs: 8_000, source: "measured" });
  });

  test("a failed input query discloses power_only rather than inventing an idle time", async () => {
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: 1, tick: 9_000, lastInput: "fail" }, recorder()),
    );
    expect(await ha.probe()).toEqual({ power: "ac", idleMs: null, source: "power_only" });
  });

  test("a faulting call degrades to the unknown probe instead of throwing", async () => {
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: 1, tick: 0, lastInput: 0, tickThrows: true }, recorder()),
    );
    expect(await ha.probe()).toEqual(UNKNOWN_PROBE);
  });

  test("both libraries are opened once, at construction, never per probe", async () => {
    const rec = recorder();
    const ha = createWin32HostActivity(fakeOpen({ acLine: 1, tick: 2, lastInput: 1 }, rec));
    expect(rec.opened).toEqual(["kernel32.dll", "user32.dll"]);
    await ha.probe();
    await ha.probe();
    await ha.probe();
    expect(rec.opened).toEqual(["kernel32.dll", "user32.dll"]);
    // ...while the struct is re-sent, correctly sized, on every probe.
    expect(rec.cbSizes).toEqual([8, 8, 8]);
  });

  test("a library that cannot be opened gives a permanently unknown probe, with no retry", async () => {
    const rec = recorder();
    const ha = createWin32HostActivity(
      fakeOpen({ acLine: 1, tick: 2, lastInput: 1, missing: ["user32.dll"] }, rec),
    );
    expect(await ha.probe()).toEqual(UNKNOWN_PROBE);
    expect(await ha.probe()).toEqual(UNKNOWN_PROBE);
    expect(rec.opened).toEqual(["kernel32.dll", "user32.dll"]);
    expect(rec.cbSizes).toEqual([]);
  });

  test("the real loader never throws on any host, and its probe is well-formed", async () => {
    // Off Windows `dlopen("kernel32.dll")` fails and this is the unknown probe; on Windows it is a
    // live reading. Either way it must be a coherent answer, not an exception.
    const probe = await createWin32HostActivity().probe();
    expect(["ac", "battery", "unknown"]).toContain(probe.power);
    expect(probe.source).toBe(probe.idleMs === null ? "power_only" : "measured");
  });
});
