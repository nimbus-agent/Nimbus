import type { Database } from "bun:sqlite";
import type { Agent } from "@mastra/core/agent";
import pino from "pino";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { RankedIndexItem } from "../index/ranked-item.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { LlmGenerateResult } from "../llm/types.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import { bindConsentChannel, type ExecutorDelegationDep, ToolExecutor } from "./executor.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { type PlanResult, planFromIntent } from "./planner.ts";
import { type ClassifiedIntent, classifyIntent } from "./router.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";
import { wrapToolOutput } from "./tool-output-envelope.ts";
import type { ConnectorDispatcher, PlannedAction } from "./types.ts";

const runAskLog = pino({
  name: "run-ask",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type RunAskParams = {
  input: string;
  stream: boolean;
  clientId: string;
  paths: PlatformPaths;
  consentCoordinator: ConsentCoordinator;
  localIndex: LocalIndex;
  dispatcher: ConnectorDispatcher;
  /**
   * I29 egress ledger: appends one row before every connector dispatch. This is the agent-action
   * path (`nimbus ask` / `agent.invoke` / the ChatOps read path) — the most dispatch-capable path
   * in the product, and the one `nimbus prove` itself exercises. The sink is therefore REQUIRED —
   * production wires a real one (`makeEgressSink(db)`, see `index.ts`); a caller that genuinely
   * wants no ledger (e.g. a test exercising a gate-only path) must pass `NULL_EGRESS_SINK`
   * explicitly so that choice is visible at the call site instead of silently defaulted.
   */
  egressSink: EgressSink;
  sendChunk: (text: string) => void;
  conversationalAgent?: Agent;
  llmRouter?: LlmRouter;
  sessionMemoryStore?: SessionMemoryStore;
  classify?: (input: string) => Promise<ClassifiedIntent>;
  // Owner-side delegated HITL (Slice 2, I20). When present, the executor gate routes a HITL action's
  // approval to an active in-scope delegate over federation before falling back to the local prompt.
  delegation?: ExecutorDelegationDep;
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

function canUseConversation(p: RunAskParams): boolean {
  return p.conversationalAgent !== undefined || p.llmRouter?.prefersLocal() === true;
}

function shouldBuildLocalContext(p: RunAskParams): boolean {
  if (p.llmRouter === undefined) {
    return false;
  }
  if (p.conversationalAgent === undefined) {
    return true;
  }
  return p.llmRouter.prefersLocal();
}

function shouldAnswerFromLocalIndexedContext(p: RunAskParams): boolean {
  return (
    p.llmRouter?.prefersLocal() === true &&
    /\b(local indexed|indexed nimbus|nimbus github context|indexed github context)\b/i.test(p.input)
  );
}

async function classifyIntentForAskWithLocalFallback(p: RunAskParams): Promise<ClassifiedIntent> {
  try {
    return await (p.classify ?? classifyIntentForAsk)(p.input);
  } catch (e) {
    if (
      p.llmRouter === undefined ||
      !p.llmRouter.prefersLocal() ||
      !(e instanceof GatewayAgentUnavailableError)
    ) {
      throw e;
    }
    if (e.reason !== "no_api_key" && e.reason !== "invalid_api_key") {
      throw e;
    }
    runAskLog.warn(
      { reason: e.reason, provider: e.provider },
      "remote intent classifier unavailable; falling back to local indexed-context answer",
    );
    return {
      intent: "unknown",
      entities: {},
      requiresHITL: false,
      confidence: 0,
    };
  }
}

async function runActionsPlan(
  p: RunAskParams,
  actions: PlannedAction[],
): Promise<{ reply: string }> {
  const consent = bindConsentChannel(p.consentCoordinator, p.clientId);
  // I29: every real connector dispatch routes through this executor, so it carries the egress sink
  // (append-before-dispatch). A connector tool call (read OR write) is an outbound event and is
  // ledgered; a query answered purely from the local index never reaches here, so it adds 0 rows.
  // `p.egressSink` is REQUIRED (see the doc comment on `RunAskParams.egressSink`) — this used to
  // silently fall back to `NULL_EGRESS_SINK` whenever `p.localIndex.getDatabase` wasn't a function;
  // that fallback is gone, so a caller can no longer get a no-op sink without saying so.
  const executor = new ToolExecutor(
    consent,
    p.localIndex,
    p.dispatcher,
    p.delegation,
    p.egressSink,
  );
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

const LOCAL_CONTEXT_ITEM_LIMIT = 8;
const LOCAL_CONTEXT_PREVIEW_MAX_CHARS = 900;
const LOCAL_CONTEXT_QUOTED_QUERY_LIMIT = 4;

type LocalContextItem = {
  sourceId: string;
  rank: number;
  service: string;
  indexedType: string;
  title: string;
  preview?: string;
  url?: string;
};

function cleanContextText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function clipContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractQuotedSearchQueries(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/["'`]([^"'`]{3,120})["'`]/g)) {
    const query = cleanContextText(match[1] ?? "");
    const key = query.toLowerCase();
    if (query !== "" && !seen.has(key)) {
      seen.add(key);
      out.push(query);
    }
    if (out.length >= LOCAL_CONTEXT_QUOTED_QUERY_LIMIT) {
      break;
    }
  }
  return out;
}

function extractGithubRepoSlugs(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)) {
    const slug = (match[1] ?? "").toLowerCase();
    if (slug !== "" && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

function formatContextItem(
  localIndex: LocalIndex,
  item: RankedIndexItem,
): Omit<LocalContextItem, "rank"> {
  const title = cleanContextText(item.name);
  const preview = cleanContextText(
    item.semanticSnippet ?? localIndex.getBodyPreview(item.indexPrimaryKey) ?? "",
  );
  const url = cleanContextText(item.canonicalUrl ?? item.url ?? "");
  return {
    sourceId: item.indexPrimaryKey,
    service: item.service,
    indexedType: item.indexedType,
    title,
    ...(preview === ""
      ? {}
      : { preview: clipContextText(preview, LOCAL_CONTEXT_PREVIEW_MAX_CHARS) }),
    ...(url === "" ? {} : { url }),
  };
}

type GithubIssueContextRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  url: string | null;
};

function githubIssueContextItemsForRepo(
  localIndex: LocalIndex,
  repoSlug: string,
): Array<Omit<LocalContextItem, "rank">> {
  const like = `${repoSlug}#issue-%`;
  const urlLike = `%github.com/${repoSlug}/issues/%`;
  const rows = localIndex
    .getDatabase()
    .query(
      `SELECT id, service, type, title, body_preview, url
       FROM item
       WHERE service = 'github'
         AND type = 'issue'
         AND (lower(external_id) LIKE ? OR lower(url) LIKE ?)
       ORDER BY modified_at DESC, synced_at DESC, title ASC
       LIMIT ?`,
    )
    .all(like, urlLike, LOCAL_CONTEXT_ITEM_LIMIT) as GithubIssueContextRow[];
  return rows.map((row) => {
    const preview = cleanContextText(row.body_preview ?? "");
    const url = cleanContextText(row.url ?? "");
    return {
      sourceId: row.id,
      service: row.service,
      indexedType: row.type,
      title: cleanContextText(row.title),
      ...(preview === ""
        ? {}
        : { preview: clipContextText(preview, LOCAL_CONTEXT_PREVIEW_MAX_CHARS) }),
      ...(url === "" ? {} : { url }),
    };
  });
}

async function buildLocalIndexedContext(
  localIndex: LocalIndex,
  input: string,
): Promise<string | undefined> {
  const query = input.trim();
  if (query === "") {
    return undefined;
  }
  try {
    const byId = new Map<string, Omit<LocalContextItem, "rank">>();
    const addRankedResults = (items: RankedIndexItem[]): void => {
      for (const item of items) {
        if (!byId.has(item.indexPrimaryKey)) {
          byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item));
        }
      }
    };
    const addContextItems = (items: Array<Omit<LocalContextItem, "rank">>): void => {
      for (const item of items) {
        if (!byId.has(item.sourceId)) {
          byId.set(item.sourceId, item);
        }
      }
    };
    addRankedResults(
      await localIndex.searchRankedAsync(
        { name: query, limit: LOCAL_CONTEXT_ITEM_LIMIT },
        { semantic: true, contextChunks: 2 },
      ),
    );
    for (const quotedQuery of extractQuotedSearchQueries(query)) {
      addRankedResults(
        localIndex.searchRanked({ name: quotedQuery, limit: LOCAL_CONTEXT_ITEM_LIMIT }),
      );
    }
    for (const repoSlug of extractGithubRepoSlugs(query)) {
      addContextItems(githubIssueContextItemsForRepo(localIndex, repoSlug));
    }
    if (byId.size === 0) {
      addRankedResults(localIndex.searchRanked({ name: query, limit: LOCAL_CONTEXT_ITEM_LIMIT }));
    }
    if (byId.size === 0) {
      addRankedResults(localIndex.searchRanked({ limit: LOCAL_CONTEXT_ITEM_LIMIT }));
    }
    if (byId.size === 0) {
      return undefined;
    }
    const contextItems = [...byId.values()]
      .slice(0, LOCAL_CONTEXT_ITEM_LIMIT)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));
    return `Indexed Nimbus context:\n${wrapToolOutput(
      { service: "nimbus", tool: "localIndex.searchRanked" },
      contextItems,
    )}`;
  } catch (e) {
    runAskLog.warn({ err: e }, "failed to build local indexed context for local LLM");
    return undefined;
  }
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

export async function runAsk(
  p: RunAskParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const indexed = countIndexedItems(p.localIndex);
  const empty = emptyIndexGuidanceIfNeeded(p, indexed);
  if (empty !== undefined) {
    return empty;
  }

  const classified = await classifyIntentForAskWithLocalFallback(p);

  const shouldUseConversational =
    shouldAnswerFromLocalIndexedContext(p) ||
    classified.intent === "unknown" ||
    classified.confidence < 0.6;

  if (canUseConversation(p) && shouldUseConversational) {
    const sessionId = getAgentRequestSessionId();
    const priorTurns = await loadRecentConversationHistory(p.sessionMemoryStore, sessionId);
    const localContext = shouldBuildLocalContext(p)
      ? await buildLocalIndexedContext(p.localIndex, p.input)
      : undefined;

    const result = await runConversationalAgent({
      input: p.input,
      stream: p.stream,
      sendChunk: p.sendChunk,
      priorTurns,
      ...(p.conversationalAgent === undefined ? {} : { agent: p.conversationalAgent }),
      ...(p.llmRouter === undefined ? {} : { llmRouter: p.llmRouter }),
      ...(localContext === undefined ? {} : { localContext }),
    });

    await persistConversationTurn(p.sessionMemoryStore, sessionId, p.input, result.reply);

    return result;
  }

  const plan = planFromIntent(classified, p.paths);
  return await dispatchPlan(p, plan);
}
