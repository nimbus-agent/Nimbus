import { describe, expect, test } from "bun:test";

import { CONNECTOR_SERVICE_IDS } from "../connectors/connector-catalog.ts";
import {
  assertExtensionServiceIdFree,
  deriveExtensionServiceId,
  EXTENSION_SERVICE_ID_PATTERN,
} from "./extension-service-id.ts";

describe("deriveExtensionServiceId", () => {
  test("lowercases and maps every non-alphanumeric to _", () => {
    expect(deriveExtensionServiceId("Com.Example-Tool")).toBe("ext_com_example_tool");
  });

  test("refuses an id whose slug exceeds 62 characters", () => {
    expect(() => deriveExtensionServiceId("a".repeat(63))).toThrow(
      /ERR_EXTENSION_SERVICE_ID_INVALID/,
    );
    expect(deriveExtensionServiceId("a".repeat(62))).toBe(`ext_${"a".repeat(62)}`);
  });

  test("no first-party connector id lives in the ext_ namespace", () => {
    expect(CONNECTOR_SERVICE_IDS.filter((id) => id.startsWith("ext_"))).toEqual([]);
    expect(EXTENSION_SERVICE_ID_PATTERN.test("ext_a")).toBe(true);
    expect(EXTENSION_SERVICE_ID_PATTERN.test("mcp_a")).toBe(false);
  });
});

describe("assertExtensionServiceIdFree", () => {
  test("two manifest ids that slug to the same service id collide", () => {
    const first = deriveExtensionServiceId("a.b");
    expect(() => assertExtensionServiceIdFree(deriveExtensionServiceId("a_b"), [first])).toThrow(
      /ERR_EXTENSION_SERVICE_ID_COLLISION/,
    );
  });

  test("a prefix at an underscore boundary collides in both directions", () => {
    expect(() => assertExtensionServiceIdFree("ext_a_b", ["ext_a"])).toThrow(/COLLISION/);
    expect(() => assertExtensionServiceIdFree("ext_a", ["ext_a_b"])).toThrow(/COLLISION/);
    expect(() => assertExtensionServiceIdFree("ext_ab", ["ext_a"])).not.toThrow();
  });
});
