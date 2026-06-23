import { describe, expect, test } from "bun:test";
import { CLI_WARM_SAMPLES_PER_RUN, runCliOverheadWarmOnce } from "./bench-cli-overhead-warm.ts";
import { fakeSpawnExitsClean } from "./spawn-test-helpers.ts";

describe("runCliOverheadWarmOnce (S11-b)", () => {
  test("returns CLI_WARM_SAMPLES_PER_RUN finite samples", async () => {
    const samples = await runCliOverheadWarmOnce(
      { runs: 1, runner: "local-dev" },
      { spawn: fakeSpawnExitsClean() },
    );
    expect(samples).toHaveLength(CLI_WARM_SAMPLES_PER_RUN);
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
    }
  });
});
