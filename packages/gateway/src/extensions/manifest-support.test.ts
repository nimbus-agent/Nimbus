import { describe, expect, test } from "bun:test";

import { rangesOf } from "./manifest-support.ts";

describe("rangesOf", () => {
  test("rangesOf returns every range", () => {
    expect(
      rangesOf({ a: { range: "^1" }, b: { range: "1.x", registry: "nimbus-official" } }),
    ).toEqual({ a: "^1", b: "1.x" });
    expect(rangesOf(undefined)).toEqual({});
  });
});
