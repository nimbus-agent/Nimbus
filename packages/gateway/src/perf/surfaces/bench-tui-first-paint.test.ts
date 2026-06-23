import { describe, expect, test } from "bun:test";
import { runTuiFirstPaintOnce, TUI_FIRST_PAINT_SAMPLES_PER_RUN } from "./bench-tui-first-paint.ts";

function fakeSpawn(stderrChunks: string[]): typeof Bun.spawn {
  return ((..._args: unknown[]) => {
    return {
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          for (const c of stderrChunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("runTuiFirstPaintOnce (S4)", () => {
  test("returns TUI_FIRST_PAINT_SAMPLES_PER_RUN finite samples", async () => {
    const samples = await runTuiFirstPaintOnce(
      { runs: 1, runner: "local-dev" },
      { spawn: fakeSpawn(["[tui] first-frame\n"]) },
    );
    expect(samples).toHaveLength(TUI_FIRST_PAINT_SAMPLES_PER_RUN);
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
    }
  });
});
