/**
 * The macOS host-activity probe, driven on ANY host through its `spawn` seam, plus `run()` against
 * a real child process (the bun binary itself, so it exists everywhere).
 */
import { describe, expect, test } from "bun:test";
import { UNKNOWN_PROBE } from "../host-activity-types.ts";
import { createDarwinHostActivity, type DarwinSpawn, parseDarwinIdleMs, run } from "./darwin.ts";

interface Reply {
  readonly out: string;
  readonly code: number;
}

/** A spawn that answers by command name and records every command it was asked to run. */
function fakeSpawn(replies: Readonly<Record<string, Reply>>, seen: string[][]): DarwinSpawn {
  return ((cmd: readonly string[]) => {
    seen.push([...cmd]);
    const reply = replies[cmd[0] ?? ""];
    if (reply === undefined) throw new Error(`ENOENT: ${cmd[0] ?? ""}`);
    return {
      kill: () => {},
      exited: Promise.resolve(reply.code),
      stdout: new Response(reply.out).body,
    };
  }) as unknown as DarwinSpawn;
}

const PMSET_BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t87%\n";
const PMSET_AC = "Now drawing from 'AC Power'\n";
const IOREG_7S = '  |   "HIDIdleTime" = 7000000000\n';

describe("createDarwinHostActivity", () => {
  test("reads battery power and nanosecond idle time", async () => {
    const seen: string[][] = [];
    const ha = createDarwinHostActivity(
      fakeSpawn(
        { pmset: { out: PMSET_BATTERY, code: 0 }, ioreg: { out: IOREG_7S, code: 0 } },
        seen,
      ),
    );
    expect(await ha.probe()).toEqual({ power: "battery", idleMs: 7_000, source: "measured" });
    expect(seen).toEqual([
      ["pmset", "-g", "batt"],
      ["ioreg", "-c", "IOHIDSystem", "-d", "1"],
    ]);
  });

  test("an unreadable power state is the unknown probe, and idle is not even asked", async () => {
    const seen: string[][] = [];
    const ha = createDarwinHostActivity(
      fakeSpawn({ pmset: { out: "", code: 1 }, ioreg: { out: IOREG_7S, code: 0 } }, seen),
    );
    expect(await ha.probe()).toEqual(UNKNOWN_PROBE);
    expect(seen).toEqual([["pmset", "-g", "batt"]]);
  });

  test("a failed ioreg discloses power_only", async () => {
    const ha = createDarwinHostActivity(
      fakeSpawn({ pmset: { out: PMSET_AC, code: 0 }, ioreg: { out: IOREG_7S, code: 2 } }, []),
    );
    expect(await ha.probe()).toEqual({ power: "ac", idleMs: null, source: "power_only" });
  });

  test("ioreg output with no HIDIdleTime discloses power_only", async () => {
    const ha = createDarwinHostActivity(
      fakeSpawn({ pmset: { out: PMSET_AC, code: 0 }, ioreg: { out: "+-o Root\n", code: 0 } }, []),
    );
    expect(await ha.probe()).toEqual({ power: "ac", idleMs: null, source: "power_only" });
  });

  test("a missing pmset binary is the unknown probe, never a throw", async () => {
    const ha = createDarwinHostActivity(fakeSpawn({}, []));
    expect(await ha.probe()).toEqual(UNKNOWN_PROBE);
  });

  test("the real spawn never throws on any host, and its probe is well-formed", async () => {
    // Off macOS there is no `pmset` and this is the unknown probe; on macOS it is a live,
    // read-only reading. Either way it must be a coherent answer, not an exception.
    const probe = await createDarwinHostActivity().probe();
    expect(["ac", "battery", "unknown"]).toContain(probe.power);
    expect(probe.source).toBe(probe.idleMs === null ? "power_only" : "measured");
    if (process.platform !== "darwin") expect(probe).toEqual(UNKNOWN_PROBE);
  });
});

describe("run() spawn deadline", () => {
  test("a child that never exits is killed when the 2 s deadline fires", async () => {
    // The deadline is shortened to 0 ms through a pass-through `setTimeout` (only the 2 s timer
    // is touched), so this proves the kill without waiting. The stand-in child exits ONLY when
    // killed — save for a safety net that exits it cleanly (code 0) after 1 s, so a missing kill
    // fails the assertions below fast instead of hanging the run.
    const originalSetTimeout = globalThis.setTimeout;
    const delays: (number | undefined)[] = [];
    let kills = 0;
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const safetyNet = originalSetTimeout(() => exit(0), 1_000);
    const hungSpawn = (() => ({
      kill: () => {
        kills += 1;
        exit(143);
      },
      exited,
      stdout: new Response("half a line").body,
    })) as unknown as DarwinSpawn;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      delays.push(timeout);
      return originalSetTimeout(handler, timeout === 2_000 ? 0 : timeout);
    }) as typeof setTimeout;
    // `run` spawns and arms its deadline before its first `await`, so the swap is restored as soon
    // as the call returns: no other code ever runs while the global is replaced.
    let pending: Promise<string | undefined>;
    try {
      pending = run(["pmset", "-g", "batt"], hungSpawn);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    let result: string | undefined;
    try {
      result = await pending;
    } finally {
      clearTimeout(safetyNet);
    }
    expect(kills).toBe(1);
    expect(delays).toContain(2_000);
    // Killed by the deadline is a non-zero exit, so even the output it printed is discarded.
    expect(result).toBeUndefined();
  });
});

describe("parseDarwinIdleMs", () => {
  test("an idle count too large to be a finite number is unmeasurable, not Infinity", () => {
    expect(parseDarwinIdleMs(`"HIDIdleTime" = ${"9".repeat(400)}`)).toBeNull();
  });
});

describe("run() with the real spawn", () => {
  test("returns the child's stdout on a zero exit", async () => {
    expect(await run([process.execPath, "-e", "process.stdout.write('pmset-ok')"])).toBe(
      "pmset-ok",
    );
  });

  test("returns undefined on a non-zero exit, even when the child printed something", async () => {
    expect(
      await run([process.execPath, "-e", "process.stdout.write('partial'); process.exit(3)"]),
    ).toBeUndefined();
  });
});
