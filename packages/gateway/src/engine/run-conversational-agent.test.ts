import { describe, expect, mock, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import type { LlmRouter } from "../llm/router.ts";
import { DEVIL_ADVOCATE_DIRECTIVE } from "./devil-advocate.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { TONE_DIRECTIVES, VOICE_DIRECTIVES } from "./persona.ts";
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
    expect(messages).toHaveLength(3);
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
    expect(arg).toBe("hello");
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

describe("devil's-advocate mode reaches BOTH execution paths", () => {
  // There are two ways a turn is answered — the local LLM router and the Mastra agent — and a
  // directive wired into one silently no-ops on the other. Both assertions exist so a change
  // that covers only the path the author happened to be testing fails here.
  test("the Mastra agent path receives the directive", async () => {
    const generate = mock(async (_prompt: unknown) => ({ text: "ok" }));
    const agent = { generate } as unknown as Agent;
    await runConversationalAgent({
      agent,
      input: "ship the migration tonight",
      stream: false,
      devil: true,
      sendChunk: () => undefined,
    });
    const promptArg = generate.mock.calls[0]?.[0];
    expect(typeof promptArg).toBe("string");
    expect(promptArg as string).toContain(DEVIL_ADVOCATE_DIRECTIVE);
    // The user's actual question must survive alongside the directive.
    expect(promptArg as string).toContain("ship the migration tonight");
  });

  test("the local router path receives the directive", async () => {
    const generate = mock(async (_opts: { prompt: string }) => ({
      text: "local answer",
      modelUsed: "m",
      isLocal: true,
      provider: "ollama" as const,
    }));
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    await runConversationalAgent({
      llmRouter: router,
      input: "ship the migration tonight",
      stream: false,
      devil: true,
      sendChunk: () => undefined,
    });
    const opts = generate.mock.calls[0]?.[0] as { prompt: string } | undefined;
    expect(opts?.prompt).toContain(DEVIL_ADVOCATE_DIRECTIVE);
    expect(opts?.prompt).toContain("ship the migration tonight");
  });

  test("the directive is absent when the flag is off — on both paths", async () => {
    // The inverse defect: a directive that leaks into every turn makes the mode meaningless
    // and changes the default answer for every user who never asked for it.
    const agentGenerate = mock(async (_prompt: unknown) => ({ text: "ok" }));
    await runConversationalAgent({
      agent: { generate: agentGenerate } as unknown as Agent,
      input: "what changed?",
      stream: false,
      sendChunk: () => undefined,
    });
    expect(agentGenerate.mock.calls[0]?.[0] as string).not.toContain(DEVIL_ADVOCATE_DIRECTIVE);

    const routerGenerate = mock(async (_opts: { prompt: string }) => ({
      text: "x",
      modelUsed: "m",
      isLocal: true,
      provider: "ollama" as const,
    }));
    await runConversationalAgent({
      llmRouter: { generate: routerGenerate, prefersLocal: () => true } as unknown as LlmRouter,
      input: "what changed?",
      stream: false,
      sendChunk: () => undefined,
    });
    const opts = routerGenerate.mock.calls[0]?.[0] as { prompt: string } | undefined;
    expect(opts?.prompt).not.toContain(DEVIL_ADVOCATE_DIRECTIVE);
  });

  test("the directive survives alongside indexed context and prior turns", async () => {
    // `buildPromptText` already prepends local context, and `buildPromptArg` converts the
    // prompt to a message array once prior turns exist — the directive must still be in the
    // message the model actually reads, not dropped by either transform.
    const generate = mock(async (_prompt: unknown) => ({ text: "ok" }));
    await runConversationalAgent({
      agent: { generate } as unknown as Agent,
      input: "roll it out now",
      stream: false,
      devil: true,
      localContext: "Indexed Nimbus context:\n1. github/pr: risky migration",
      priorTurns: [{ role: "user", text: "earlier question" }],
      sendChunk: () => undefined,
    });
    const messages = generate.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(Array.isArray(messages)).toBe(true);
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain(DEVIL_ADVOCATE_DIRECTIVE);
    expect(last?.content).toContain("Indexed Nimbus context");
    expect(last?.content).toContain("roll it out now");
  });
});

describe("persona (A2) reaches BOTH execution paths and composes with --devil", () => {
  // The router fake MIRRORS the one the devil tests above already use, and must:
  // `llmRouter.generate` takes an OPTIONS OBJECT (`{ task, prompt, systemPrompt, ... }`),
  // not a bare prompt string, and its result is read as `result.text` and returned as
  // `modelMeta`. A fake taking a string would capture the wrong thing.
  function routerMock() {
    return mock(async (_opts: { prompt: string }) => ({
      text: "local answer",
      modelUsed: "m",
      isLocal: true,
      provider: "ollama" as const,
    }));
  }

  test("router path carries the persona directive", async () => {
    const generate = routerMock();
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    await runConversationalAgent({
      llmRouter: router,
      input: "what shipped?",
      stream: false,
      sendChunk: () => undefined,
      persona: { tone: "terse", voice: "neutral" },
    });
    const opts = generate.mock.calls[0]?.[0] as { prompt: string } | undefined;
    expect(opts?.prompt).toContain(TONE_DIRECTIVES.terse);
    expect(opts?.prompt).toContain("what shipped?");
  });

  test("agent path carries the persona directive", async () => {
    const generate = mock(async (_prompt: unknown) => ({ text: "ok" }));
    const agent = { generate } as unknown as Agent;
    await runConversationalAgent({
      agent,
      input: "what shipped?",
      stream: false,
      sendChunk: () => undefined,
      persona: { tone: "verbose", voice: "collective" },
    });
    const promptArg = generate.mock.calls[0]?.[0] as string | undefined;
    expect(promptArg).toContain(TONE_DIRECTIVES.verbose);
    expect(promptArg).toContain(VOICE_DIRECTIVES.collective);
  });

  test("neutral persona leaves the prompt byte-identical to no persona at all", async () => {
    const withNeutral = routerMock();
    const withNone = routerMock();
    await runConversationalAgent({
      llmRouter: { generate: withNeutral, prefersLocal: () => true } as unknown as LlmRouter,
      input: "what shipped?",
      stream: false,
      sendChunk: () => undefined,
      persona: { tone: "neutral", voice: "neutral" },
    });
    await runConversationalAgent({
      llmRouter: { generate: withNone, prefersLocal: () => true } as unknown as LlmRouter,
      input: "what shipped?",
      stream: false,
      sendChunk: () => undefined,
    });
    const a = (withNeutral.mock.calls[0]?.[0] as { prompt: string } | undefined)?.prompt;
    const b = (withNone.mock.calls[0]?.[0] as { prompt: string } | undefined)?.prompt;
    expect(a).toBe(b);
  });

  // Design § 5.4: persona outermost, devil directly above the question.
  test("with --devil both directives appear, persona first", async () => {
    const generate = routerMock();
    const router = { generate, prefersLocal: () => true } as unknown as LlmRouter;
    await runConversationalAgent({
      llmRouter: router,
      input: "ship the migration tonight",
      stream: false,
      sendChunk: () => undefined,
      devil: true,
      persona: { tone: "terse", voice: "neutral" },
    });
    const prompt = (generate.mock.calls[0]?.[0] as { prompt: string } | undefined)?.prompt ?? "";
    const personaAt = prompt.indexOf(TONE_DIRECTIVES.terse);
    const devilAt = prompt.indexOf(DEVIL_ADVOCATE_DIRECTIVE);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(devilAt).toBeGreaterThanOrEqual(0);
    expect(personaAt).toBeLessThan(devilAt);
  });
});
