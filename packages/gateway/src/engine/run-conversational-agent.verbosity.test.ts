import { describe, expect, mock, test } from "bun:test";
import type { LlmRouter } from "../llm/router.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";

function routerMock() {
  const generate = mock(async (_opts: { prompt: string }) => ({
    text: "local answer",
    modelUsed: "m",
    isLocal: true,
    provider: "ollama" as const,
  }));
  return { generate, router: { generate, prefersLocal: () => true } as unknown as LlmRouter };
}

async function promptFor(verbosity: string | undefined): Promise<string> {
  const { generate, router } = routerMock();
  await runConversationalAgent({
    llmRouter: router,
    input: "what shipped?",
    stream: false,
    sendChunk: () => undefined,
    ...(verbosity === undefined ? {} : { verbosity }),
  });
  const call = generate.mock.calls[0];
  if (call === undefined) throw new Error("router not called");
  return call[0].prompt;
}

describe("[personalization] verbosity reaches the turn prompt", () => {
  test("a verbosity sentence leads the prompt", async () => {
    const prompt = await promptFor("Keep it short.");
    expect(prompt.startsWith("Keep it short.\n\n")).toBe(true);
    expect(prompt).toContain("what shipped?");
  });

  test("empty or absent verbosity leaves the prompt byte-identical", async () => {
    expect(await promptFor("")).toBe(await promptFor(undefined));
  });
});
