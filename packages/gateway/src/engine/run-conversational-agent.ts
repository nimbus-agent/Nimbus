import type { Agent } from "@mastra/core/agent";
import pino from "pino";
import type { NimbusPersonaToml } from "../config/persona.ts";
import { Config } from "../config.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { LlmGenerateResult } from "../llm/types.ts";
import { type ContextTruncation, contextTruncationLine } from "./context-truncation-disclosure.ts";
import { applyDevilAdvocate } from "./devil-advocate.ts";
import { agentErrorFromCaughtError } from "./gateway-agent-error.ts";
import { drainNegationDisclosures } from "./negation-disclosure.ts";
import {
  isNegationShapedQuestion,
  NEGATION_TOOLS_UNAVAILABLE_LINE,
} from "./negation-shaped-question.ts";
import { applyPersona } from "./persona.ts";
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
  /**
   * What `buildLocalIndexedContext` had to leave out (F14). Present only when the index held
   * more matches than the context budget allowed, and appended to the reply by the same
   * deterministic path that carries negation disclosures — never asked of the model.
   */
  localContextTruncation?: ContextTruncation;
  /**
   * The exact index count for a "how many X" question (F23), appended after the model has run.
   * A count is a `SELECT COUNT(*)`; asking a model to estimate it produced "3", then "2.2".
   */
  indexCountLine?: string;
  /**
   * Devil's-advocate mode (`nimbus ask --devil`). Injected into the prompt both execution
   * paths share — see `devil-advocate.ts` for why it is not in either system-prompt surface.
   */
  devil?: boolean;
  /**
   * Agent persona (A2). Resolved per-invocation by `runAsk` from the PROFILE-resolved toml —
   * config, not a per-call flag, which is why it is not on `AgentInvokeContext` the way
   * `devil` is. Undefined and neutral both mean "no directive"; see `engine/persona.ts`.
   */
  persona?: NimbusPersonaToml;
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

// @mastra/core ≥1.40 types agent.generate/stream via MessageListInput, which only
// accepts properly-discriminated model messages (a `tool` role can no longer carry
// plain string content). Prior turns are only ever persisted as user/assistant
// (see persistConversationTurn), so we narrow to those two roles here.
type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

type PromptArg = string | ConversationMessage[];

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
    ...priorTurns.map(
      (t): ConversationMessage =>
        t.role === "assistant"
          ? { role: "assistant", content: t.text }
          : { role: "user", content: t.text },
    ),
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

/**
 * The router-vs-agent fork, MOVED verbatim out of `runConversationalAgent` so the disclosure
 * append below has exactly one return to wrap. If this function's body differs from what the
 * caller used to contain by anything other than its signature, the change is wrong: a feature
 * that appends a sentence must not alter which turns survive.
 */
/**
 * `toolless` reports that the answer came from `runViaLocalRouter`, which passes no tools —
 * `LlmGenerateOptions` has no `tools` field at all. It is NOT the same as "took the local
 * branch": the catch below falls back to the Mastra agent, which DOES have the negation tools,
 * so a turn that started local and fell back must not carry a disclosure saying they were
 * unavailable (F21).
 */
async function runTurn(
  p: RunConversationalAgentParams,
  promptArg: PromptArg,
  maxSteps: number,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult; toolless: boolean }> {
  const llmRouter = p.llmRouter;
  if (llmRouter !== undefined && shouldUseLocalRouter(p)) {
    try {
      return { ...(await runViaLocalRouter(llmRouter, promptArg, p)), toolless: true };
    } catch (e) {
      if (p.agent === undefined) {
        throw e;
      }
      // `enforce_air_gap` is a REFUSAL, not a preference (see `LlmRouter.enforcesAirGap`).
      // Falling back to the Mastra agent here would send the prompt to a cloud vendor --
      // outside the route table, so outside the I29 wrapper too, meaning not even a ledger
      // row would record it. Surface the local failure instead.
      if (llmRouter.enforcesAirGap()) {
        throw e;
      }
      conversationalLog.warn({ err: e }, "local LLM router failed; falling back to agent");
    }
  }
  if (p.agent === undefined) {
    throw new Error("No conversational agent or local LLM router configured");
  }
  return { ...(await runViaAgent(p.agent, promptArg, p, maxSteps)), toolless: false };
}

/**
 * Drain the turn's negation disclosures and append them to BOTH the streamed output and the
 * returned reply, so the desktop app cannot show less than the CLI. Identity when nothing was
 * recorded — the default turn's reply must not move.
 *
 * The stream has already been sent by the time this runs, so the disclosure necessarily arrives
 * last. That is deliberate: it qualifies an answer the user has already begun reading.
 */
/**
 * Append every disclosure this turn OWES the reader, as one deterministic block.
 *
 * Two sources, one path on purpose. The negation lines were already constructed here rather
 * than requested of the model, and F14 needs exactly the same guarantee for context truncation:
 * a note that the model was asked to add is a note it can drop, and the answer it would have
 * dropped it from is a confident, well-formed, incomplete list that no reader can distinguish
 * from a correct one. Streaming clients get the block as a final chunk, since the reply text
 * they render came from chunks and never from the returned string.
 */
function appendDeterministicDisclosures<T extends { reply: string; toolless: boolean }>(
  res: T,
  p: RunConversationalAgentParams,
): T {
  const lines = drainNegationDisclosures();
  // F21: the tool-less path records nothing, so an EMPTY `lines` there is ambiguous — the
  // appender cannot tell "nothing to disclose" from "the disclosing component never ran". The
  // three negation tools live on the Mastra agent only, and `runViaLocalRouter` passes none, so
  // a negation-shaped question answered that way came from unconstrained generation. Left
  // silent, `nimbus ask` replied "No one." to a question `nimbus query` REFUSES outright.
  if (res.toolless && isNegationShapedQuestion(p.input)) {
    lines.push(NEGATION_TOOLS_UNAVAILABLE_LINE);
  }
  const truncation =
    p.localContextTruncation === undefined
      ? undefined
      : contextTruncationLine(p.localContextTruncation);
  if (truncation !== undefined) lines.push(truncation);
  // F23: the authoritative count, when the question asked for one. Appended rather than left to
  // the model, which answered "how many PRs are in the index?" with 3, then 2.2, against a true
  // 173 — it was describing the handful of retrieved items, not the index.
  if (p.indexCountLine !== undefined) lines.push(p.indexCountLine);
  if (lines.length === 0) {
    return res;
  }
  const text = `\n\n${lines.join("\n")}`;
  if (p.stream) {
    p.sendChunk(text);
  }
  return { ...res, reply: `${res.reply}${text}` };
}

export async function runConversationalAgent(
  p: RunConversationalAgentParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const maxSteps = Config.conversationalAgentMaxSteps;
  const trimmed = p.input.trim();
  if (trimmed === "") {
    return { reply: "" };
  }

  // Injected HERE, above the router-vs-agent fork below, so both paths carry it. Neither
  // `runViaLocalRouter`'s `systemPrompt` nor the Mastra agents' baked `instructions` mention
  // these modes — see `devil-advocate.ts` and `persona.ts`.
  //
  // ORDER IS DELIBERATE (design § 5.4): persona outermost, devil innermost. The devil
  // directive is the one that must not be diluted, and proximity to the question is the
  // cheapest emphasis available. Both are identity functions when inactive, so a default
  // gateway's prompt is unchanged.
  const promptWithContext = applyPersona(
    applyDevilAdvocate(buildPromptText(trimmed, p.localContext), p.devil),
    p.persona,
  );
  const promptArg = buildPromptArg(promptWithContext, p.priorTurns ?? []);

  try {
    // `toolless` is internal bookkeeping for the disclosure decision, not part of this
    // function's contract — dropped here so it cannot ride out through `runAsk` into an IPC
    // response where a client might come to depend on it.
    const { toolless: _toolless, ...out } = appendDeterministicDisclosures(
      await runTurn(p, promptArg, maxSteps),
      p,
    );
    return out;
  } catch (e) {
    // A step that recorded a disclosure and then threw must not leave it sitting in the
    // (possibly shared, e.g. workflow.run's one-store-per-workflow) request store for the
    // NEXT turn to drain and misattribute to its own reply. Discard rather than append: the
    // turn that recorded it never produced an answer to qualify.
    drainNegationDisclosures();
    const typed = agentErrorFromCaughtError(e);
    if (typed !== null) {
      throw typed;
    }
    conversationalLog.warn({ err: e }, "conversational agent turn failed");
    throw new Error(sanitizeExternalError(e));
  }
}
