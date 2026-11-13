import { describe, expect, test } from "bun:test";

import { ACTION_REJECT_CODES, CaptureError } from "./capture-types.ts";

describe("the codes a rejected action may carry (AD3a-2a)", () => {
  test("every reject code fits the V97 error_code CHECK (at most 64 characters)", () => {
    expect(ACTION_REJECT_CODES.length).toBeGreaterThan(0);
    for (const c of ACTION_REJECT_CODES) expect(c.length).toBeLessThanOrEqual(64);
  });
  test("ERR_AGENT_TOOL_SUSPENDED is a capture error code and the first reject code", () => {
    expect(new CaptureError("ERR_AGENT_TOOL_SUSPENDED", "x").code).toBe("ERR_AGENT_TOOL_SUSPENDED");
    expect(ACTION_REJECT_CODES).toContain("ERR_AGENT_TOOL_SUSPENDED");
  });
});
