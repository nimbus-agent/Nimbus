import type { Agent } from "@mastra/core/agent";
import pino from "pino";

import { Config } from "../config.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { LlmGenerateResult } from "../llm/types.ts";
import { agentErrorFromCaughtError } from "./gateway-agent-error.ts";
import { sanitizeExternalError } from "./sanitize-external-error.ts";

const conversationalLog = pino({
  name: "conversational-agent",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type RunConversationalAgentParams = {
  agent?: Agent;
  llmRouter?: LlmRouter;
  input: string;
  stream: boolean;
  sendChunk: (text: string) => void;
  priorTurns?: ReadonlyArray<{ role: "user" | "assistant" | "tool"; text: string }>;
  localContext?: string;
};

function isTextDeltaChunk(chunk: unknown): chunk is {
  type: "text-delta";
  payload: { text: string };
} {
  if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) {
    return false;
  }
  const rec = chunk as Record<string, unknown>;
  if (rec["type"] !== "text-delta") {
    return false;
  }
  const payload = rec["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const text = (payload as Record<string, unknown>)["text"];
  return typeof text === "string";
}

function shouldUseLocalRouter(p: RunConversationalAgentParams): boolean {
  if (p.llmRouter === undefined) {
    return false;
  }
  if (p.agent === undefined) {
    return true;
  }
  return p.llmRouter.prefersLocal();
}

type PromptArg = string | Array<{ role: "user" | "assistant" | "tool"; content: string }>;

/** Build the prompt text, optionally prefixed with a relational-traversal nudge and local context. */
function buildPromptText(trimmed: string, localContext: string | undefined): string {
  const relational =
    /\b(connected to|related to|linked to|what caused|who is involved|knowledge graph)\b/i.test(
      trimmed,
    );
  const incidentOrGraph =
    relational ||
    /\b(incident|outage|sev-?[12]|on-?call|page(d|ing)?|pagerduty|firefight|rollback|post-?mortem)\b/i.test(
      trimmed,
    );
  const prompt = incidentOrGraph
    ? `The user may be asking about relationships between indexed items (including incidents). If you have a concrete item id from searchLocalIndex, call traverseGraph before answering.\n\n${trimmed}`
    : trimmed;
  if (localContext === undefined || localContext.trim() === "") {
    return prompt;
  }
  return `${localContext.trim()}\n\nUser question:\n${prompt}`;
}

/** Fold prior turns + the current prompt into the agent/router prompt argument. */
function buildPromptArg(
  promptWithContext: string,
  priorTurns: ReadonlyArray<{ role: "user" | "assistant" | "tool"; text: string }>,
): PromptArg {
  if (priorTurns.length === 0) {
    return promptWithContext;
  }
  return [
    ...priorTurns.map((t) => ({ role: t.role, content: t.text })),
    { role: "user" as const, content: promptWithContext },
  ];
}

/** Run the turn through the local LLM router. Throws on router failure (caller decides fallback). */
async function runViaLocalRouter(
  llmRouter: LlmRouter,
  promptArg: PromptArg,
  p: RunConversationalAgentParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const routerPrompt =
    typeof promptArg === "string"
      ? promptArg
      : promptArg.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  let streamedAnyToken = false;
  const onToken =
    p.stream === true
      ? (token: string): void => {
          if (token.length > 0) {
            streamedAnyToken = true;
            p.sendChunk(token);
          }
        }
      : undefined;
  const result = await llmRouter.generate({
    task: "agent_step",
    prompt: routerPrompt,
    systemPrompt:
      "You are Nimbus, a local-first assistant. Answer from the provided indexed context when it is relevant. If the context is insufficient, say what is missing instead of inventing details.",
    maxTokens: 2048,
    temperature: 0.2,
    stream: p.stream,
    ...(onToken === undefined ? {} : { onToken }),
  });
  if (p.stream && !streamedAnyToken && result.text.length > 0) {
    p.sendChunk(result.text);
  }
  return { reply: result.text, modelMeta: result };
}

/** Run the turn through the Mastra agent (streaming or one-shot). */
async function runViaAgent(
  agent: Agent,
  promptArg: PromptArg,
  p: RunConversationalAgentParams,
  maxSteps: number,
): Promise<{ reply: string }> {
  if (!p.stream) {
    const out = await agent.generate(promptArg, { maxSteps });
    return { reply: out.text };
  }
  const streamOut = await agent.stream(promptArg, { maxSteps });
  for await (const chunk of streamOut.fullStream) {
    if (isTextDeltaChunk(chunk) && chunk.payload.text.length > 0) {
      p.sendChunk(chunk.payload.text);
    }
  }
  return { reply: await streamOut.text };
}

export async function runConversationalAgent(
  p: RunConversationalAgentParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const maxSteps = Config.conversationalAgentMaxSteps;
  const trimmed = p.input.trim();
  if (trimmed === "") {
    return { reply: "" };
  }

  const promptWithContext = buildPromptText(trimmed, p.localContext);
  const promptArg = buildPromptArg(promptWithContext, p.priorTurns ?? []);

  try {
    const llmRouter = p.llmRouter;
    if (llmRouter !== undefined && shouldUseLocalRouter(p)) {
      try {
        return await runViaLocalRouter(llmRouter, promptArg, p);
      } catch (e) {
        if (p.agent === undefined) {
          throw e;
        }
        conversationalLog.warn({ err: e }, "local LLM router failed; falling back to agent");
      }
    }

    if (p.agent === undefined) {
      throw new Error("No conversational agent or local LLM router configured");
    }

    return await runViaAgent(p.agent, promptArg, p, maxSteps);
  } catch (e) {
    const typed = agentErrorFromCaughtError(e);
    if (typed !== null) {
      throw typed;
    }
    conversationalLog.warn({ err: e }, "conversational agent turn failed");
    throw new Error(sanitizeExternalError(e));
  }
}
