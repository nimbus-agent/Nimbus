import { describe, expect, mock, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import { Config } from "../config.ts";
import type { LlmRouter } from "../llm/router.ts";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts";
import { runAsk } from "./run-ask.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";
import { type GasLimitEvent, stepBudgetExhaustedLine } from "./step-budget.ts";

const CAP = Config.conversationalAgentMaxSteps;

function steps(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ stepIndex: i }));
}

function generateAgent(opts: { text: string; steps?: number; finishReason?: string }): Agent {
  return {
    generate: mock(async () => ({
      text: opts.text,
      ...(opts.steps === undefined ? {} : { steps: steps(opts.steps) }),
      ...(opts.finishReason === undefined ? {} : { finishReason: opts.finishReason }),
    })),
  } as unknown as Agent;
}

async function* oneDelta(text: string) {
  yield { type: "text-delta" as const, payload: { text } };
}

function streamAgent(opts: { text: string; steps: number; finishReason: string }): Agent {
  return {
    stream: mock(async () => ({
      fullStream: oneDelta(opts.text),
      text: Promise.resolve(opts.text),
      steps: Promise.resolve(steps(opts.steps)),
      finishReason: Promise.resolve(opts.finishReason),
    })),
  } as unknown as Agent;
}

describe("step-budget exhaustion (non-stream)", () => {
  test("cap reached while the model still wanted tools: disclosed, recorded, notified", async () => {
    const events: GasLimitEvent[] = [];
    const r = await runConversationalAgent({
      agent: generateAgent({ text: "partial answer", steps: CAP, finishReason: "tool-calls" }),
      input: "summarize everything",
      stream: false,
      sendChunk: () => undefined,
      notifyGasLimit: (e) => events.push(e),
    });
    expect(r.reply).toBe(`partial answer\n\n${stepBudgetExhaustedLine(CAP)}`);
    expect(r.stepBudgetExhausted).toEqual({ cap: CAP, used: CAP });
    expect(events).toEqual([{ limit: "steps", cap: CAP, used: CAP }]);
  });

  test("exactly at the cap but finished with 'stop' is NOT exhausted (identity reply)", async () => {
    const notify = mock((_e: GasLimitEvent) => undefined);
    const r = await runConversationalAgent({
      agent: generateAgent({ text: "complete answer", steps: CAP, finishReason: "stop" }),
      input: "summarize everything",
      stream: false,
      sendChunk: () => undefined,
      notifyGasLimit: notify,
    });
    expect(r.reply).toBe("complete answer");
    expect(r.stepBudgetExhausted).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  test("'tool-calls' below the cap is NOT exhausted", async () => {
    const r = await runConversationalAgent({
      agent: generateAgent({ text: "answer", steps: CAP - 1, finishReason: "tool-calls" }),
      input: "q",
      stream: false,
      sendChunk: () => undefined,
    });
    expect(r.reply).toBe("answer");
    expect(r.stepBudgetExhausted).toBeUndefined();
  });

  test("an agent output with no steps/finishReason is NOT exhausted", async () => {
    const r = await runConversationalAgent({
      agent: generateAgent({ text: "answer" }),
      input: "q",
      stream: false,
      sendChunk: () => undefined,
    });
    expect(r.reply).toBe("answer");
    expect(r.stepBudgetExhausted).toBeUndefined();
  });

  test("no notifier wired (ChatOps/workflow): the disclosure still reaches the reply", async () => {
    const r = await runConversationalAgent({
      agent: generateAgent({ text: "partial", steps: CAP + 1, finishReason: "tool-calls" }),
      input: "q",
      stream: false,
      sendChunk: () => undefined,
    });
    expect(r.reply).toContain(stepBudgetExhaustedLine(CAP));
    expect(r.stepBudgetExhausted).toEqual({ cap: CAP, used: CAP + 1 });
  });

  test("the local router (toolless) path never exhausts", async () => {
    const router = {
      generate: mock(async () => ({
        text: "local",
        finishReason: "tool-calls",
        steps: steps(CAP),
      })),
      prefersLocal: () => true,
      enforcesAirGap: () => false,
    } as unknown as LlmRouter;
    const notify = mock((_e: GasLimitEvent) => undefined);
    const r = await runConversationalAgent({
      llmRouter: router,
      input: "hello there",
      stream: false,
      sendChunk: () => undefined,
      notifyGasLimit: notify,
    });
    expect(r.reply).toBe("local");
    expect(r.stepBudgetExhausted).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("step-budget exhaustion (stream)", () => {
  test("a REJECTED steps/finishReason promise reads as not exhausted, never fails the turn", async () => {
    // @mastra/core rejects any delayed promise still pending when the stream finishes.
    const agent = {
      stream: mock(async () => {
        const unresolved = Promise.reject(new Error("promise 'steps' was not resolved"));
        unresolved.catch(() => undefined);
        return {
          fullStream: oneDelta("answer"),
          text: Promise.resolve("answer"),
          steps: unresolved,
          finishReason: unresolved,
        };
      }),
    } as unknown as Agent;
    const r = await runConversationalAgent({
      agent,
      input: "q",
      stream: true,
      sendChunk: () => undefined,
    });
    expect(r.reply).toBe("answer");
    expect(r.stepBudgetExhausted).toBeUndefined();
  });

  test("the disclosure arrives as the final chunk and in the reply", async () => {
    const chunks: string[] = [];
    const events: GasLimitEvent[] = [];
    const r = await runConversationalAgent({
      agent: streamAgent({ text: "partial", steps: CAP, finishReason: "tool-calls" }),
      input: "q",
      stream: true,
      sendChunk: (t) => chunks.push(t),
      notifyGasLimit: (e) => events.push(e),
    });
    expect(chunks.at(-1)).toBe(`\n\n${stepBudgetExhaustedLine(CAP)}`);
    expect(r.reply).toBe(`partial\n\n${stepBudgetExhaustedLine(CAP)}`);
    expect(events).toEqual([{ limit: "steps", cap: CAP, used: CAP }]);
  });

  test("a streamed turn that stopped normally at the cap sends no extra chunk", async () => {
    const chunks: string[] = [];
    const r = await runConversationalAgent({
      agent: streamAgent({ text: "done", steps: CAP, finishReason: "stop" }),
      input: "q",
      stream: true,
      sendChunk: (t) => chunks.push(t),
    });
    expect(chunks).toEqual(["done"]);
    expect(r.reply).toBe("done");
  });
});

describe("step-budget exhaustion through runAsk", () => {
  test("explain record carries stepBudgetExhausted and the notifier is threaded", async () => {
    const recorder = new AskExplainRecorder();
    const events: GasLimitEvent[] = [];
    const reply = await runAsk({
      ...makeRunAskParams({ input: "list my PRs", explainRecorder: recorder }),
      conversationalAgent: generateAgent({
        text: "partial",
        steps: CAP,
        finishReason: "tool-calls",
      }),
      notifyGasLimit: (e) => events.push(e),
    });
    expect(reply.reply).toContain(stepBudgetExhaustedLine(CAP));
    expect(recorder.last()?.stepBudgetExhausted).toEqual({ cap: CAP, used: CAP });
    expect(events).toEqual([{ limit: "steps", cap: CAP, used: CAP }]);
  });

  test("a normal turn records no stepBudgetExhausted", async () => {
    const recorder = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "list my PRs", explainRecorder: recorder }));
    expect(recorder.last()?.stepBudgetExhausted).toBeUndefined();
  });
});
