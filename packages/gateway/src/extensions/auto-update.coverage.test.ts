/**
 * Paths of `ExtensionAutoUpdater` that `auto-update.test.ts` does not reach: the two scheduled
 * polls `start()` arms (and that a failing poll is swallowed there), and a `start()` whose jitter
 * source throws.
 *
 * The timer tests swap `globalThis.setTimeout`/`setInterval` only around the SYNCHRONOUS body of
 * `start()`/`stop()` and restore them before anything is awaited, so no other code ever sees them.
 */
import { describe, expect, test } from "bun:test";

import { ExtensionAutoUpdater, type ExtensionAutoUpdaterOpts } from "./auto-update.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";

function updater(overrides: Partial<ExtensionAutoUpdaterOpts>): {
  updater: ExtensionAutoUpdater;
  cache: AutoUpdateCache;
} {
  const cache = new AutoUpdateCache();
  const u = new ExtensionAutoUpdater({
    cache,
    listInstalled: async () => [],
    collect: async () => ({ updates: [], errors: [], dependsOn: new Map(), requires: new Map() }),
    planUpdate: async () => {
      throw new Error("nothing is planned in these tests");
    },
    appendAudit: async () => {},
    intervalHours: 2,
    now: () => 1_000,
    random: () => 0.5,
    ...overrides,
  });
  return { updater: u, cache };
}

interface Armed {
  readonly fn: () => void;
  readonly ms: number | undefined;
}

/** Runs `body` (synchronously) with the four timer globals replaced by recorders. */
function withRecordedTimers<T>(body: () => T): {
  result: T;
  timeouts: Armed[];
  intervals: Armed[];
  cleared: unknown[];
} {
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  const timeouts: Armed[] = [];
  const intervals: Armed[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timeouts.push({ fn, ms });
    return "startup-handle";
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervals.push({ fn, ms });
    return "periodic-handle";
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.push(h);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((h: unknown) => {
    cleared.push(h);
  }) as typeof clearInterval;
  try {
    return { result: body(), timeouts, intervals, cleared };
  } finally {
    Object.assign(globalThis, real);
  }
}

describe("start(): the two scheduled polls", () => {
  test("a jittered startup poll and a periodic poll are armed; both poll, and a failing poll is swallowed", async () => {
    let listed = 0;
    const { updater: u } = updater({
      listInstalled: async () => {
        listed += 1;
        throw new Error("extension table locked");
      },
      random: () => 0.5,
      intervalHours: 2,
    });

    const started = withRecordedTimers(() => u.start());
    await started.result;
    expect(u.isRunning()).toBe(true);
    // 30 s floor + 0.5 × the 270 s jitter window; the period is the configured interval.
    expect(started.timeouts.map((t) => t.ms)).toEqual([30_000 + 135_000]);
    expect(started.intervals.map((t) => t.ms)).toEqual([2 * 3_600_000]);

    // Fire both: each polls, and the rejected poll must not surface as an unhandled rejection.
    started.timeouts[0]?.fn();
    started.intervals[0]?.fn();
    await Bun.sleep(0);
    expect(listed).toBe(2);

    const stopped = withRecordedTimers(() => u.stop());
    await stopped.result;
    expect(stopped.cleared).toEqual(["startup-handle", "periodic-handle"]);
    expect(u.isRunning()).toBe(false);
  });

  test("a jitter source that throws rejects start() with no timer armed; stop() then clears nothing", async () => {
    const { updater: u } = updater({
      random: () => {
        throw new Error("entropy unavailable");
      },
    });

    const started = withRecordedTimers(() => u.start());
    await expect(started.result).rejects.toThrow("entropy unavailable");
    expect(started.timeouts).toEqual([]);
    expect(started.intervals).toEqual([]);

    const stopped = withRecordedTimers(() => u.stop());
    await stopped.result;
    expect(stopped.cleared).toEqual([]);
    expect(u.isRunning()).toBe(false);
  });
});
