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
    expect(calls.length).toBe(1);
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
});
