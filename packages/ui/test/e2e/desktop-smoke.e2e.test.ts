import { describe, expect, test } from "bun:test";

describe("desktop e2e smoke", () => {
  test("workspace is wired for bun test discovery", () => {
    expect(true).toBe(true);
  });
});
