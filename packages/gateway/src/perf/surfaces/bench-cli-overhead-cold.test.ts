import { describe, expect, test } from "bun:test";
import { CLI_COLD_SAMPLES_PER_RUN, runCliOverheadColdOnce } from "./bench-cli-overhead-cold.ts";
import { fakeSpawnExitsClean } from "./spawn-test-helpers.ts";

describe("runCliOverheadColdOnce (S11-a)", () => {
  test("returns CLI_COLD_SAMPLES_PER_RUN finite samples", async () => {
    const samples = await runCliOverheadColdOnce(
      { runs: 1, runner: "local-dev" },
      { spawn: fakeSpawnExitsClean() },
    );
    expect(samples).toHaveLength(CLI_COLD_SAMPLES_PER_RUN);
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
    }
  });
});
