import { describe, expect, test } from "bun:test";
import { parseMode } from "./main.ts";

describe("parseMode", () => {
  test("accepts check and sign", () => {
    expect(parseMode("check")).toBe("check");
    expect(parseMode("sign")).toBe("sign");
  });

  test.each(["", "Check", "sign ", "publish"])("refuses %p with a clear message", (raw) => {
    expect(() => parseMode(raw)).toThrow(
      `input "mode" must be "check" or "sign"; got ${JSON.stringify(raw)}`,
    );
  });
});
