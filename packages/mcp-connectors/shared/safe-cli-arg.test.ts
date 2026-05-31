import { describe, expect, it } from "bun:test";

import { assertSafeCliArg } from "./safe-cli-arg.ts";

describe("assertSafeCliArg", () => {
  it("returns safe values unchanged", () => {
    expect(assertSafeCliArg("my-sink_1.v2", "sinkName")).toBe("my-sink_1.v2");
    expect(assertSafeCliArg("/aws/lambda/api")).toBe("/aws/lambda/api");
    expect(assertSafeCliArg("project:dataset.table")).toBe("project:dataset.table");
  });

  it("rejects values that start with '-' (argv flag smuggling)", () => {
    expect(() => assertSafeCliArg("--project=attacker", "sinkName")).toThrow(/flag smuggling/);
    expect(() => assertSafeCliArg("-h")).toThrow(/flag smuggling/);
    expect(() => assertSafeCliArg("-")).toThrow(/flag smuggling/);
  });

  it("rejects empty and over-long values", () => {
    expect(() => assertSafeCliArg("")).toThrow(/non-empty/);
    expect(() => assertSafeCliArg("x".repeat(1025))).toThrow(/1024/);
  });

  it("rejects control characters (newline / tab)", () => {
    expect(() => assertSafeCliArg("line\nbreak")).toThrow(/control characters/);
    expect(() => assertSafeCliArg("tab\tchar")).toThrow(/control characters/);
  });

  it("allows spaces — an argv element is a single token (no shell)", () => {
    expect(assertSafeCliArg("severity >= ERROR")).toBe("severity >= ERROR");
  });

  it("includes the label in the error", () => {
    expect(() => assertSafeCliArg("-x", "logGroupName")).toThrow(/logGroupName/);
  });
});
