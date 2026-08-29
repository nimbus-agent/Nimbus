import { describe, expect, test } from "bun:test";

import sharpStub from "./sharp-stub.ts";

/**
 * These assertions look trivial and are not: the stub's FALSINESS is the contract.
 *
 * `@xenova/transformers` selects its image backend with `else if (sharp)` in
 * `src/utils/image.js`. A stub that is truthy — `{}`, a no-op function, a class — would send it
 * down the sharp branch and then fail at the first real call, turning a clean "no image support"
 * into a crash inside the embedding worker. That is the failure this file exists to prevent, and
 * it is invisible to a type check, since every one of those shapes satisfies the same import.
 *
 * The stub is substituted into the worker bundle by `stubSharpPlugin` in
 * `scripts/build-workers.ts` — see `sharp-stub.ts` for why bundling the real native `sharp` broke
 * the embedding runtime outright (#1396).
 */
describe("sharp stub", () => {
  test("is falsy, which is what selects the non-sharp branch upstream", () => {
    expect(sharpStub).toBeFalsy();
  });

  // Pinned as `undefined` specifically, not merely falsy: `null`, `0` and `""` are also falsy but
  // would each be a deliberate signal to a reader. `undefined` is what an absent module yields.
  test("is exactly undefined", () => {
    expect(sharpStub).toBeUndefined();
  });
});
