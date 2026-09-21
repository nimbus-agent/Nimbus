import { describe, expect, test } from "bun:test";
import { CliExit, classifyTopLevelError } from "./cli-exit.ts";

describe("CliExit", () => {
  test("carries its code and a stable name", () => {
    const e = new CliExit(2);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CliExit");
    expect(e.code).toBe(2);
  });

  test("refuses a code that is not a positive integer below 256", () => {
    expect(() => new CliExit(0)).toThrow(RangeError);
    expect(() => new CliExit(1.5)).toThrow(RangeError);
    expect(() => new CliExit(256)).toThrow(RangeError);
  });
});

describe("classifyTopLevelError", () => {
  test("a CliExit is silent and keeps its code", () => {
    expect(classifyTopLevelError(new CliExit(2))).toEqual({ kind: "cli-exit", code: 2 });
  });
  test("an ordinary Error is printed", () => {
    expect(classifyTopLevelError(new Error("boom"))).toEqual({ kind: "error", message: "boom" });
  });
  test("a non-Error throw is stringified", () => {
    expect(classifyTopLevelError("nope")).toEqual({ kind: "error", message: "nope" });
  });
});
