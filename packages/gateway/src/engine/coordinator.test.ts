import { describe, expect, test } from "bun:test";
import { Config } from "../config.ts";
import { AgentCoordinator, type SubTask } from "./coordinator.ts";

describe("AgentCoordinator", () => {
  test("executes a single sub-task and returns its result", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "sess1",
      parentId: "root",
      depth: 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [
      {
        taskType: "classification",
        prompt: "Is this a question?",
        execute: async () => ({ text: "yes", tokensIn: 1, tokensOut: 1 }),
      },
    ];

    const results = await coordinator.run(tasks);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("done");
    expect(results[0]?.text).toBe("yes");
  });

  test("stops at maxAgentDepth and returns error status", async () => {
    const maxDepth = Config.maxAgentDepth;
    const coordinator = new AgentCoordinator({
      sessionId: "sess2",
      parentId: "root",
      depth: maxDepth + 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [
      {
        taskType: "agent_step",
        prompt: "do something",
        execute: async () => ({ text: "done", tokensIn: 0, tokensOut: 0 }),
      },
    ];

    await expect(coordinator.run(tasks)).rejects.toThrow("Agent depth limit");
  });

  test("stops at maxToolCallsPerSession and returns error", async () => {
    const counter = { value: Config.maxToolCallsPerSession };
    const coordinator = new AgentCoordinator({
      sessionId: "sess3",
      parentId: "root",
      depth: 1,
      toolCallCount: counter,
    });

    const tasks: SubTask[] = [
      {
        taskType: "agent_step",
        prompt: "call a tool",
        execute: async () => {
          counter.value += 1;
          return { text: "result", tokensIn: 0, tokensOut: 0 };
        },
      },
    ];

    await expect(coordinator.run(tasks)).rejects.toThrow("Tool call limit");
  });

  test("marks rejected tasks as rejected status", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "sess4",
      parentId: "root",
      depth: 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [
      {
        taskType: "agent_step",
        prompt: "delete file",
        execute: async () => {
          throw new Error("User rejected");
        },
      },
    ];

    const results = await coordinator.run(tasks);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.errorText).toContain("User rejected");
  });

  test("preserves task ordering in the result array", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "sess5",
      parentId: "root",
      depth: 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [0, 1, 2].map((i) => ({
      taskType: "summarisation" as const,
      prompt: `step ${i}`,
      execute: async () => {
        return { text: `done ${i}`, tokensIn: 1, tokensOut: 1 };
      },
    }));

    const results = await coordinator.run(tasks);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.text)).toEqual(["done 0", "done 1", "done 2"]);
    expect(results.map((r) => r.taskIndex)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.status === "done")).toBe(true);
  });

  test("AgentCoordinator runs sub-tasks in parallel", async () => {
    const ctx = {
      sessionId: "s1",
      parentId: "p1",
      depth: 0,
      toolCallCount: { value: 0 },
    };
    const tasks: SubTask[] = Array.from({ length: 3 }, () => ({
      taskType: "agent_step",
      prompt: "",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { text: "ok", tokensIn: 0, tokensOut: 0 };
      },
    }));

    const start = performance.now();
    const results = await new AgentCoordinator(ctx).run(tasks);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "done")).toBe(true);
  });

  test("AgentCoordinator pre-checks tool-call cap before fan-out", async () => {
    let executes = 0;
    const ctx = {
      sessionId: "s1",
      parentId: "p1",
      depth: 0,
      toolCallCount: { value: 18 },
    };
    const tasks: SubTask[] = Array.from({ length: 5 }, () => ({
      taskType: "agent_step",
      prompt: "",
      execute: async () => {
        executes += 1;
        return { text: "ok", tokensIn: 0, tokensOut: 0 };
      },
    }));

    await expect(new AgentCoordinator(ctx).run(tasks)).rejects.toThrow(/Tool call limit reached/);
    expect(executes).toBe(0);
  });

  test("includes modelUsed in result when execute returns a modelUsed value (L68 branch)", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "sess-model",
      parentId: "root",
      depth: 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [
      {
        taskType: "reasoning",
        prompt: "Solve this",
        execute: async () => ({
          text: "answer",
          tokensIn: 10,
          tokensOut: 5,
          modelUsed: "claude-sonnet-4-6",
        }),
      },
    ];

    const results = await coordinator.run(tasks);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("done");
    expect(results[0]?.modelUsed).toBe("claude-sonnet-4-6");
  });

  test("converts non-Error thrown value to string in errorText (L75 branch)", async () => {
    const coordinator = new AgentCoordinator({
      sessionId: "sess-nonerr",
      parentId: "root",
      depth: 1,
      toolCallCount: { value: 0 },
    });

    const tasks: SubTask[] = [
      {
        taskType: "classification",
        prompt: "classify",
        execute: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "plain string error";
        },
      },
    ];

    const results = await coordinator.run(tasks);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.errorText).toBe("plain string error");
  });

  test("AgentCoordinator returns sibling status: done when one task throws", async () => {
    const ctx = {
      sessionId: "s1",
      parentId: "p1",
      depth: 0,
      toolCallCount: { value: 0 },
    };
    const tasks: SubTask[] = [
      {
        taskType: "agent_step",
        prompt: "",
        execute: async () => ({ text: "a", tokensIn: 0, tokensOut: 0 }),
      },
      {
        taskType: "agent_step",
        prompt: "",
        execute: async () => {
          throw new Error("boom");
        },
      },
      {
        taskType: "agent_step",
        prompt: "",
        execute: async () => ({ text: "c", tokensIn: 0, tokensOut: 0 }),
      },
    ];

    const results = await new AgentCoordinator(ctx).run(tasks);

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("done");
    expect(results[1]?.status).toBe("error");
    expect(results[1]?.errorText).toBe("boom");
    expect(results[2]?.status).toBe("done");
  });
});
