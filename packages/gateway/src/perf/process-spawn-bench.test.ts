import { describe, expect, test } from "bun:test";
import { spawnAndTimeToMarker } from "./process-spawn-bench.ts";

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
    // FIRST sighting, not whichever stream happens to match last.
    const elapsed = await spawnAndTimeToMarker({
      cmd: "fake",
      args: [],
      mode: "marker",
      marker: /\[gateway\] ready/,
      timeoutMs: 5_000,
      spawn: ((..._args: unknown[]) => {
        const proc: FakeSubprocess = {
          stdout: streamFrom(["[gateway] ready\n"]),
          stderr: streamFrom(["[gateway] ready\n"], 100),
          exited: new Promise<number>((r) => setTimeout(() => r(0), 150)),
          kill: () => undefined,
        };
        return proc as unknown as ReturnType<typeof Bun.spawn>;
      }) as unknown as typeof Bun.spawn,
    });
    expect(elapsed).toBeLessThan(60);
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
