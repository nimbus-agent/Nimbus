import { describe, expect, test } from "bun:test";
import { assertNeverBrief } from "./brief-kinds.ts";

describe("assertNeverBrief", () => {
  // The runtime throw is unreachable while `SynthInput` and its dispatch arms agree — see
  // the docstring on `assertNeverBrief` itself. That "unreachable in production" status is
  // exactly why this must be tested directly rather than only exercised transitively: it is
  // the error a future maintainer sees the moment they add a fifteenth brief kind and miss
  // an arm, and a `never`-typed parameter means the only way to call it is a deliberate
  // cast-through-`unknown`, same as a real future bug would produce at the call site.
  test("throws naming the unhandled kind", () => {
    const bogus = { kind: "sometime-future-kind" } as unknown as never;
    expect(() => assertNeverBrief(bogus)).toThrow(
      "synthesize: unhandled brief kind sometime-future-kind",
    );
  });

  // `String(undefined)` is "undefined", not an empty string or a throw — pin that so the
  // message stays informative (rather than blank) even when the bad value has no `kind` at
  // all, which is the shape a non-object or an entirely wrong type would take.
  test('names the kind as "undefined" when the value has none', () => {
    const bogus = {} as unknown as never;
    expect(() => assertNeverBrief(bogus)).toThrow("synthesize: unhandled brief kind undefined");
  });
});
