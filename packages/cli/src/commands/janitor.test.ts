import { expect, test } from "bun:test";
import { parseJanitorArgs } from "./janitor.ts";

test("parses ref + flags", () => {
  expect(
    parseJanitorArgs([
      "i-12345",
      "--idle-days",
      "30",
      "--cleanup",
      "cloud.instance.terminate",
      "--allow-gaps",
      "--json",
    ]),
  ).toEqual({
    resourceRef: "i-12345",
    idleDays: 30,
    cleanupAction: "cloud.instance.terminate",
    allowGaps: true,
    json: true,
  });
});

test("defaults idle-days 14, no cleanup, strict, non-json", () => {
  expect(parseJanitorArgs(["i-12345"])).toEqual({
    resourceRef: "i-12345",
    idleDays: 14,
    cleanupAction: null,
    allowGaps: false,
    json: false,
  });
});

test("rejects a flag-shaped value and a missing ref", () => {
  expect(() => parseJanitorArgs(["i-12345", "--cleanup", "--json"])).toThrow();
  expect(() => parseJanitorArgs(["--json"])).toThrow();
  expect(() => parseJanitorArgs(["i-12345", "--idle-days", "0"])).toThrow();
});
