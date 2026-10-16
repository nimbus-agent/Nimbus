import { describe, expect, test } from "bun:test";

import { findServiceIdPrefixCollision } from "./service-id-prefix.ts";

describe("findServiceIdPrefixCollision", () => {
  test("equal, extends, and extended-by at an underscore boundary all collide", () => {
    expect(findServiceIdPrefixCollision("ext_a", ["ext_a"])).toBe("ext_a");
    expect(findServiceIdPrefixCollision("ext_a", ["ext_a_b"])).toBe("ext_a_b");
    expect(findServiceIdPrefixCollision("ext_a_b", ["ext_a"])).toBe("ext_a");
  });

  test("a shared prefix without an underscore boundary does not collide", () => {
    expect(findServiceIdPrefixCollision("ext_ab", ["ext_a"])).toBeUndefined();
    expect(findServiceIdPrefixCollision("ext_a", [])).toBeUndefined();
  });
});
