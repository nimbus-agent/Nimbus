import { expect, test } from "bun:test";
import * as rf from "@nimbus-dev/registry-format";

test("cli resolves @nimbus-dev/registry-format", () => {
  expect(rf.REGISTRY_FORMAT_VERSION).toBe(1);
});
