import type { Database } from "bun:sqlite";
import type { Agent } from "@mastra/core/agent";

import type { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import { bindConsentChannel, ToolExecutor } from "./executor.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { type PlanResult, planFromIntent } from "./planner.ts";
import { type ClassifiedIntent, classifyIntent } from "./router.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";
import type { ConnectorDispatcher, PlannedAction } from "./types.ts";

export type RunAskParams = {
  input: string;
  stream: boolean;
  clientId: string;
  paths: PlatformPaths;
  consentCoordinator: ConsentCoordinator;
  localIndex: LocalIndex;
  dispatcher: ConnectorDispatcher;
  sendChunk: (text: string) => void;
  conversationalAgent?: Agent;
  sessionMemoryStore?: SessionMemoryStore;
  classify?: (input: string) => Promise<ClassifiedIntent>;
};

const EMPTY_INDEX_GUIDANCE = `No data indexed yet.

To get started, connect a service and run an initial sync:
  nimbus connector auth github
  nimbus connector auth google
  nimbus connector auth slack
  nimbus connector list
  nimbus connector sync <service>

Then try your question again, or run nimbus doctor for a health summary.`;

const INDEX_ITEM_COUNT_CACHE = new WeakMap<Database, { at: number; value: number }>();
const INDEX_ITEM_COUNT_TTL_MS = 8000;

function countIndexedItems(localIndex: LocalIndex): number | undefined {
  if (typeof localIndex.getDatabase !== "function") {
    return undefined;
  }
  try {
    const db = localIndex.getDatabase();
    const now = Date.now();
    const hit = INDEX_ITEM_COUNT_CACHE.get(db);
    if (hit !== undefined && now - hit.at < INDEX_ITEM_COUNT_TTL_MS) {
      return hit.value;
    }
    const row = db.query(`SELECT COUNT(*) AS c FROM item`).get() as { c: number } | null;
    const c = row?.c;
    const value = typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
    INDEX_ITEM_COUNT_CACHE.set(db, { at: now, value });
    return value;
  } catch {
    return undefined;
  }
}

function formatResultSummary(results: unknown[]): string {
  if (results.length === 0) {
    return "Done.";
  }
  const parts: string[] = [];
  for (const r of results) {
    try {
      parts.push(typeof r === "string" ? r : JSON.stringify(r, undefined, 2));
    } catch {
      parts.push(String(r));
    }
  }
  return parts.join("\n---\n");
}

function emptyIndexGuidanceIfNeeded(
  p: RunAskParams,
  indexed: number | undefined,
): { reply: string } | undefined {
  if (p.input.trim() === "" || indexed !== 0) {
    return undefined;
  }
  if (p.stream) {
    p.sendChunk(`${EMPTY_INDEX_GUIDANCE}\n`);
  }
  return { reply: EMPTY_INDEX_GUIDANCE };
}

async function classifyIntentForAsk(input: string): Promise<ClassifiedIntent> {
  try {
    return await classifyIntent(input);
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw e;
    }
    throw new GatewayAgentUnavailableError({ reason: "unknown" });
  }
}

async function runActionsPlan(
  p: RunAskParams,
  actions: PlannedAction[],
): Promise<{ reply: string }> {
  const consent = bindConsentChannel(p.consentCoordinator, p.clientId);
  const executor = new ToolExecutor(consent, p.localIndex, p.dispatcher);
  const summaries: string[] = [];
  const structured: unknown[] = [];

  for (const action of actions) {
    if (p.stream) {
      p.sendChunk(`Running: ${action.type}…\n`);
    }
    const out = await executor.execute(action);
    if (out.status === "rejected") {
      summaries.push(`Rejected: ${out.reason}`);
      structured.push(out);
      break;
    }
    structured.push(out.result);
    summaries.push(`OK: ${action.type}`);
  }

  const summaryText = formatResultSummary(structured);
  const reply = `${summaries.join("\n")}\n\n${summaryText}`;
  if (p.stream) {
    p.sendChunk(`\n${summaryText}\n`);
  }
  return { reply };
}

function handleReplyPlan(p: RunAskParams, text: string): { reply: string } {
  if (p.stream) {
    p.sendChunk(text);
  }
  return { reply: text };
}

async function dispatchPlan(p: RunAskParams, plan: PlanResult): Promise<{ reply: string }> {
  if (plan.kind === "reply") {
    return handleReplyPlan(p, plan.text);
  }
  return await runActionsPlan(p, plan.actions);
}

async function loadRecentConversationHistory(
  store: SessionMemoryStore | undefined,
  sessionId: string | undefined,
): Promise<Array<{ role: "user" | "assistant" | "tool"; text: string }>> {
  if (store === undefined || sessionId === undefined || sessionId === "") {
    return [];
  }
  try {
    const recent = await store.getRecentTurns(sessionId, 12);
    return recent.map((t) => ({ role: t.role, text: t.text }));
  } catch {
    return [];
  }
}

async function persistConversationTurn(
  store: SessionMemoryStore | undefined,
  sessionId: string | undefined,
  userInput: string,
  assistantReply: string,
): Promise<void> {
  if (store === undefined || sessionId === undefined || sessionId === "") {
    return;
  }
  const now = Date.now();
  try {
    await store.append({
      sessionId,
      role: "user",
      text: userInput,
      createdAt: now,
    });
    await store.append({
      sessionId,
      role: "assistant",
      text: assistantReply,
      createdAt: now + 1,
    });
  } catch {
    // best-effort persistence
  }
}

export async function runAsk(p: RunAskParams): Promise<{ reply: string }> {
  const indexed = countIndexedItems(p.localIndex);
  const empty = emptyIndexGuidanceIfNeeded(p, indexed);
  if (empty !== undefined) {
    return empty;
  }

  const classified = await (p.classify ?? classifyIntentForAsk)(p.input);

  const conversationalAgent = p.conversationalAgent;
  const shouldUseConversational = classified.intent === "unknown" || classified.confidence < 0.6;

  if (conversationalAgent !== undefined && shouldUseConversational) {
    const sessionId = getAgentRequestSessionId();
    const priorTurns = await loadRecentConversationHistory(p.sessionMemoryStore, sessionId);

    const result = await runConversationalAgent({
      agent: conversationalAgent,
      input: p.input,
      stream: p.stream,
      sendChunk: p.sendChunk,
      priorTurns,
    });

    await persistConversationTurn(p.sessionMemoryStore, sessionId, p.input, result.reply);

    return result;
  }

  const plan = planFromIntent(classified, p.paths);
  return await dispatchPlan(p, plan);
}
