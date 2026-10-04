/**
 * run-conversational-agent.coverage.test.ts — the arms of run-conversational-agent.ts the main
 * suite leaves open: malformed stream chunks, the local router fed prior turns, an empty streamed
 * token, and a turn with neither an agent nor a router to answer it.
 */
import { describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";
import type { LlmRouter } from "../llm/router.ts";
import type { LlmGenerateOptions } from "../llm/types.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";

async function* chunks(items: readonly unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

function routerReturning(
  text: string,
  onCall: (opts: LlmGenerateOptions) => void,
  emitTokens: readonly string[] = [],
): LlmRouter {
  return {
    prefersLocal: () => true,
    enforcesAirGap: () => false,
    generate: (opts: LlmGenerateOptions) => {
      onCall(opts);
      for (const t of emitTokens) opts.onToken?.(t);
      return Promise.resolve({
        text,
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: "local-model",
        isLocal: true,
        provider: "ollama",
      });
    },
  } as unknown as LlmRouter;
}

describe("runConversationalAgent — streaming through the agent", () => {
  test("only well-formed, non-empty text-delta chunks are forwarded", async () => {
    const sent: string[] = [];
    const agent = {
      stream: () =>
        Promise.resolve({
          fullStream: chunks([
            null,
            ["text-delta"],
            "text-delta",
            { type: "tool-call", payload: { text: "not text" } },
            { type: "text-delta", payload: null },
            { type: "text-delta", payload: ["x"] },
            { type: "text-delta", payload: { text: 7 } },
            { type: "text-delta", payload: { text: "" } },
            { type: "text-delta", payload: { text: "Hel" } },
            { type: "text-delta", payload: { text: "lo" } },
          ]),
          text: Promise.resolve("Hello"),
        }),
    } as unknown as Agent;
    const r = await runConversationalAgent({
      agent,
      input: "say hello",
      stream: true,
      sendChunk: (t) => sent.push(t),
    });
    expect(sent).toEqual(["Hel", "lo"]);
    expect(r.reply).toBe("Hello");
    expect(r.toolless).toBe(false);
  });
});

describe("runConversationalAgent — the local router", () => {
  test("prior turns are flattened into one role-labelled prompt; a tool turn reads as user", async () => {
    const prompts: string[] = [];
    const r = await runConversationalAgent({
      llmRouter: routerReturning("answer", (o) => prompts.push(o.prompt)),
      input: "and now?",
      stream: false,
      sendChunk: () => {},
      priorTurns: [
        { role: "user", text: "first question" },
        { role: "assistant", text: "first answer" },
        { role: "tool", text: "tool output" },
      ],
    });
    expect(r.reply).toBe("answer");
    expect(r.toolless).toBe(true);
    expect(prompts).toEqual([
      "user: first question\n\nassistant: first answer\n\nuser: tool output\n\nuser: and now?",
    ]);
  });

  test("an empty streamed token is not forwarded, and a streamed reply is not re-sent whole", async () => {
    const sent: string[] = [];
    const r = await runConversationalAgent({
      llmRouter: routerReturning("Hi there", () => {}, ["", "Hi", " there"]),
      input: "greet me",
      stream: true,
      sendChunk: (t) => sent.push(t),
    });
    expect(sent).toEqual(["Hi", " there"]);
    expect(r.reply).toBe("Hi there");
  });

  test("a router that streamed nothing has its whole reply sent once", async () => {
    const sent: string[] = [];
    await runConversationalAgent({
      llmRouter: routerReturning("whole reply", () => {}, [""]),
      input: "greet me",
      stream: true,
      sendChunk: (t) => sent.push(t),
    });
    expect(sent).toEqual(["whole reply"]);
  });
});

describe("runConversationalAgent — nothing to answer with", () => {
  test("no agent and no router is a plain error, not an agent-unavailable one", async () => {
    let caught: unknown;
    try {
      await runConversationalAgent({ input: "anyone there?", stream: false, sendChunk: () => {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as Error).message).toBe(
      "No conversational agent or local LLM router configured",
    );
  });
});
