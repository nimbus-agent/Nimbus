import { expect, test } from "bun:test";
import { REGISTRY_FORMAT_VERSION } from "./index.ts";

test("exposes the format version", () => {
  expect(REGISTRY_FORMAT_VERSION).toBe(1);
});
