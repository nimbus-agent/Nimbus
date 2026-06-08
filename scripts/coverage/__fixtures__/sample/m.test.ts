import { expect, test } from "bun:test";

import { classify } from "./m.ts";

test("classify covers some but not all branches", () => {
  expect(classify(4)).toBe("even"); // leaves the n<0 and n>100 branches unexercised
});
