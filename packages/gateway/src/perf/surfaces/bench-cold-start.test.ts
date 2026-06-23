import { describe, expect, test } from "bun:test";
import { COLD_START_SAMPLES_PER_RUN, runColdStartOnce } from "./bench-cold-start.ts";

function fakeSpawn(stdoutChunks: string[]): typeof Bun.spawn {
  return ((..._args: unknown[]) => {
    return {
      stdout: new ReadableStream({
        start(controller) {
          for (const c of stdoutChunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("runColdStartOnce (S1)", () => {
  test("returns COLD_START_SAMPLES_PER_RUN finite samples", async () => {
    const samples = await runColdStartOnce(
      { runs: 1, runner: "local-dev" },
      { spawn: fakeSpawn(["[gateway] ready (0.1.0) IPC /tmp/sock\n"]) },
    );
    expect(samples).toHaveLength(COLD_START_SAMPLES_PER_RUN);
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});
