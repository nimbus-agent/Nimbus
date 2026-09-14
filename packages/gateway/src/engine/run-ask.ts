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
import { getAgentRequestSessionId, getExplainToolCalls } from "./agent-request-context.ts";
import { classifyCandidateOutcome } from "./ask-explain-outcome.ts";
import type { AskExplainRecorder } from "./ask-explain-recorder.ts";
import type {
  AskExplainRecord,
  BaseExplainRecord,
  CandidateOutcome,
  ContributingPass,
  LocalCandidate,
} from "./ask-explain-types.ts";
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
import { indexCountFor, indexCountLine } from "./index-count-question.ts";
import { type PlanResult, planFromIntent } from "./planner.ts";
import { fallbackSearchTerms, questionSearchTerms } from "./question-search-terms.ts";
import { type ClassifiedIntent, type ClassifierEgressPolicy, classifyIntent } from "./router.ts";
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
  /**
   * `nimbus explain last` (spec §4). Absent means "no recorder wired" — a test double or a
   * gate-only caller that has no use for it — in which case `runAsk` records nothing rather than
   * fabricating a recorder. Recording happens exactly once per call, success or throw (spec
   * §4.2): a caller that only recorded on success would leave `explain last` showing the
   * PREVIOUS successful ask at the moment the user most needs the truth.
   */
  explainRecorder?: AskExplainRecorder;
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

async function classifyIntentForAsk(
  input: string,
  policy: ClassifierEgressPolicy,
): Promise<ClassifiedIntent> {
  try {
    return await classifyIntent(input, policy);
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
 * What a route contributes to the explain record beyond the shared `BaseExplainRecord` fields
 * (spec §4.2). One MUTABLE field on {@link ExplainPartial}, filled in as the turn progresses —
 * never a per-arm closure, the same rule I35's gate learned: state a single exit point must
 * write belongs in ONE place, or it is two places for it to go missing.
 */
type ExplainRoute =
  | { readonly kind: "empty_index" }
  | {
      readonly kind: "local_context";
      readonly searchTerms: string;
      readonly fallbackTermFired?: string;
      readonly truncation: ContextTruncation;
      readonly pool: readonly LocalCandidate[];
      readonly discardedTail: ReadonlyArray<{ service: string; type: string; count: number }>;
    }
  | {
      readonly kind: "agent_tools";
      /**
       * Set only on the local-router fallback path (spec §4.2 follow-up): `promptWithContext` is
       * built ONCE, above the router-vs-agent fork, so a local pool built for this turn was
       * genuinely handed to the agent on fallback, not silently dropped. Absent means none was
       * built, never that it was lost.
       */
      readonly localContextAlsoGiven?: {
        readonly searchTerms: string;
        readonly fallbackTermFired?: string;
        readonly pool: readonly LocalCandidate[];
        readonly discardedTail: ReadonlyArray<{ service: string; type: string; count: number }>;
      };
    }
  | { readonly kind: "plan_dispatch"; readonly plan: string };

/**
 * The single mutable record `runAsk` threads through `runAskInner` and every helper it calls,
 * filled in as the turn progresses so `runAsk`'s `finally`-shaped wrapper can build an
 * {@link AskExplainRecord} on EITHER exit path — success or throw (spec §4.2) — from whatever got
 * captured before the throw. `stage` is read only on the failure path; the successful route
 * variants carry no stage at all.
 */
type ExplainPartial = {
  stage: "classification" | "retrieval" | "model";
  classifier?: BaseExplainRecord["classifier"];
  modelRoute?: BaseExplainRecord["modelRoute"];
  fallbackFromLocalRouter?: { readonly error: string };
  route?: ExplainRoute;
};

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
  partial: ExplainPartial,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const sessionId = getAgentRequestSessionId();
  const priorTurns = await loadRecentConversationHistory(p.sessionMemoryStore, sessionId);
  partial.stage = "retrieval";
  const localContext = shouldBuildLocalContext(p)
    ? await buildLocalIndexedContext(p.localIndex, p.input)
    : undefined;

  // Same guard as `countIndexedItems`: `localIndex.getDatabase` is optional on the interface, and
  // a test stub without it must not take the whole turn down over a disclosure line.
  const countDb =
    typeof p.localIndex.getDatabase === "function" ? p.localIndex.getDatabase() : undefined;
  const count = countDb === undefined ? undefined : indexCountFor(countDb, p.input);
  const countLine = count === undefined ? undefined : indexCountLine(count);

  partial.stage = "model";
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
    ...(countLine === undefined ? {} : { indexCountLine: countLine }),
    ...(p.devil === true ? { devil: true } : {}),
    // Resolved here rather than at gateway boot so an edit to the active profile's toml is
    // picked up with no restart (D3). No logger: the boot-time resolution in
    // `platform/assemble.ts` owns the warning — warning on every turn would be noise.
    persona: resolvePersona(p.paths.configDir),
  });

  if (result.fallbackFromLocalRouter !== undefined) {
    partial.fallbackFromLocalRouter = result.fallbackFromLocalRouter;
  }
  if (result.modelMeta !== undefined) {
    partial.modelRoute = {
      provider: result.modelMeta.provider,
      model: result.modelMeta.modelUsed,
      isLocal: result.modelMeta.isLocal,
    };
  }
  // `toolless` means the LOCAL ROUTER answered this turn with no fallback — the same signal
  // `appendDeterministicDisclosures` uses to decide the negation-tools-unavailable line. Only
  // then does the route report the indexed-context retrieval trace Task 4 built AS THE PRIMARY
  // route payload; a fallback to the Mastra agent (or an agent turn that never had local context
  // to begin with) is reported as `agent_tools`, with `fallbackFromLocalRouter` carrying the
  // local-router failure alongside it (spec §4.2) — the two are not mutually exclusive.
  //
  // A fallback turn does NOT lose the local pool, though: `promptWithContext` is built ONCE,
  // above the router-vs-agent fork in `run-conversational-agent.ts`, and `runTurn` hands that
  // SAME `promptArg` to the agent on fallback — so a pool built for this turn genuinely reached
  // the model's prompt even when the route is `agent_tools`. `localContextAlsoGiven` carries it
  // there, additively, only when one was actually built (`shouldBuildLocalContext` is false on
  // the pure agent route, so a non-fallback `agent_tools` turn never sets this).
  partial.route =
    result.toolless && localContext !== undefined
      ? {
          kind: "local_context",
          searchTerms: localContext.explain.searchTerms,
          ...(localContext.explain.fallbackTermFired === undefined
            ? {}
            : { fallbackTermFired: localContext.explain.fallbackTermFired }),
          truncation: localContext.truncation,
          pool: localContext.explain.pool,
          discardedTail: localContext.explain.discardedTail,
        }
      : {
          kind: "agent_tools",
          ...(localContext === undefined
            ? {}
            : {
                localContextAlsoGiven: {
                  searchTerms: localContext.explain.searchTerms,
                  ...(localContext.explain.fallbackTermFired === undefined
                    ? {}
                    : { fallbackTermFired: localContext.explain.fallbackTermFired }),
                  pool: localContext.explain.pool,
                  discardedTail: localContext.explain.discardedTail,
                },
              }),
        };

  await persistConversationTurn(p.sessionMemoryStore, sessionId, p.input, result.reply);

  return {
    reply: result.reply,
    ...(result.modelMeta === undefined ? {} : { modelMeta: result.modelMeta }),
  };
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

/**
 * `classified` plus what the explain recorder needs to know about the classifier call itself
 * (spec §4.3): `classifierDestination` names where the classifying prompt actually went, and is
 * set ONLY from inside a successful `router.generate` round-trip — never guessed — so its
 * absence means "no destination was ever resolved" (no router, an injected `p.classify` double,
 * or a caught fallback below), not "resolved to nothing". `classifierSkipReason` is set only on
 * the graceful local-fallback arm, where the classifier never produced an answer to report.
 */
type ClassifyForAskResult = {
  readonly classified: ClassifiedIntent;
  readonly classifierDestination?: string;
  readonly classifierSkipReason?: string;
};

async function classifyIntentForAskWithLocalFallback(
  p: RunAskParams,
): Promise<ClassifyForAskResult> {
  // Resolved from the router, which owns `[llm]` AND is now the classifier's only way out of the
  // machine: `generate` is what carries the per-vendor `[llm.remote.*]` opt-in and appends the
  // I29 `model` row. Absent a router there is no configuration to read and no ledger to append
  // to, so `generate` is undefined and the classifier refuses — fail-closed, where it used to
  // fall back to its own env-keyed HTTP client. Every production path builds a router
  // (`platform/assemble.ts`).
  const router = p.llmRouter;
  // Captured by wrapping the closure `classifyIntent` already receives (spec §4.3), rather than
  // widening `classifyIntent`'s own exported return type, which has its own tests and is not
  // this function's to change.
  let classifierDestination: string | undefined;
  const policy: ClassifierEgressPolicy = {
    enforceAirGap: router?.enforcesAirGap() ?? false,
    generate:
      router === undefined
        ? undefined
        : async (opts) => {
            const res = await router.generate(opts);
            classifierDestination = res.provider;
            return res;
          },
  };
  try {
    const classified = await (p.classify ?? ((input) => classifyIntentForAsk(input, policy)))(
      p.input,
    );
    return {
      classified,
      ...(classifierDestination === undefined ? {} : { classifierDestination }),
    };
  } catch (e) {
    if (
      p.llmRouter === undefined ||
      !p.llmRouter.prefersLocal() ||
      !(e instanceof GatewayAgentUnavailableError)
    ) {
      throw e;
    }
    // `air_gap` joins the two key-shaped reasons: all three mean "no remote classification is
    // going to happen", and the caller's recovery is identical — answer from the local index.
    // Without it, turning air-gap ON would turn a working local ask into a hard error.
    if (e.reason !== "no_api_key" && e.reason !== "invalid_api_key" && e.reason !== "air_gap") {
      throw e;
    }
    runAskLog.warn(
      { reason: e.reason, provider: e.provider },
      "remote intent classifier unavailable; falling back to local indexed-context answer",
    );
    return {
      classified: {
        intent: "unknown",
        entities: {},
        requiresHITL: false,
        confidence: 0,
      },
      classifierSkipReason: `remote classifier unavailable: ${e.reason}`,
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

const DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT = 8;

/**
 * How many indexed items `ask` puts in front of the model.
 *
 * The default of 8 was sized for a small local model and is kept as-is, so no
 * existing deployment changes behaviour. It is a ceiling on the ANSWER, not on
 * the search: with a larger local model (a 14B-class one holds a 128k window)
 * the cap, not the model, is what makes `ask` say it has no data while dozens
 * of items match — the disclosure note below reports exactly that shortfall.
 * Raise it via NIMBUS_ASK_CONTEXT_ITEMS when the configured model can hold more.
 *
 * Read per call rather than cached so a caller can change it without a restart;
 * a non-positive or unparseable value falls back to the default instead of
 * throwing, since a malformed override must not make `ask` unusable.
 */
export function resolveLocalContextItemLimit(): number {
  const raw = process.env["NIMBUS_ASK_CONTEXT_ITEMS"];
  if (raw === undefined || raw === "") return DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT;
  // Number(), not parseInt(): parseInt stops at the first non-digit, so "40ms"
  // would silently become a budget of 40 and "1.5" a budget of 1.
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT;
  return n;
}
/**
 * How far the primary ranked search looks before the context is sliced to
 * {@link resolveLocalContextItemLimit}.
 *
 * The context budget defaults to 8; this exists only so the answer can SAY how much it left out.
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
    .all(like, urlLike, resolveLocalContextItemLimit()) as GithubIssueContextRow[];
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
  readonly explain: {
    readonly searchTerms: string;
    readonly fallbackTermFired?: string;
    readonly pool: LocalCandidate[];
    readonly discardedTail: Array<{ service: string; type: string; count: number }>;
  };
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
    const passById = new Map<string, ContributingPass>();
    // The scores survive ONLY here — `formatContextItem` drops them, and `byId` never gets
    // them back (spec §2.4).
    const rankedById = new Map<string, RankedIndexItem>();
    const addRankedResults = (items: RankedIndexItem[], pass: ContributingPass): void => {
      for (const item of items) {
        if (!byId.has(item.indexPrimaryKey)) {
          byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item));
          passById.set(item.indexPrimaryKey, pass);
          rankedById.set(item.indexPrimaryKey, item);
        }
      }
    };
    const addContextItems = (
      items: Array<Omit<LocalContextItem, "rank">>,
      pass: ContributingPass,
    ): void => {
      for (const item of items) {
        if (!byId.has(item.sourceId)) {
          byId.set(item.sourceId, item);
          passById.set(item.sourceId, pass);
          // Deliberately NOT added to rankedById: these rows were never scored (spec §2.4).
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
    addRankedResults(primary.slice(0, resolveLocalContextItemLimit()), { kind: "primary-hybrid" });
    for (const quotedQuery of extractQuotedSearchQueries(query)) {
      addRankedResults(
        localIndex.searchRanked({ name: quotedQuery, limit: resolveLocalContextItemLimit() }),
        { kind: "quoted", query: quotedQuery },
      );
    }
    for (const repoSlug of extractGithubRepoSlugs(query)) {
      addContextItems(githubIssueContextItemsForRepo(localIndex, repoSlug), {
        kind: "repo-slug",
        slug: repoSlug,
      });
    }
    let fallbackTermFired: string | undefined;
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
          {
            kind: "fallback-term",
            term,
          },
        );
        if (byId.size > 0) {
          fallbackTermFired = term;
          break;
        }
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
    const contextItems = capPerService([...byId.values()], resolveLocalContextItemLimit()).map(
      (item, idx) => ({ ...item, rank: idx + 1 }),
    );

    const shownIds = new Set(contextItems.map((i) => i.sourceId));
    const byIdOrder = [...byId.keys()];
    const limit = resolveLocalContextItemLimit();

    const outcomeFor = (id: string, inById: boolean): CandidateOutcome =>
      classifyCandidateOutcome({
        sourceId: id,
        inById,
        byIdPosition: inById ? byIdOrder.indexOf(id) : -1,
        shownIds,
        limit,
      });

    /** A candidate that WAS scored: read the components off the preserved RankedIndexItem. */
    const fromRanked = (
      item: RankedIndexItem,
      pass: ContributingPass,
      inById: boolean,
    ): LocalCandidate => ({
      sourceId: item.indexPrimaryKey,
      service: item.service,
      indexedType: item.indexedType,
      title: cleanContextText(item.name),
      ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }),
      ...(item.scoringFormula === undefined
        ? {}
        : {
            score: item.score,
            matchScore: item.matchScore,
            recencyComponent: item.recencyComponent,
            servicePriorityComponent: item.servicePriorityComponent,
            scoringFormula: item.scoringFormula,
          }),
      pass,
      outcome: outcomeFor(item.indexPrimaryKey, inById),
    });

    /**
     * A candidate that was NEVER scored — the raw-SQL repo-slug rows. Score fields are left
     * ABSENT, never 0: rendering an absent score as zero would claim it ranked last when in fact
     * it was never ranked (spec §2.4).
     */
    const fromContext = (
      item: Omit<LocalContextItem, "rank">,
      pass: ContributingPass,
    ): LocalCandidate => ({
      sourceId: item.sourceId,
      service: item.service,
      indexedType: item.indexedType,
      title: item.title,
      pass,
      outcome: outcomeFor(item.sourceId, true),
    });

    const pool: LocalCandidate[] = [];
    const seen = new Set<string>();
    for (const [id, ctxItem] of byId) {
      seen.add(id);
      const pass = passById.get(id) ?? { kind: "primary-hybrid" as const };
      const ranked = rankedById.get(id);
      pool.push(ranked === undefined ? fromContext(ctxItem, pass) : fromRanked(ranked, pass, true));
    }
    for (const item of primary) {
      if (seen.has(item.indexPrimaryKey)) continue;
      seen.add(item.indexPrimaryKey);
      pool.push(fromRanked(item, { kind: "primary-hybrid" }, false));
    }

    // Group the discarded tail by service + type.
    //
    // Spec §2.5 suggested reusing `buildContextWindow`. DO NOT: its cap is
    // `Math.min(200, Math.max(1, Math.floor(maxItems)))`, so passing 0 to summarise EVERYTHING
    // clamps to 1 — it would keep the first discarded row as an "item" and silently omit it from
    // the summary. It would also need an unsound cast, since LocalCandidate is not a
    // RankedIndexItem. Ten honest lines beat a reused function used off-contract.
    const tail = new Map<string, { service: string; type: string; count: number }>();
    for (const c of pool) {
      if (c.outcome === "shown") continue;
      const key = JSON.stringify([c.service, c.indexedType]);
      const hit = tail.get(key);
      if (hit === undefined) {
        tail.set(key, { service: c.service, type: c.indexedType, count: 1 });
      } else {
        hit.count += 1;
      }
    }
    const discardedTail = [...tail.values()].sort((a, b) => b.count - a.count);

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
      explain: {
        searchTerms,
        ...(fallbackTermFired === undefined ? {} : { fallbackTermFired }),
        pool,
        discardedTail,
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

/** A one-line, human-readable summary of a resolved plan for the explain record (spec §4.2). */
function describePlan(plan: PlanResult): string {
  return plan.kind === "reply"
    ? `reply: ${plan.text}`
    : `actions: ${plan.actions.map((a) => a.type).join(", ")}`;
}

const CLASSIFIER_NOT_CALLED_DEFAULT: BaseExplainRecord["classifier"] = {
  called: false,
  reason: "classification did not run before this ask concluded",
};

function describeExplainError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Assembles the {@link AskExplainRecord} `runAsk`'s wrapper records on EVERY exit path (spec
 * §4.2). `error === undefined` is success; anything else is the "failed" route, reporting
 * whatever stage `partial.stage` had most recently advanced to before the throw. Persona is
 * resolved fresh here (matching `resolvePersona`'s own per-invocation, no-cache contract) rather
 * than threaded through `partial`, so every route — including ones that never touch the
 * conversational path at all — gets one.
 */
function buildExplainRecord(
  p: RunAskParams,
  partial: ExplainPartial,
  startedAt: number,
  error: unknown,
): AskExplainRecord {
  const base = {
    askedAt: startedAt,
    durationMs: Date.now() - startedAt,
    question: p.input,
    source: p.clientId === "chatops" ? ("chatops" as const) : ("local" as const),
    persona: (() => {
      const persona = resolvePersona(p.paths.configDir);
      return `${persona.tone}/${persona.voice}`;
    })(),
    classifier: partial.classifier ?? CLASSIFIER_NOT_CALLED_DEFAULT,
    ...(partial.modelRoute === undefined ? {} : { modelRoute: partial.modelRoute }),
    ...(partial.fallbackFromLocalRouter === undefined
      ? {}
      : { fallbackFromLocalRouter: partial.fallbackFromLocalRouter }),
  };

  if (error !== undefined) {
    return { ...base, route: "failed", stage: partial.stage, error: describeExplainError(error) };
  }

  // Absent only if a future route forgets to set it before returning — default to `agent_tools`
  // with no tool calls rather than throw a second, confusing error out of the recording path
  // itself (recording must never break the user's answer, which by now has already succeeded).
  const route = partial.route ?? { kind: "agent_tools" as const };
  switch (route.kind) {
    case "empty_index":
      return { ...base, route: "empty_index" };
    case "local_context":
      return {
        ...base,
        route: "local_context",
        searchTerms: route.searchTerms,
        ...(route.fallbackTermFired === undefined
          ? {}
          : { fallbackTermFired: route.fallbackTermFired }),
        truncation: route.truncation,
        pool: route.pool,
        discardedTail: route.discardedTail,
      };
    case "agent_tools":
      // Task 5's collector, drained here: the four `runAsk` call sites (the three
      // `ipc/server/inline-handlers.ts` sites and the ChatOps one `gateway-main.ts` wraps
      // explicitly) already run inside `agentRequestContext.run(...)`, so a store exists by the
      // time this drains it. `?? []` covers a caller outside any such context (a bare unit test):
      // no store means no calls to report, not an error.
      return {
        ...base,
        route: "agent_tools",
        toolCalls: [...(getExplainToolCalls() ?? [])],
        ...(route.localContextAlsoGiven === undefined
          ? {}
          : { localContextAlsoGiven: route.localContextAlsoGiven }),
      };
    case "plan_dispatch":
      return { ...base, route: "plan_dispatch", plan: route.plan };
  }
}

async function runAskInner(
  p: RunAskParams,
  partial: ExplainPartial,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const indexed = countIndexedItems(p.localIndex);
  const empty = emptyIndexGuidanceIfNeeded(p, indexed);
  if (empty !== undefined) {
    partial.classifier = { called: false, reason: "index is empty" };
    partial.route = { kind: "empty_index" };
    return empty;
  }

  // Devil's-advocate mode answers in prose, so it routes conversationally REGARDLESS of intent.
  // Plan dispatch has no argument to make — it executes a plan — so without this the flag would
  // silently do nothing for every query the classifier reads as an action, i.e. for a subset the
  // user cannot predict. The classifier is skipped entirely rather than called and ignored: its
  // verdict cannot change the route here, and it costs an LLM round-trip.
  if (p.devil === true) {
    partial.classifier = { called: false, reason: "devil mode bypasses the classifier" };
    if (!canUseConversation(p)) {
      // Forcing the route must not fabricate a path: with no agent and no local router there is
      // nothing to converse with, and the existing no-LLM error is the honest answer.
      throw new GatewayAgentUnavailableError({ reason: "no_api_key" });
    }
    return await answerConversationally(p, partial);
  }

  const { classified, classifierDestination, classifierSkipReason } =
    await classifyIntentForAskWithLocalFallback(p);
  partial.classifier =
    classifierDestination === undefined
      ? { called: false, reason: classifierSkipReason ?? "classifier produced no destination" }
      : {
          called: true,
          intent: classified.intent,
          confidence: classified.confidence,
          entities: classified.entities,
          destination: classifierDestination,
        };

  const shouldUseConversational =
    shouldAnswerFromLocalIndexedContext(p) ||
    classified.intent === "unknown" ||
    classified.confidence < 0.6;

  if (canUseConversation(p) && shouldUseConversational) {
    return await answerConversationally(p, partial);
  }

  partial.stage = "model";
  const plan = planFromIntent(classified, p.paths);
  partial.route = { kind: "plan_dispatch", plan: describePlan(plan) };
  return await dispatchPlan(p, plan);
}

/**
 * `runAsk` records exactly one {@link AskExplainRecord} per call, on EVERY exit path — success or
 * throw (spec §4.2). A caller that only recorded on success would leave `explain last` showing
 * the PREVIOUS successful ask at the moment the user most needs the truth, so the whole body runs
 * inside `runAskInner`, which mutates one `ExplainPartial` as the turn progresses, and this
 * wrapper builds the record from whatever got captured — complete on success, partial on throw —
 * without changing what the caller receives or throws either way. `p.explainRecorder` is
 * optional: absent, nothing is recorded and this wrapper costs one object allocation.
 */
export async function runAsk(
  p: RunAskParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const startedAt = Date.now();
  const partial: ExplainPartial = { stage: "classification" };
  try {
    const out = await runAskInner(p, partial);
    p.explainRecorder?.record(buildExplainRecord(p, partial, startedAt, undefined));
    return out;
  } catch (e) {
    p.explainRecorder?.record(buildExplainRecord(p, partial, startedAt, e));
    throw e;
  }
}

/** Test seam: `buildLocalIndexedContext` is module-private and has no other entry point. */
export const buildLocalIndexedContextForTest = buildLocalIndexedContext;
