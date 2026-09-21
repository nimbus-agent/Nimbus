import { expect, test } from "bun:test";
import { TOUR_STEP_KINDS, TOUR_STEPS_MAX } from "./tour-types.ts";

test("the step cap can never exceed the number of kinds", () => {
  expect(TOUR_STEPS_MAX).toBe(TOUR_STEP_KINDS.length);
  expect(new Set(TOUR_STEP_KINDS).size).toBe(TOUR_STEP_KINDS.length);
});
