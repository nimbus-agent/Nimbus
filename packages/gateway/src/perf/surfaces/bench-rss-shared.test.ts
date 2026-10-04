import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { measureGatewayRss } from "./bench-rss-shared.ts";
import { fakeSpawnEmitsMarker } from "./spawn-test-helpers.ts";

/** A gateway that reports ready at once and records the command it was started with. */
function readyGateway(pid: number): { spawn: typeof Bun.spawn; commands: string[][] } {
  const commands: string[][] = [];
  const inner = fakeSpawnEmitsMarker({ pid, stdoutChunks: ["[gateway] ready\n"] }) as unknown as (
    cmd: string[],
    opts: unknown,
  ) => unknown;
  const spawn = ((cmd: string[], opts: unknown) => {
    commands.push([...cmd]);
    return inner(cmd, opts);
  }) as unknown as typeof Bun.spawn;
  return { spawn, commands };
}

/** Counts readings and reports a fixed RSS for the expected pid only. */
function pidusageFor(expectedPid: number): {
  pidusage: (pid: number) => Promise<{ memory: number }>;
  calls: () => number;
} {
  let calls = 0;
  return {
    pidusage: (pid) => {
      calls += 1;
      return pid === expectedPid
        ? Promise.resolve({ memory: 123_000_000 })
        : Promise.reject(new Error(`sampled the wrong pid ${pid}`));
    },
    calls: () => calls,
  };
}

/**
 * `p`'s value, or "timeout" after `ms`. The live timer matters: with nothing else pending, a
 * promise that never settles hangs `bun test` instead of tripping its timeout.
 */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A window long enough to time a test out, and an interval that allows at most a reading or two
// per window.
const SLOW_DEFAULTS = { durationMs: 60_000, intervalMs: 60_000 };

describe("measureGatewayRss", () => {
  test("boots the real gateway entry by default and returns the RSS readings of its pid", async () => {
    const { spawn, commands } = readyGateway(4242);
    const reader = pidusageFor(4242);
    const samples = await measureGatewayRss(
      { spawn, pidusage: reader.pidusage },
      { durationMs: 100, intervalMs: 20 },
    );
    // A reading of the wrong pid is a miss, not a sample, so an empty result would expose it.
    expect(samples.length).toBeGreaterThanOrEqual(1);
    for (const s of samples) expect(s).toBe(123_000_000);
    const [cmd, entry] = commands[0] ?? [];
    expect(cmd).toBe(process.execPath);
    expect(entry?.endsWith(join("gateway", "src", "index.ts"))).toBe(true);
    expect(existsSync(entry ?? "")).toBe(true);
  });

  test("an injected gatewayEntry replaces the default", async () => {
    const { spawn, commands } = readyGateway(1);
    await measureGatewayRss(
      { spawn, gatewayEntry: "custom-gateway.ts", pidusage: pidusageFor(1).pidusage },
      { durationMs: 50, intervalMs: 60_000 },
    );
    expect(commands).toEqual([[process.execPath, "custom-gateway.ts"]]);
  });

  test("the run's durationMs and intervalMs win over the surface defaults", async () => {
    const { spawn } = readyGateway(7);
    const reader = pidusageFor(7);
    // With SLOW_DEFAULTS in force this would idle for a minute (timing the test out) and take at
    // most two readings; a 10 ms interval over 500 ms takes dozens.
    await measureGatewayRss(
      { spawn, pidusage: reader.pidusage, durationMs: 500, intervalMs: 10 },
      SLOW_DEFAULTS,
    );
    expect(reader.calls()).toBeGreaterThanOrEqual(4);
  });

  test("beforeIdle runs first with the run's signal, and the idle window starts once it settles", async () => {
    const { spawn } = readyGateway(9);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportStart!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      reportStart = resolve;
    });
    const idleMs = 200;
    const run = measureGatewayRss(
      { spawn, pidusage: pidusageFor(9).pidusage, durationMs: idleMs, intervalMs: 5 },
      SLOW_DEFAULTS,
      async (signal) => {
        reportStart(signal);
        await gate;
      },
    );

    const signal = await within(started, 5_000);
    if (signal === "timeout") throw new Error("beforeIdle was never called");
    expect(signal.aborted).toBe(false);
    // Held for longer than the whole idle window, and the run is still waiting on beforeIdle.
    expect(await within(run, idleMs + 100)).toBe("timeout");

    release();
    // Had the idle window run alongside beforeIdle, it would be over by now and the run would end
    // at once. It starts only after beforeIdle settles (heavy sync idles AFTER its syncs, as it
    // always has), so the whole window is still ahead. This wait's timer is armed before the idle
    // timer and is shorter, so it expires first however late the runner fires timers.
    expect(await within(run, idleMs / 2)).toBe("timeout");
    await run;
    // The same signal the run aborts once its workload is done.
    expect(signal.aborted).toBe(true);
  });
});
