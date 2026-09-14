import { describe, expect, test } from "bun:test";
import {
  agentRequestContext,
  getExplainToolCalls,
  recordExplainToolCall,
} from "./agent-request-context.ts";

describe("in-process tool collection (spec §4.5)", () => {
  test("calls are collected per turn, with no session id involved", () => {
    // The whole point: a plain `nimbus ask` passes no session, so agent.ts logs session_id NULL
    // and a time-window join would conflate concurrent asks.
    agentRequestContext.run({}, () => {
      recordExplainToolCall({
        toolId: "searchLocalIndex",
        service: "nimbus",
        status: "ok",
        durationMs: 12,
        paramsJson: '{"name":"rate"}',
      });
      expect(getExplainToolCalls()).toHaveLength(1);
      expect(getExplainToolCalls()?.[0]?.toolId).toBe("searchLocalIndex");
    });
  });

  test("two concurrent turns do not see each other's calls", async () => {
    const turn = (id: string): Promise<readonly unknown[]> =>
      new Promise((resolve) => {
        agentRequestContext.run({}, () => {
          recordExplainToolCall({
            toolId: id,
            service: "nimbus",
            status: "ok",
            durationMs: 1,
            paramsJson: null,
          });
          setTimeout(() => resolve(getExplainToolCalls() ?? []), 5);
        });
      });
    const [a, b] = await Promise.all([turn("toolA"), turn("toolB")]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("recording outside a turn is a no-op, never a throw", () => {
    expect(() =>
      recordExplainToolCall({
        toolId: "x",
        service: "y",
        status: "ok",
        durationMs: 0,
        paramsJson: null,
      }),
    ).not.toThrow();
    expect(getExplainToolCalls()).toBeUndefined();
  });
});
