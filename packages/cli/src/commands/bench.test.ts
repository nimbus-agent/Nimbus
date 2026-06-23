import { describe, expect, mock, test } from "bun:test";
import { runBench } from "./bench.ts";

describe("runBench (CLI command)", () => {
  test("--help is handled in-process and does not spawn a subprocess", async () => {
    const stdoutChunks: string[] = [];
    const spawnMock = mock(() => {
      throw new Error("Bun.spawn should not be called for --help");
    });
    const exit = await runBench(["--help"], {
      spawn: spawnMock as unknown as typeof Bun.spawn,
      stdout: (s) => stdoutChunks.push(s),
    });
    expect(exit).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stdoutChunks.join("")).toMatch(/Usage:/);
  });

  test("-h short flag is handled in-process and does not spawn a subprocess", async () => {
    const stdoutChunks: string[] = [];
    const spawnMock = mock(() => {
      throw new Error("Bun.spawn should not be called for -h");
    });
    const exit = await runBench(["-h"], {
      spawn: spawnMock as unknown as typeof Bun.spawn,
      stdout: (s) => stdoutChunks.push(s),
    });
    expect(exit).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stdoutChunks.join("")).toMatch(/nimbus bench/);
  });

  test("non-help args spawn the bench-runner subprocess and forward exit code", async () => {
    const calls: Array<{ cmd: string[]; opts?: unknown }> = [];
    const spawnMock = mock((cmd: string[], opts?: unknown) => {
      calls.push({ cmd, opts });
      return {
        exited: Promise.resolve(0),
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });
    const exit = await runBench(
      ["--surface", "S2-a", "--runs", "1", "--corpus", "small", "--gha"],
      { spawn: spawnMock as unknown as typeof Bun.spawn },
    );
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    const cmd = calls[0]?.cmd ?? [];
    expect(cmd[0]).toMatch(/bun(?:\.exe)?$/);
    expect(cmd[1]).toMatch(/bench-runner\.ts$/);
    expect(cmd.slice(2)).toEqual([
      "--surface",
      "S2-a",
      "--runs",
      "1",
      "--corpus",
      "small",
      "--gha",
    ]);
  });

  test("non-zero subprocess exit propagates as the command exit code", async () => {
    const spawnMock = mock(() => {
      return {
        exited: Promise.resolve(2),
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });
    const exit = await runBench(["--surface", "S2-a", "--reference"], {
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });
    expect(exit).toBe(2);
  });

  test("non-number subprocess exit defaults to exit code 1", async () => {
    const spawnMock = mock(() => {
      return {
        exited: Promise.resolve(null),
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });
    const exit = await runBench(["--all"], {
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });
    expect(exit).toBe(1);
  });

  test("default stdout dep writes to process.stdout when not injected", async () => {
    // When no stdout dep is passed, the default writes to process.stdout.write.
    // We validate this by ensuring the help text is emitted via the default path
    // (no stdout dep, but capture process.stdout.write directly).
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array, ..._rest: unknown[]) => {
      chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    };
    try {
      const spawnMock = mock(() => {
        throw new Error("should not spawn for --help");
      });
      const exit = await runBench(["--help"], {
        spawn: spawnMock as unknown as typeof Bun.spawn,
        // no stdout dep — exercises the `deps.stdout ?? (...)` falsy branch
      });
      expect(exit).toBe(0);
      expect(chunks.join("")).toMatch(/Usage:/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
