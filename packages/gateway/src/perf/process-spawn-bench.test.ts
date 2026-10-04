import { describe, expect, spyOn, test } from "bun:test";
import { type MarkerWatch, spawnAndTimeToMarker, watchForMarker } from "./process-spawn-bench.ts";

interface FakeSubprocess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}

function streamFrom(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.enqueue(new TextEncoder().encode(c));
      }
      controller.close();
    },
  });
}

function fakeSpawn(opts: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  delayMs?: number;
}): typeof Bun.spawn {
  return ((..._args: unknown[]) => {
    const proc: FakeSubprocess = {
      stdout: streamFrom(opts.stdout ?? [], opts.delayMs ?? 0),
      stderr: streamFrom(opts.stderr ?? [], opts.delayMs ?? 0),
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => undefined,
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("spawnAndTimeToMarker", () => {
  test("marker mode: returns elapsed ms when stdout matches the regex", async () => {
    const elapsed = await spawnAndTimeToMarker({
      cmd: "fake",
      args: [],
      mode: "marker",
      marker: /\[gateway\] ready/,
      spawn: fakeSpawn({ stdout: ["[gateway] ready (0.1.0) IPC /tmp/sock\n"] }),
    });
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test("marker mode: matches across stderr too", async () => {
    const elapsed = await spawnAndTimeToMarker({
      cmd: "fake",
      args: [],
      mode: "marker",
      marker: /\[tui\] first-frame/,
      spawn: fakeSpawn({ stderr: ["[tui] first-frame\n"] }),
    });
    expect(Number.isFinite(elapsed)).toBe(true);
  });

  test("exit mode: returns elapsed ms when the process exits", async () => {
    const elapsed = await spawnAndTimeToMarker({
      cmd: "fake",
      args: [],
      mode: "exit",
      spawn: fakeSpawn({ stdout: ["hello\n"], exitCode: 0 }),
    });
    expect(Number.isFinite(elapsed)).toBe(true);
  });

  test("marker mode: throws on timeout", async () => {
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        marker: /never-matches/,
        timeoutMs: 50,
        spawn: fakeSpawn({ stdout: ["unrelated output\n"] }),
      }),
    ).rejects.toThrow(/timeout/i);
  });

  test("exit mode: throws when child exits non-zero", async () => {
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "exit",
        spawn: fakeSpawn({ exitCode: 1 }),
      }),
    ).rejects.toThrow(/exit/i);
  });

  test("marker mode: throws if child exits before the marker is matched", async () => {
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        marker: /never-matches/,
        timeoutMs: 30_000,
        spawn: fakeSpawn({ stdout: ["something else\n"], exitCode: 1 }),
      }),
    ).rejects.toThrow(/exited.*before marker/i);
  });

  test("marker mode: throws if marker is missing", async () => {
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        spawn: fakeSpawn({ stdout: ["anything\n"] }),
      }),
    ).rejects.toThrow(/requires a marker/i);
  });

  test("marker mode: throws if marker has the global flag", async () => {
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        marker: /ready/g,
        spawn: fakeSpawn({ stdout: ["ready\n"] }),
      }),
    ).rejects.toThrow(/g or y flag/i);
  });

  test("marker mode: a later match on the other stream does not overwrite the first timing", async () => {
    // The gateway mirrors its ready banner onto stderr; the bench must report the
    // FIRST sighting, not whichever stream happens to match last. The two sightings are
    // 250 ms apart and the assertion sits at 150 ms, well inside that gap: a scheduler
    // pause has to exceed 150 ms to flake, but a regression that reported the stderr
    // timing would land at ~250 ms and still fail.
    const elapsed = await spawnAndTimeToMarker({
      cmd: "fake",
      args: [],
      mode: "marker",
      marker: /\[gateway\] ready/,
      timeoutMs: 5_000,
      spawn: ((..._args: unknown[]) => {
        const proc: FakeSubprocess = {
          stdout: streamFrom(["[gateway] ready\n"]),
          stderr: streamFrom(["[gateway] ready\n"], 250),
          exited: new Promise<number>((r) => setTimeout(() => r(0), 300)),
          kill: () => undefined,
        };
        return proc as unknown as ReturnType<typeof Bun.spawn>;
      }) as unknown as typeof Bun.spawn,
    });
    expect(elapsed).toBeLessThan(150);
  });

  test("marker mode: the timing runs from the spawn to the marker's first sighting", async () => {
    // The upper bound above passes for a timing that is never stamped at all (it stays 0), which
    // is exactly what a dropped `onFirstMatch` would produce. A clock that moves only when the
    // marker is emitted makes the timing exact, so 0 and anything else both fail.
    let now = 1_000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    let emitMarker!: () => void;
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExited = r;
    });
    try {
      const run = spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        marker: /\[gateway\] ready/,
        timeoutMs: 2_000,
        spawn: ((..._args: unknown[]) => {
          const proc: FakeSubprocess = {
            stdout: new ReadableStream<Uint8Array>({
              start(controller) {
                emitMarker = () => {
                  now += 75;
                  controller.enqueue(new TextEncoder().encode("[gateway] ready\n"));
                };
              },
            }),
            stderr: streamFrom([]),
            exited,
            kill: () => resolveExited(0),
          };
          return proc as unknown as ReturnType<typeof Bun.spawn>;
        }) as unknown as typeof Bun.spawn,
      });
      emitMarker();
      expect(await run).toBe(75);
    } finally {
      clock.mockRestore();
    }
  });

  test("marker mode: a silent, non-exiting child rejects from the timeout timer", async () => {
    // Neither stream ever emits or closes and the child never exits on its own,
    // so the deadline timer — not the exit racer — must produce the rejection.
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExited = r;
    });
    const silent = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start() {
          /* never enqueues, never closes */
        },
      });
    await expect(
      spawnAndTimeToMarker({
        cmd: "fake",
        args: [],
        mode: "marker",
        marker: /\[gateway\] ready/,
        timeoutMs: 25,
        spawn: ((..._args: unknown[]) => {
          const proc: FakeSubprocess = {
            stdout: silent(),
            stderr: silent(),
            exited,
            kill: () => resolveExited(0),
          };
          return proc as unknown as ReturnType<typeof Bun.spawn>;
        }) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow("spawn-and-time timeout after 25ms");
  });

  test("exit mode: with no spawn injected it drives the real Bun.spawn", async () => {
    // Covers the production default (`Bun.spawn`) end to end, including exit-code
    // propagation from a genuine child process.
    await expect(
      spawnAndTimeToMarker({
        cmd: process.execPath,
        args: ["-e", "process.exit(3)"],
        mode: "exit",
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow("child exited with code 3");
  });
});

describe("watchForMarker", () => {
  const READY = /\[gateway\] ready/;
  /** A stream that never emits and never closes. */
  const silent = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start() {
        /* never enqueues, never closes */
      },
    });
  const settleReaders = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  /**
   * "matched" once `watch.matched` resolves, else "pending" after `ms`. Every await on `matched`
   * goes through this: with no timer left alive, a promise that never settles hangs `bun test`
   * rather than tripping its timeout, so a regression would stall the run instead of failing it.
   */
  async function outcomeWithin(watch: MarkerWatch, ms: number): Promise<"matched" | "pending"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), ms);
    });
    try {
      return await Promise.race([watch.matched.then(() => "matched" as const), pending]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  test("resolves at the first sighting on stdout", async () => {
    const watch = watchForMarker(
      { stdout: streamFrom(["booting\n", "[gateway] ready\n"]), stderr: silent() },
      READY,
    );
    expect(watch.isMatched()).toBe(false);
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    expect(watch.isMatched()).toBe(true);
  });

  test("a sighting on stderr counts, even when the marker is split across two chunks", async () => {
    const watch = watchForMarker(
      { stdout: streamFrom([]), stderr: streamFrom(["[tui] first", "-frame\n"]) },
      /\[tui\] first-frame/,
    );
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    expect(watch.isMatched()).toBe(true);
  });

  test("onFirstMatch has run by the time matched resolves, and runs once when both streams match", async () => {
    const events: string[] = [];
    const watch = watchForMarker(
      { stdout: streamFrom(["[gateway] ready\n"]), stderr: streamFrom(["[gateway] ready\n"]) },
      READY,
      { onFirstMatch: () => events.push("first-match") },
    );
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    events.push("resolved");
    await settleReaders();
    expect(events).toEqual(["first-match", "resolved"]);
  });

  test("onStderrChunk sees each stderr chunk up to the match, never stdout, and nothing after", async () => {
    const seen: string[] = [];
    const watch = watchForMarker(
      {
        stdout: streamFrom(["stdout noise\n"]),
        stderr: streamFrom(["warming up\n", "[tui] first-frame\n", "after the marker\n"]),
      },
      /\[tui\] first-frame/,
      { onStderrChunk: (chunk) => seen.push(chunk) },
    );
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    await settleReaders();
    expect(seen).toEqual(["warming up\n", "[tui] first-frame\n"]);
  });

  test("once the marker shows, the other stream is read for one more chunk at most", async () => {
    let stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtl = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtl = c;
      },
    });
    const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
    const seen: string[] = [];
    const watch = watchForMarker({ stdout, stderr }, READY, {
      onStderrChunk: (chunk) => seen.push(chunk),
    });

    stdoutCtl.enqueue(encode("[gateway] ready\n"));
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    // stderr's read was already pending when stdout matched: it takes the next chunk, and the
    // stop applies there, so the chunk after it is never read and the lock is released.
    stderrCtl.enqueue(encode("after 1\n"));
    stderrCtl.enqueue(encode("after 2\n"));
    await settleReaders();
    expect(seen).toEqual(["after 1\n"]);
    expect(stderr.locked).toBe(false);
  });

  test("a marker that never shows leaves matched pending and isMatched false", async () => {
    const watch = watchForMarker(
      { stdout: streamFrom(["unrelated\n"]), stderr: streamFrom(["also unrelated\n"]) },
      READY,
    );
    expect(await outcomeWithin(watch, 50)).toBe("pending");
    expect(watch.isMatched()).toBe(false);
  });

  test("releases the reader lock of the stream that matched", async () => {
    const stdout = streamFrom(["[gateway] ready\n"]);
    const watch = watchForMarker({ stdout, stderr: silent() }, READY);
    expect(stdout.locked).toBe(true);
    expect(await outcomeWithin(watch, 2_000)).toBe("matched");
    expect(stdout.locked).toBe(false);
  });
});
