import { describe, expect, test } from "bun:test";

import { RegistryError } from "./errors.ts";
import {
  assertSafeExtensionId,
  deriveExtensionServiceId,
  EXTENSION_SERVICE_ID_PATTERN,
  findServiceIdPrefixCollision,
  MAX_EXTENSION_ID_LENGTH,
} from "./extension-id.ts";

describe("assertSafeExtensionId", () => {
  test("rejects path traversal", () => {
    expect(() => assertSafeExtensionId("../evil")).toThrow();
    expect(() => assertSafeExtensionId("a/../b")).toThrow();
    expect(() => assertSafeExtensionId("@scope/pkg")).not.toThrow();
  });

  test("rejects ids longer than 128 characters", () => {
    expect(MAX_EXTENSION_ID_LENGTH).toBe(128);
    expect(() => assertSafeExtensionId("a".repeat(128))).not.toThrow();
    expect(() => assertSafeExtensionId("a".repeat(129))).toThrow(/too long/i);
    expect(() => assertSafeExtensionId(`@scope/${"a".repeat(200)}`)).toThrow(/too long/i);
  });

  test("empty string is rejected", () => {
    expect(() => assertSafeExtensionId("")).toThrow(/invalid extension id/i);
  });

  test("whitespace-only string is rejected", () => {
    expect(() => assertSafeExtensionId("   ")).toThrow(/invalid extension id/i);
  });

  test("string containing null byte is rejected", () => {
    expect(() => assertSafeExtensionId("foo\0bar")).toThrow(/invalid extension id/i);
  });

  test("slash-only or dot-slash yields empty parts and is rejected", () => {
    expect(() => assertSafeExtensionId("/")).toThrow(/invalid extension id/i);
    expect(() => assertSafeExtensionId("./")).toThrow(/invalid extension id/i);
  });
});

describe("deriveExtensionServiceId", () => {
  test("lowercases and maps every non-alphanumeric to _", () => {
    expect(deriveExtensionServiceId("Com.Example-Tool")).toBe("ext_com_example_tool");
  });

  test("refuses an id whose slug exceeds 62 characters with ERR_REGISTRY_MANIFEST_INVALID", () => {
    let thrown: unknown;
    try {
      deriveExtensionServiceId("a".repeat(63));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RegistryError);
    expect((thrown as RegistryError).code).toBe("ERR_REGISTRY_MANIFEST_INVALID");
    expect((thrown as RegistryError).message).toBe(
      `ERR_REGISTRY_MANIFEST_INVALID: extension id "${"a".repeat(63)}" does not yield a service id of 1-62 characters after "ext_"`,
    );
    expect(deriveExtensionServiceId("a".repeat(62))).toBe(`ext_${"a".repeat(62)}`);
  });

  test("the service id pattern is the ext_ namespace", () => {
    expect(EXTENSION_SERVICE_ID_PATTERN.test("ext_a")).toBe(true);
    expect(EXTENSION_SERVICE_ID_PATTERN.test("mcp_a")).toBe(false);
  });
});

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
