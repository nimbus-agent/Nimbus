import { describe, expect, test } from "bun:test";
import { Config } from "../config.ts";
import { AgentCoordinator, type CoordinatorContext, type SubTask } from "./coordinator.ts";

function makeTask(label: string): SubTask {
  return {
    taskType: "agent_step",
    prompt: label,
    execute: async () => ({ text: `result:${label}`, tokensIn: 1, tokensOut: 1 }),
  };
}

function makeCtx(overrides: Partial<CoordinatorContext> = {}): CoordinatorContext {
  return {
    sessionId: "test-session",
    parentId: "test-parent",
    depth: 0,
    toolCallCount: { value: 0 },
    ...overrides,
  };
}

describe("Config defaults", () => {
  test("maxAgentDepth defaults to 3", () => {
    expect(Config.maxAgentDepth).toBe(3);
  });

  test("maxToolCallsPerSession defaults to 20", () => {
    expect(Config.maxToolCallsPerSession).toBe(20);
  });
});

describe("depth guard", () => {
  test("runs at exactly maxAgentDepth", async () => {
    const coordinator = new AgentCoordinator(makeCtx({ depth: Config.maxAgentDepth }));
    const results = await coordinator.run([makeTask("a")]);
    expect(results[0]?.status).toBe("done");
  });

  test("throws when depth exceeds maxAgentDepth", async () => {
    const coordinator = new AgentCoordinator(makeCtx({ depth: Config.maxAgentDepth + 1 }));
    await expect(coordinator.run([makeTask("a")])).rejects.toThrow("Agent depth limit reached");
  });
});

describe("tool call cap", () => {
  test("throws when toolCallCount is already at the cap before execution", async () => {
    const ctx = makeCtx({ toolCallCount: { value: Config.maxToolCallsPerSession } });
    const coordinator = new AgentCoordinator(ctx);
    await expect(coordinator.run([makeTask("a")])).rejects.toThrow("Tool call limit reached");
  });

  test("pre-checks cap before fan-out when batch would exceed it", async () => {
    const cap = Config.maxToolCallsPerSession;
    const ctx = makeCtx({ toolCallCount: { value: cap - 1 } });
    const coordinator = new AgentCoordinator(ctx);
    await expect(coordinator.run([makeTask("first"), makeTask("second")])).rejects.toThrow(
      "Tool call limit reached",
    );
    expect(ctx.toolCallCount.value).toBe(cap - 1);
  });

  test("shared counter across two coordinators", async () => {
    const cap = Config.maxToolCallsPerSession;
    const sharedCounter = { value: cap - 1 };
    const coord1 = new AgentCoordinator(makeCtx({ toolCallCount: sharedCounter }));
    const coord2 = new AgentCoordinator(makeCtx({ toolCallCount: sharedCounter }));

    await coord1.run([makeTask("from-coord1")]);
    expect(sharedCounter.value).toBe(cap);

    await expect(coord2.run([makeTask("from-coord2")])).rejects.toThrow("Tool call limit reached");
  });
});
