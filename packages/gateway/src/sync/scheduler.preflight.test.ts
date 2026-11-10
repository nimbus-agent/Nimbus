/** `preflightRefusal`: the one reason a service cannot run at all, failing closed when the probe throws. */
import { describe, expect, test } from "bun:test";
import { preflightRefusal } from "./scheduler.ts";

describe("preflightRefusal", () => {
  test("a connector with no preflight, or one that passes, is not refused", () => {
    expect(preflightRefusal({})).toBeNull();
    expect(preflightRefusal({ preflight: () => null })).toBeNull();
  });

  test("the reason a preflight returns is the refusal", () => {
    expect(preflightRefusal({ preflight: () => "no credentials" })).toBe("no credentials");
  });

  test("a preflight that throws is a refusal naming the error, whatever it throws", () => {
    expect(
      preflightRefusal({
        preflight: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("preflight failed: boom");
    expect(
      preflightRefusal({
        preflight: () => {
          throw "plain string";
        },
      }),
    ).toBe("preflight failed: plain string");
  });
});
