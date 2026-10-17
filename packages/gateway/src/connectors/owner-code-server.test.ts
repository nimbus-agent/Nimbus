import { describe, expect, test } from "bun:test";

import { CONNECTOR_SERVICE_IDS } from "./connector-catalog.ts";
import {
  isOwnerCodeServerServiceId,
  isOwnerCodeServerToolKey,
  normalizeOwnerCodeServerServiceId,
  ownerCodeServerToolKeyForActionType,
} from "./owner-code-server.ts";

describe("owner-code-server predicates", () => {
  test("isOwnerCodeServerServiceId accepts mcp_ and ext_ ids only", () => {
    for (const id of ["mcp_a", "ext_a", "ext_a_b"]) {
      expect(isOwnerCodeServerServiceId(id)).toBe(true);
    }
    for (const id of ["ext_", "ext-a", "EXT_A", "github", "extension"]) {
      expect(isOwnerCodeServerServiceId(id)).toBe(false);
    }
  });

  test("no first-party connector service id is an owner code server id", () => {
    for (const id of CONNECTOR_SERVICE_IDS) {
      expect(isOwnerCodeServerServiceId(id)).toBe(false);
    }
  });

  test("ownerCodeServerToolKeyForActionType maps <service>.<tool> to <service>_<tool>", () => {
    expect(ownerCodeServerToolKeyForActionType("ext_foo.echo")).toBe("ext_foo_echo");
    expect(ownerCodeServerToolKeyForActionType("mcp_foo.echo")).toBe("mcp_foo_echo");
    expect(ownerCodeServerToolKeyForActionType("github.pr_list")).toBeUndefined();
    expect(ownerCodeServerToolKeyForActionType("ext_foo.")).toBeUndefined();
  });

  test("isOwnerCodeServerToolKey", () => {
    expect(isOwnerCodeServerToolKey("ext_foo_echo")).toBe(true);
    expect(isOwnerCodeServerToolKey("mcp_foo_echo")).toBe(true);
    expect(isOwnerCodeServerToolKey("github_pr_list")).toBe(false);
  });

  test("normalizeOwnerCodeServerServiceId trims, lowercases, then validates", () => {
    expect(normalizeOwnerCodeServerServiceId("  EXT_Foo ")).toBe("ext_foo");
    expect(normalizeOwnerCodeServerServiceId("MCP_x")).toBe("mcp_x");
    expect(normalizeOwnerCodeServerServiceId("github")).toBeNull();
    expect(normalizeOwnerCodeServerServiceId(42)).toBeNull();
  });
});
