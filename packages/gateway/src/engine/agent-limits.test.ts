import { afterEach, describe, expect, test } from "bun:test";

import {
  AGENT_LIMIT_DEFAULTS,
  getAgentLimits,
  readAgentLimitEnv,
  resetAgentLimitsForTests,
  resolveAgentLimits,
  setAgentLimits,
} from "./agent-limits.ts";
import { AgentCoordinator, AgentLimitError, type SubTask } from "./coordinator.ts";

afterEach(() => {
  resetAgentLimitsForTests();
});

function task(): SubTask {
  return {
    taskType: "agent_step",
    prompt: "t",
    execute: async () => ({ text: "ok", tokensIn: 0, tokensOut: 0 }),
  };
}

describe("resolveAgentLimits — env (set and valid) > toml > default", () => {
  test("defaults when neither env nor toml supplies a value", () => {
    expect(resolveAgentLimits({ env: {} })).toEqual(AGENT_LIMIT_DEFAULTS);
    expect(AGENT_LIMIT_DEFAULTS).toEqual({ maxAgentDepth: 3, maxToolCallsPerSession: 20 });
  });

  test("toml wins over the default", () => {
    expect(
      resolveAgentLimits({ env: {}, toml: { maxAgentDepth: 5, maxToolCallsPerSession: 50 } }),
    ).toEqual({ maxAgentDepth: 5, maxToolCallsPerSession: 50 });
  });

  test("a set, valid env var wins over toml", () => {
    expect(
      resolveAgentLimits({
        env: { maxAgentDepth: "7", maxToolCallsPerSession: "150" },
        toml: { maxAgentDepth: 5, maxToolCallsPerSession: 50 },
      }),
    ).toEqual({ maxAgentDepth: 7, maxToolCallsPerSession: 150 });
  });

  test("an empty or invalid env var falls through to toml, per key", () => {
    expect(
      resolveAgentLimits({
        env: { maxAgentDepth: "", maxToolCallsPerSession: "999" },
        toml: { maxAgentDepth: 5, maxToolCallsPerSession: 50 },
      }),
    ).toEqual({ maxAgentDepth: 5, maxToolCallsPerSession: 50 });
    expect(
      resolveAgentLimits({ env: { maxAgentDepth: "0", maxToolCallsPerSession: "abc" } }),
    ).toEqual(AGENT_LIMIT_DEFAULTS);
  });

  test("an out-of-range toml value falls back to the default", () => {
    expect(
      resolveAgentLimits({ env: {}, toml: { maxAgentDepth: 11, maxToolCallsPerSession: 0 } }),
    ).toEqual(AGENT_LIMIT_DEFAULTS);
  });

  test("readAgentLimitEnv reads the two NIMBUS_* names through the injected getter", () => {
    const seen: string[] = [];
    const env = readAgentLimitEnv((name) => {
      seen.push(name);
      return name === "NIMBUS_MAX_AGENT_DEPTH" ? "4" : undefined;
    });
    expect(seen.sort()).toEqual(["NIMBUS_MAX_AGENT_DEPTH", "NIMBUS_MAX_TOOL_CALLS_PER_SESSION"]);
    expect(env).toEqual({ maxAgentDepth: "4" });
  });
});

describe("the boot-resolved limits reach the coordinator", () => {
  test("getAgentLimits returns what boot set", () => {
    setAgentLimits({ maxAgentDepth: 2, maxToolCallsPerSession: 9 });
    expect(getAgentLimits()).toEqual({ maxAgentDepth: 2, maxToolCallsPerSession: 9 });
  });

  test("a TOML tool-call cap is honoured by AgentCoordinator", async () => {
    setAgentLimits(
      resolveAgentLimits({ env: {}, toml: { maxAgentDepth: 3, maxToolCallsPerSession: 2 } }),
    );
    const coordinator = new AgentCoordinator({
      sessionId: "s",
      parentId: "p",
      depth: 1,
      toolCallCount: { value: 0 },
    });
    const err = await coordinator.run([task(), task(), task()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentLimitError);
    expect((err as AgentLimitError).limit).toBe("tool_calls");
    expect((err as AgentLimitError).cap).toBe(2);
  });

  test("a TOML depth cap is honoured by AgentCoordinator", async () => {
    setAgentLimits(
      resolveAgentLimits({ env: {}, toml: { maxAgentDepth: 1, maxToolCallsPerSession: 20 } }),
    );
    const coordinator = new AgentCoordinator({
      sessionId: "s",
      parentId: "p",
      depth: 2,
      toolCallCount: { value: 0 },
    });
    const err = await coordinator.run([task()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentLimitError);
    expect((err as AgentLimitError).limit).toBe("depth");
  });
});

describe("AgentLimitError", () => {
  test("carries a stable ERR_AGENT_LIMIT_REACHED code in the message prefix", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "s",
      parentId: "p",
      depth: AGENT_LIMIT_DEFAULTS.maxAgentDepth + 1,
      toolCallCount: { value: 0 },
    });
    const err = await coordinator.run([task()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentLimitError);
    const e = err as AgentLimitError;
    expect(e.code).toBe("ERR_AGENT_LIMIT_REACHED");
    expect(e.message.startsWith("ERR_AGENT_LIMIT_REACHED:")).toBe(true);
    expect(e.limit).toBe("depth");
    expect(e.cap).toBe(AGENT_LIMIT_DEFAULTS.maxAgentDepth);
    expect(e.attempted).toBe(AGENT_LIMIT_DEFAULTS.maxAgentDepth + 1);
  });

  test("tool_calls reports the count the batch would have reached", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "s",
      parentId: "p",
      depth: 1,
      toolCallCount: { value: AGENT_LIMIT_DEFAULTS.maxToolCallsPerSession - 1 },
    });
    const err = await coordinator.run([task(), task()]).catch((e: unknown) => e);
    const e = err as AgentLimitError;
    expect(e.limit).toBe("tool_calls");
    expect(e.attempted).toBe(AGENT_LIMIT_DEFAULTS.maxToolCallsPerSession + 1);
  });
});
