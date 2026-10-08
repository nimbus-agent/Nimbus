import { describe, expect, test } from "bun:test";

import { agentRequestContext, getAgentRequestUserMcpExecutor } from "./agent-request-context.ts";
import type { ToolExecutor } from "./executor.ts";

describe("getAgentRequestUserMcpExecutor", () => {
  test("undefined outside a turn", () => {
    expect(getAgentRequestUserMcpExecutor()).toBeUndefined();
  });

  test("undefined inside a turn that carries none", () => {
    agentRequestContext.run({ sessionId: "s" }, () => {
      expect(getAgentRequestUserMcpExecutor()).toBeUndefined();
    });
  });

  test("returns the turn's own executor", () => {
    // Identity is all this getter promises; the executor's behaviour is not exercised here.
    const ex = { execute: async () => ({ status: "ok", result: null }) } as unknown as ToolExecutor;
    agentRequestContext.run({ userMcpExecutor: ex }, () => {
      expect(getAgentRequestUserMcpExecutor()).toBe(ex);
    });
  });
});
