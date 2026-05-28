import type { Agent } from "@mastra/core/agent";
import pino from "pino";

import { Config } from "../config.ts";
import { agentErrorFromCaughtError } from "./gateway-agent-error.ts";
import { sanitizeExternalError } from "./sanitize-external-error.ts";

const conversationalLog = pino({
  name: "conversational-agent",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type RunConversationalAgentParams = {
  agent: Agent;
  input: string;
  stream: boolean;
  sendChunk: (text: string) => void;
  priorTurns?: ReadonlyArray<{ role: "user" | "assistant" | "tool"; text: string }>;
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

export async function runConversationalAgent(
  p: RunConversationalAgentParams,
): Promise<{ reply: string }> {
  const maxSteps = Config.conversationalAgentMaxSteps;
  const trimmed = p.input.trim();
  if (trimmed === "") {
    return { reply: "" };
  }

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

  const priorTurns = p.priorTurns ?? [];
  const promptArg: string | Array<{ role: "user" | "assistant" | "tool"; content: string }> =
    priorTurns.length > 0
      ? [
          ...priorTurns.map((t) => ({ role: t.role, content: t.text })),
          { role: "user" as const, content: prompt },
        ]
      : prompt;

  try {
    if (!p.stream) {
      const out = await p.agent.generate(promptArg as never, { maxSteps });
      return { reply: out.text };
    }

    const streamOut = await p.agent.stream(promptArg as never, { maxSteps });
    for await (const chunk of streamOut.fullStream) {
      if (isTextDeltaChunk(chunk) && chunk.payload.text.length > 0) {
        p.sendChunk(chunk.payload.text);
      }
    }
    const reply = await streamOut.text;
    return { reply };
  } catch (e) {
    const typed = agentErrorFromCaughtError(e);
    if (typed !== null) {
      throw typed;
    }
    conversationalLog.warn({ err: e }, "conversational agent turn failed");
    throw new Error(sanitizeExternalError(e));
  }
}
