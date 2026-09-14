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
        params: { name: "rate" },
      });
      expect(getExplainToolCalls()).toHaveLength(1);
      expect(getExplainToolCalls()?.[0]?.toolId).toBe("searchLocalIndex");
      expect(getExplainToolCalls()?.[0]?.paramsJson).toBe('{"name":"rate"}');
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
            params: undefined,
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
        params: undefined,
      }),
    ).not.toThrow();
    expect(getExplainToolCalls()).toBeUndefined();
  });

  test("a circular params object fails redaction/serialization silently — the call is never lost, the diagnostic just is", () => {
    // The try/catch in `recordExplainToolCall` exists exactly for this: `redactAuditPayload` /
    // `JSON.stringify` can throw on pathological input (a circular reference, a BigInt field) the
    // wrapper's `params: unknown` type rules out neither. Deleting that try/catch leaves every
    // OTHER test in this file green — only a case like this one, whose `params` actually throws
    // on serialization, distinguishes "swallowed" from "never happened".
    agentRequestContext.run({}, () => {
      const circular: Record<string, unknown> = { toolId: "circular" };
      circular["self"] = circular;
      expect(() =>
        recordExplainToolCall({
          toolId: "circularTool",
          service: "nimbus",
          status: "ok",
          durationMs: 3,
          params: circular,
        }),
      ).not.toThrow();
      // The diagnostic is lost (this call never makes it into the collected list) — but the
      // real tool call it rides along has already succeeded, and recording must never break that.
      expect(getExplainToolCalls()).toBeUndefined();
    });
  });

  test("a BigInt-bearing params object fails serialization silently, same guarantee", () => {
    agentRequestContext.run({}, () => {
      expect(() =>
        recordExplainToolCall({
          toolId: "bigIntTool",
          service: "nimbus",
          status: "ok",
          durationMs: 1,
          params: { amount: 10n },
        }),
      ).not.toThrow();
      expect(getExplainToolCalls()).toBeUndefined();
    });
  });
});
