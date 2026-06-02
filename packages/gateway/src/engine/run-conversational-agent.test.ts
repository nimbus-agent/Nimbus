import { describe, expect, mock, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import type { LlmRouter } from "../llm/router.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";

async function* mockAgentTextDeltaStream() {
  yield { type: "text-delta" as const, payload: { text: "a" } };
  yield { type: "text-delta" as const, payload: { text: "b" } };
}

describe("runConversationalAgent", () => {
  test("returns empty reply for whitespace-only input", async () => {
    const agent = {} as Agent;
    const r = await runConversationalAgent({
      agent,
      input: "   \n\t  ",
      stream: false,
      sendChunk: () => {
        /* noop */
      },
    });
    expect(r.reply).toBe("");
  });

  test("non-stream uses generate text", async () => {
    const agent = {
      generate: mock(async () => ({ text: "ok" })),
    } as unknown as Agent;
    const r = await runConversationalAgent({
      agent,
      input: "hello",
      stream: false,
      sendChunk: () => {
        /* noop */
      },
    });
    expect(r.reply).toBe("ok");
    expect(agent.generate).toHaveBeenCalled();
  });

  test("stream forwards text-delta chunks and returns final text", async () => {
    const chunks: string[] = [];
    const agent = {
      stream: mock(async () => ({
        fullStream: mockAgentTextDeltaStream(),
        text: Promise.resolve("full"),
      })),
    } as unknown as Agent;
    const r = await runConversationalAgent({
      agent,
      input: "x",
      stream: true,
      sendChunk: (t) => {
        chunks.push(t);
      },
    });
    expect(chunks.join("")).toBe("ab");
    expect(r.reply).toBe("full");
  });

  test("local router path uses indexed context and returns model metadata", async () => {
    const generate = mock(async (opts: { prompt: string }) => ({
      text: "local answer",
      tokensIn: 10,
      tokensOut: 2,
      modelUsed: "local-test-model:latest",
      isLocal: true,
      provider: "ollama" as const,
      promptEcho: opts.prompt,
    }));
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    const r = await runConversationalAgent({
      llmRouter: router,
      input: "what happened?",
      stream: false,
      sendChunk: () => undefined,
      localContext: "Indexed Nimbus context:\n1. github/issue: add a smoke test",
    });
    expect(r.reply).toBe("local answer");
    expect(r.modelMeta?.modelUsed).toBe("local-test-model:latest");
    const firstCall = generate.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(firstCall?.prompt).toContain("Indexed Nimbus context");
    expect(firstCall?.prompt).toContain("what happened?");
  });

  test("local router streaming forwards provider tokens", async () => {
    const chunks: string[] = [];
    const generate = mock(async (opts: { onToken?: (token: string) => void }) => {
      opts.onToken?.("hel");
      opts.onToken?.("lo");
      return {
        text: "hello",
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: "local-test-model:latest",
        isLocal: true,
        provider: "ollama" as const,
      };
    });
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    const r = await runConversationalAgent({
      llmRouter: router,
      input: "say hello",
      stream: true,
      sendChunk: (text) => chunks.push(text),
    });
    expect(chunks.join("")).toBe("hello");
    expect(r.reply).toBe("hello");
  });

  test("local router streaming emits final text when provider does not stream tokens", async () => {
    const chunks: string[] = [];
    const generate = mock(async () => ({
      text: "llama.cpp final text",
      tokensIn: 1,
      tokensOut: 3,
      modelUsed: "local-test-model.gguf",
      isLocal: true,
      provider: "llamacpp" as const,
    }));
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    const r = await runConversationalAgent({
      llmRouter: router,
      input: "say hello",
      stream: true,
      sendChunk: (text) => chunks.push(text),
    });
    expect(chunks.join("")).toBe("llama.cpp final text");
    expect(r.reply).toBe("llama.cpp final text");
  });

  test("uses Mastra agent when local routing is not preferred", async () => {
    const agent = {
      generate: mock(async () => ({ text: "remote answer" })),
    } as unknown as Agent;
    const generate = mock(async () => ({
      text: "local answer",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "local-test-model:latest",
      isLocal: true,
      provider: "ollama" as const,
    }));
    const router = { generate, prefersLocal: () => false } as unknown as LlmRouter;
    const r = await runConversationalAgent({
      agent,
      llmRouter: router,
      input: "hello",
      stream: false,
      sendChunk: () => undefined,
    });
    expect(r.reply).toBe("remote answer");
    expect(generate).not.toHaveBeenCalled();
    expect(agent.generate).toHaveBeenCalled();
  });

  test("maps API key errors to GatewayAgentUnavailableError", async () => {
    const agent = {
      generate: mock(async () => {
        throw new Error("missing API key");
      }),
    } as unknown as Agent;
    await expect(
      runConversationalAgent({
        agent,
        input: "q",
        stream: false,
        sendChunk: () => {
          /* noop */
        },
      }),
    ).rejects.toBeInstanceOf(GatewayAgentUnavailableError);
  });

  test("BUG-005: passes prior turns + current input as a messages array when priorTurns is non-empty", async () => {
    const generateMock = mock(async () => ({ text: "answer" }));
    const agent = { generate: generateMock } as unknown as Agent;
    await runConversationalAgent({
      agent,
      input: "asafgolombek@gmail.com",
      stream: false,
      sendChunk: () => undefined,
      priorTurns: [
        { role: "user", text: "draft a gmail to my own address summarising my week" },
        { role: "assistant", text: "Sure — what email should I send this to?" },
      ],
    });
    const calls = generateMock.mock.calls as unknown as unknown[][];
    expect(calls.length).toBeGreaterThan(0);
    const arg: unknown = calls[0]?.[0];
    expect(Array.isArray(arg)).toBe(true);
    const messages = arg as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(3);
    expect(messages[0]).toEqual({
      role: "user",
      content: "draft a gmail to my own address summarising my week",
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Sure — what email should I send this to?",
    });
    expect(messages[2]).toEqual({ role: "user", content: "asafgolombek@gmail.com" });
  });

  test("BUG-005: when priorTurns is empty (or omitted), still passes the raw string prompt (no behavior change)", async () => {
    const generateMock = mock(async () => ({ text: "answer" }));
    const agent = { generate: generateMock } as unknown as Agent;
    await runConversationalAgent({
      agent,
      input: "hello",
      stream: false,
      sendChunk: () => undefined,
      priorTurns: [],
    });
    const calls = generateMock.mock.calls as unknown as unknown[][];
    const arg: unknown = calls[0]?.[0];
    expect(typeof arg).toBe("string");
    expect(arg as string).toBe("hello");
  });

  test("sanitizes other errors before surfacing to callers", async () => {
    const agent = {
      generate: mock(async () => {
        throw new Error("upstream said token: abcdefghijklmnop");
      }),
    } as unknown as Agent;
    try {
      await runConversationalAgent({
        agent,
        input: "q",
        stream: false,
        sendChunk: () => {
          /* noop */
        },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("[REDACTED]");
      expect((e as Error).message).not.toContain("abcdefghijklmnop");
    }
  });
});
