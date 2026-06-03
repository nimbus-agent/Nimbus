import { describe, expect, test } from "bun:test";

describe("desktop e2e smoke", () => {
  test("workspace is wired for bun test discovery", () => {
    // The point of this smoke test is that bun discovers and runs it; assert
    // the bun runtime is actually the thing executing it.
    expect(process.versions.bun).toBeTruthy();
  });
});
