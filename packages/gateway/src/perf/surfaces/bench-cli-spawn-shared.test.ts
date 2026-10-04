import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CLI_COLD_SAMPLES_PER_RUN, runCliOverheadColdOnce } from "./bench-cli-overhead-cold.ts";
import { CLI_WARM_SAMPLES_PER_RUN, runCliOverheadWarmOnce } from "./bench-cli-overhead-warm.ts";
import { sampleCliSpawns } from "./bench-cli-spawn-shared.ts";
import { runTuiFirstPaintOnce, TUI_FIRST_PAINT_SAMPLES_PER_RUN } from "./bench-tui-first-paint.ts";

interface SpawnCall {
  cmd: string[];
  env: Record<string, string | undefined> | undefined;
}

interface RecordingSpawnOptions {
  /** Exit code per call, in call order; a call past the end exits 0. */
  exitCodes?: number[];
  /** Written to every child's stderr. */
  stderrText?: string;
  /** Advances the fake clock by this much for the call with the given index. */
  costMs?: (callIndex: number) => number;
}

let fakeNow = 0;
let restoreClock: (() => void) | undefined;

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

/**
 * Freezes `performance.now` so each spawn's measured time is exactly its scripted `costMs`: the
 * clock only moves when the recording spawn advances it.
 */
function useFakeClock(): void {
  fakeNow = 1_000;
  const spy = spyOn(performance, "now").mockImplementation(() => fakeNow);
  restoreClock = () => spy.mockRestore();
}

function closedStream(text?: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (text !== undefined) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

/**
 * Records every spawn and exits it after a real 2 ms delay, so overlapping children would be
 * visible in `maxInFlight`.
 */
function recordingSpawn(opts: RecordingSpawnOptions = {}): {
  spawn: typeof Bun.spawn;
  calls: SpawnCall[];
  maxInFlight: () => number;
} {
  const calls: SpawnCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const spawn = ((cmd: string[], spawnOpts: { env?: Record<string, string | undefined> }) => {
    const callIndex = calls.length;
    calls.push({ cmd: [...cmd], env: spawnOpts.env });
    fakeNow += opts.costMs?.(callIndex) ?? 0;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const exited = new Promise<number>((resolve) => {
      setTimeout(() => {
        inFlight -= 1;
        resolve(opts.exitCodes?.[callIndex] ?? 0);
      }, 2);
    });
    return {
      stdout: closedStream(),
      stderr: closedStream(opts.stderrText),
      exited,
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls, maxInFlight: () => maxInFlight };
}

const HELP_PLAN = { args: ["help"], mode: "exit", timeoutMs: 5_000 } as const;

describe("sampleCliSpawns", () => {
  test("discards the warm-up timings and returns the samples that follow, in order", async () => {
    useFakeClock();
    const { spawn, calls } = recordingSpawn({ costMs: (i) => (i + 1) * 100 });
    const samples = await sampleCliSpawns(
      { ...HELP_PLAN, samples: 3, warmupRuns: 2 },
      { spawn, cliEntry: "cli.ts" },
    );
    expect(calls).toHaveLength(5);
    expect(samples).toEqual([300, 400, 500]);
  });

  test("with no warm-up, every spawn is a sample", async () => {
    useFakeClock();
    const { spawn, calls } = recordingSpawn({ costMs: (i) => (i + 1) * 10 });
    const samples = await sampleCliSpawns(
      { ...HELP_PLAN, samples: 2 },
      { spawn, cliEntry: "cli.ts" },
    );
    expect(calls).toHaveLength(2);
    expect(samples).toEqual([10, 20]);
  });

  test("spawns one child at a time", async () => {
    const { spawn, maxInFlight } = recordingSpawn();
    await sampleCliSpawns(
      { ...HELP_PLAN, samples: 3, warmupRuns: 1 },
      { spawn, cliEntry: "cli.ts" },
    );
    expect(maxInFlight()).toBe(1);
  });

  test("runs the bun binary on the real CLI entry by default, followed by the plan's args", async () => {
    const { spawn, calls } = recordingSpawn();
    await sampleCliSpawns({ ...HELP_PLAN, samples: 1 }, { spawn });
    const [cmd, entry, ...args] = calls[0]?.cmd ?? [];
    expect(cmd).toBe(process.execPath);
    expect(entry?.endsWith(join("cli", "src", "index.ts"))).toBe(true);
    expect(existsSync(entry ?? "")).toBe(true);
    expect(args).toEqual(["help"]);
  });

  test("an injected cliEntry replaces the default", async () => {
    const { spawn, calls } = recordingSpawn();
    await sampleCliSpawns({ ...HELP_PLAN, samples: 1 }, { spawn, cliEntry: "custom-cli.ts" });
    expect(calls[0]?.cmd).toEqual([process.execPath, "custom-cli.ts", "help"]);
  });

  test("a plan env reaches the child; without one no env is passed and the child inherits", async () => {
    const withEnv = recordingSpawn();
    await sampleCliSpawns(
      { ...HELP_PLAN, samples: 1, env: { NIMBUS_BENCH: "1" } },
      { spawn: withEnv.spawn, cliEntry: "cli.ts" },
    );
    expect(withEnv.calls[0]?.env?.["NIMBUS_BENCH"]).toBe("1");

    const withoutEnv = recordingSpawn();
    await sampleCliSpawns(
      { ...HELP_PLAN, samples: 1 },
      { spawn: withoutEnv.spawn, cliEntry: "cli.ts" },
    );
    expect(withoutEnv.calls[0]?.env).toBeUndefined();
  });

  test("marker mode times each spawn to the plan's marker, not to its exit", async () => {
    // Each child prints the marker and then exits 1: only a marker-mode spawn succeeds on that.
    const { spawn } = recordingSpawn({ stderrText: "[tui] first-frame\n", exitCodes: [1, 1] });
    const samples = await sampleCliSpawns(
      {
        args: ["tui"],
        mode: "marker",
        marker: /\[tui\] first-frame/,
        timeoutMs: 5_000,
        samples: 2,
      },
      { spawn, cliEntry: "cli.ts" },
    );
    expect(samples).toHaveLength(2);
    for (const s of samples) expect(Number.isFinite(s)).toBe(true);
  });

  test("a failing warm-up rejects the run before any sample is spawned", async () => {
    const { spawn, calls } = recordingSpawn({ exitCodes: [1] });
    await expect(
      sampleCliSpawns({ ...HELP_PLAN, samples: 3, warmupRuns: 1 }, { spawn, cliEntry: "cli.ts" }),
    ).rejects.toThrow("child exited with code 1");
    expect(calls).toHaveLength(1);
  });
});

/**
 * Each surface's plan is plain data handed to `sampleCliSpawns`, so a dropped field (S11-b's
 * warm-up, S4's env or marker mode) changes what the surface measures while the surface's own
 * test, which counts samples only, stays green. These pin each plan through the spawns it makes.
 */
describe("the CLI surfaces' spawn plans", () => {
  const RUN = { runs: 1, runner: "local-dev" } as const;
  /** 1, 2, ..., n: the timings the fake clock produces when spawn i costs i + 1 ms. */
  const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

  test("S11-a (cold) times every `help` spawn it makes, with no warm-up and no env", async () => {
    useFakeClock();
    const { spawn, calls } = recordingSpawn({ costMs: (i) => i + 1 });
    const samples = await runCliOverheadColdOnce(RUN, { spawn, cliEntry: "cli.ts" });
    expect(samples).toEqual(oneTo(CLI_COLD_SAMPLES_PER_RUN));
    expect(calls).toHaveLength(CLI_COLD_SAMPLES_PER_RUN);
    for (const call of calls) {
      expect(call.cmd).toEqual([process.execPath, "cli.ts", "help"]);
      expect(call.env).toBeUndefined();
    }
  });

  test("S11-b (warm) discards exactly one leading `help` spawn, with no env", async () => {
    useFakeClock();
    const { spawn, calls } = recordingSpawn({ costMs: (i) => i + 1 });
    const samples = await runCliOverheadWarmOnce(RUN, { spawn, cliEntry: "cli.ts" });
    expect(calls).toHaveLength(CLI_WARM_SAMPLES_PER_RUN + 1);
    // The first spawn's timing (1) is the discarded warm-up.
    expect(samples).toEqual(oneTo(CLI_WARM_SAMPLES_PER_RUN + 1).slice(1));
    for (const call of calls) {
      expect(call.cmd).toEqual([process.execPath, "cli.ts", "help"]);
      expect(call.env).toBeUndefined();
    }
  });

  test("S4 (TUI) times each `tui` spawn to its first frame, with NIMBUS_BENCH set", async () => {
    // Every child prints the first-frame marker and then exits 1, which only marker mode survives.
    const { spawn, calls } = recordingSpawn({
      stderrText: "[tui] first-frame\n",
      exitCodes: Array.from({ length: TUI_FIRST_PAINT_SAMPLES_PER_RUN }, () => 1),
    });
    const samples = await runTuiFirstPaintOnce(RUN, { spawn, cliEntry: "cli.ts" });
    expect(samples).toHaveLength(TUI_FIRST_PAINT_SAMPLES_PER_RUN);
    expect(calls).toHaveLength(TUI_FIRST_PAINT_SAMPLES_PER_RUN);
    for (const call of calls) {
      expect(call.cmd).toEqual([process.execPath, "cli.ts", "tui"]);
      expect(call.env?.["NIMBUS_BENCH"]).toBe("1");
    }
  });
});
