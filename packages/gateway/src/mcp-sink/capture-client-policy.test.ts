import { describe, expect, test } from "bun:test";

import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";

describe("CAPTURE_ROLE_BY_KIND", () => {
  test("only mcp submits; mcp is never owner; derived kinds are refused", () => {
    expect(CAPTURE_ROLE_BY_KIND).toEqual({
      mcp: "submit",
      cli: "owner",
      ui: "owner",
      unknown: "owner",
      http: "refuse",
      chatops: "refuse",
      fleet: "refuse",
      push: "refuse",
    });
  });
});
