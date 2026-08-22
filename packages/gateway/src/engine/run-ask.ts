import type { Database } from "bun:sqlite";
import type { Agent } from "@mastra/core/agent";
import pino from "pino";
import { resolvePersona } from "../config/persona.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { RankedIndexItem } from "../index/ranked-item.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { LlmGenerateResult } from "../llm/types.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import { capPerService, stripInternalRankField } from "./context-fairness.ts";
import type { ContextTruncation } from "./context-truncation-disclosure.ts";
import {
  bindConsentChannel,
  type ExecutorDelegationDep,
  type ExecutorPolicyDep,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { type PlanResult, planFromIntent } from "./planner.ts";
import { fallbackSearchTerms, questionSearchTerms } from "./question-search-terms.ts";
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
  /**
   * Devil's-advocate mode (`nimbus ask --devil`). Forces the conversational route — the mode
   * argues in prose, and plan dispatch has nothing to argue with — and threads the directive
   * through to `runConversationalAgent`. See `engine/devil-advocate.ts`.
   */
  devil?: boolean;
  sessionMemoryStore?: SessionMemoryStore;
  classify?: (input: string) => Promise<ClassifiedIntent>;
  // Owner-side delegated HITL (Slice 2, I20). When present, the executor gate routes a HITL action's
  // approval to an active in-scope delegate over federation before falling back to the local prompt.
  delegation?: ExecutorDelegationDep;
  // I22 — the tighten-only HITL overlay from a signature-verified org policy. Absent means
  // "frozen set only". This is the path agent-PLANNED actions take, so it is the one an org's
  // `[policy.hitl] require` list most needs to reach.
  policyHitl?: ExecutorPolicyDep;
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

/**
 * The conversational answer path: prior turns + optional indexed context → the agent/router,
 * then persist the turn.
 *
 * Extracted so the two routes that reach it — the classifier's verdict and `--devil`, which
 * bypasses the classifier — cannot drift apart. A second inline copy for devil mode would be
 * one session-memory or local-context fix away from applying to only one of them.
 */
async function answerConversationally(
  p: RunAskParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
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
    ...(localContext === undefined
      ? {}
      : { localContext: localContext.text, localContextTruncation: localContext.truncation }),
    ...(p.devil === true ? { devil: true } : {}),
    // Resolved here rather than at gateway boot so an edit to the active profile's toml is
    // picked up with no restart (D3). No logger: the boot-time resolution in
    // `platform/assemble.ts` owns the warning — warning on every turn would be noise.
    persona: resolvePersona(p.paths.configDir),
  });

  await persistConversationTurn(p.sessionMemoryStore, sessionId, p.input, result.reply);

  return result;
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
    p.policyHitl ?? NO_POLICY_OVERLAY,
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
/**
 * How far the primary ranked search looks before the context is sliced to
 * {@link LOCAL_CONTEXT_ITEM_LIMIT}.
 *
 * The context budget stays 8; this exists only so the answer can SAY how much it left out.
 * Before it, the search itself asked for 8, so nothing downstream could tell "8 matches" from
 * "800 matches, of which you are seeing 8" — and `ask` served the second as the first.
 *
 * A ceiling rather than a full count because the ranked search fuses FTS with vector hits and
 * has no cheap `COUNT(*)`. When the probe comes back full the total is reported as a FLOOR
 * ("at least 100"), never as an exact number the query cannot support.
 */
const LOCAL_CONTEXT_TOTAL_PROBE_LIMIT = 100;
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
  // Issues AND PRs (F12a). This filtered to `type = 'issue'`, so asking about a repo silently
  // excluded every pull request — and on the audited index `github`/`issue` held ZERO rows, so
  // the path contributed nothing at all while 16 PRs sat unreachable.
  const like = `${repoSlug}#%`;
  const urlLike = `%github.com/${repoSlug}/%`;
  const rows = localIndex
    .getDatabase()
    .query(
      `SELECT id, service, type, title, body_preview, url
       FROM item
       WHERE service = 'github'
         AND type IN ('issue', 'pr')
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

interface LocalIndexedContext {
  readonly text: string;
  readonly truncation: ContextTruncation;
}

async function buildLocalIndexedContext(
  localIndex: LocalIndex,
  input: string,
): Promise<LocalIndexedContext | undefined> {
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
    // The SENTENCE is not a search term (F1). `ftsTitleMatchQuery` AND-joins every whitespace
    // token and keeps punctuation, so "what does egressRowToItem do?" contains `"do?"` — a
    // prefix term nothing matches — and the whole conjunction is unsatisfiable even though the
    // symbol is indexed and trivially findable on its own.
    const searchTerms = questionSearchTerms(query);
    if (searchTerms === undefined) {
      return undefined;
    }
    // Probe wide, serve narrow. `primary.length` is the only honest source for "how many
    // match" — every other search below is itself capped, so counting `byId` would just
    // re-measure the truncation instead of the substrate.
    const primary = await localIndex.searchRankedAsync(
      { name: searchTerms, limit: LOCAL_CONTEXT_TOTAL_PROBE_LIMIT },
      { semantic: true, contextChunks: 2 },
    );
    addRankedResults(primary.slice(0, LOCAL_CONTEXT_ITEM_LIMIT));
    for (const quotedQuery of extractQuotedSearchQueries(query)) {
      addRankedResults(
        localIndex.searchRanked({ name: quotedQuery, limit: LOCAL_CONTEXT_ITEM_LIMIT }),
      );
    }
    for (const repoSlug of extractGithubRepoSlugs(query)) {
      addContextItems(githubIssueContextItemsForRepo(localIndex, repoSlug));
    }
    if (byId.size === 0) {
      // The AND join is strict enough that three reasonable words routinely describe a document
      // containing only two — "what should I do for the smoke test issue?" misses an item titled
      // "add a smoke test" on `issue`, which is its TYPE and appears in neither its title nor
      // its body. Retry with the single most distinctive term: the same question with the
      // strictest part relaxed, not a different one.
      for (const term of fallbackSearchTerms(searchTerms)) {
        // The PROBE limit, not the context limit: `capPerService` below can only balance the pool
        // it is handed, and fetching eight rows from a service holding 11,979 of them returns
        // eight rows from that service. Widening here is what gives the cap something to choose
        // between; the slice back to eight still happens after it.
        addRankedResults(
          localIndex.searchRanked({ name: term, limit: LOCAL_CONTEXT_TOTAL_PROBE_LIMIT }),
        );
        if (byId.size > 0) break;
      }
    }
    // The no-name fallback is GONE (F1, fix 2). `searchRanked` with no `name` sets
    // `useFts = false` and returns arbitrary recent items, which were then handed to the model
    // under an authoritative "Indexed Nimbus context:" header inside a `<tool_output>` envelope.
    //
    // That is how `ask` answered a question about the user's Fargate log groups with a list of
    // `microsoft/winget-pkgs` CI runs: the term matched nothing, the fallback fetched whatever
    // was recent, `github_actions` is the highest-volume service, and the model answered the
    // question it was asked using the only data it was given — even tagging each row
    // "(GitHub Actions)". It reported its source honestly; the retrieval layer had asserted a
    // relevance it did not have. No prompt change fixes that, and no context is better than
    // confident, specific, false claims about someone's production infrastructure.
    if (byId.size === 0) {
      return undefined;
    }
    // Round-robin across services before slicing (F12b): `github_actions` held 11,979 items to
    // `github`'s 214 on the audited index, so the eight highest-ranked were all CI runs and a
    // question about a repo never saw a PR.
    const contextItems = capPerService([...byId.values()], LOCAL_CONTEXT_ITEM_LIMIT).map(
      (item, idx) => ({ ...item, rank: idx + 1 }),
    );
    return {
      // `rank` is stripped before serialising (F12c). It is internal relevance ordering, the
      // envelope carries no schema to say so, and models reported it as data — "PR #414691 is
      // ranked 1st" for GitHub, and for CloudWatch an invented "priority within the RequiemNexus
      // infrastructure". Deleting the field works for every model; a prompt rule would not.
      text: `Indexed Nimbus context:\n${wrapToolOutput(
        { service: "nimbus", tool: "localIndex.searchRanked" },
        stripInternalRankField(contextItems),
      )}`,
      truncation: {
        shown: contextItems.length,
        // `byId` can hold more than the probe found — the quoted-query and repo-slug passes
        // add items the primary search missed — so the total is the larger of the two. It is
        // still a floor, never an upper bound on what the index holds.
        total: Math.max(primary.length, byId.size),
        atLeast: primary.length >= LOCAL_CONTEXT_TOTAL_PROBE_LIMIT,
      },
    };
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

  // Devil's-advocate mode answers in prose, so it routes conversationally REGARDLESS of intent.
  // Plan dispatch has no argument to make — it executes a plan — so without this the flag would
  // silently do nothing for every query the classifier reads as an action, i.e. for a subset the
  // user cannot predict. The classifier is skipped entirely rather than called and ignored: its
  // verdict cannot change the route here, and it costs an LLM round-trip.
  if (p.devil === true) {
    if (!canUseConversation(p)) {
      // Forcing the route must not fabricate a path: with no agent and no local router there is
      // nothing to converse with, and the existing no-LLM error is the honest answer.
      throw new GatewayAgentUnavailableError({ reason: "no_api_key" });
    }
    return await answerConversationally(p);
  }

  const classified = await classifyIntentForAskWithLocalFallback(p);

  const shouldUseConversational =
    shouldAnswerFromLocalIndexedContext(p) ||
    classified.intent === "unknown" ||
    classified.confidence < 0.6;

  if (canUseConversation(p) && shouldUseConversational) {
    return await answerConversationally(p);
  }

  const plan = planFromIntent(classified, p.paths);
  return await dispatchPlan(p, plan);
}
