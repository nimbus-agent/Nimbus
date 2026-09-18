/**
 * Renderer + wire-shape narrowing for `nimbus explain last`. Pure — it takes a validated record
 * and returns a string, so the output can be tested without a socket.
 *
 * The wire shape is re-declared here rather than imported: `packages/cli` reaches the gateway over
 * IPC only and never imports gateway source (a repo dependency rule). The gateway-side type is
 * `AskExplainRecord` in `gateway/src/engine/ask-explain-types.ts`; the seam between the two
 * independently-declared shapes is covered by `explain-format-wire.test.ts`, which round-trips one
 * record per route through `parseExplainLastResult` → `formatExplain`, plus
 * `packages/gateway/test/e2e/explain-last.e2e.test.ts`, which asserts the key set of a record a
 * real gateway produced against this file's parser.
 *
 * This renderer IS the product: every honesty rule below exists because the upstream collector
 * (`run-ask.ts`) went to real trouble to distinguish "never scored" from "scored zero", "given to
 * the model" from "read by the model", and "no pool was built" from "a pool was built and lost".
 * A renderer that flattens any of those distinctions back into one undifferentiated shape defeats
 * the whole feature, so every rule has its own test — see `explain-format.test.ts`.
 */

// ---------------------------------------------------------------------------
// Locally declared wire types (mirrors gateway's `ask-explain-types.ts`)
// ---------------------------------------------------------------------------

/** Why a candidate did or did not reach the model. */
export type CandidateOutcome =
  | "shown"
  | "cut: probe slice"
  | "cut: over cap"
  | "cut: service fairness";

export type ContributingPass =
  | { readonly kind: "primary-hybrid" }
  | { readonly kind: "quoted"; readonly query: string }
  | { readonly kind: "repo-slug"; readonly slug: string }
  | { readonly kind: "fallback-term"; readonly term: string };

export type LocalCandidate = {
  readonly sourceId: string;
  readonly service: string;
  readonly indexedType: string;
  readonly title: string;
  /** Absent for repo-slug rows: that projection does not select modified_at. */
  readonly modifiedAt?: number;
  /** Absent for repo-slug rows: no score was ever computed for them. */
  readonly score?: number;
  readonly matchScore?: number;
  readonly recencyComponent?: number;
  readonly servicePriorityComponent?: number;
  readonly scoringFormula?: "hybrid_rrf" | "fts_rank";
  readonly pass: ContributingPass;
  readonly outcome: CandidateOutcome;
};

export type SourceSummaryEntry = {
  readonly service: string;
  readonly type: string;
  readonly count: number;
};

export type CollectedToolCall = {
  readonly toolId: string;
  readonly service: string;
  readonly status: "ok" | "error";
  readonly durationMs: number;
  readonly paramsJson: string | null;
  /** Present only for `searchLocalIndex` calls, which rank internally. */
  readonly ranking?: {
    readonly totalMatches: number;
    readonly itemsInWindow: number;
    readonly sourceSummary: readonly SourceSummaryEntry[];
  };
};

export type ModelRoute = {
  readonly provider: string;
  readonly model: string;
  readonly isLocal: boolean;
};

export type ClassifierVerdict =
  | { readonly called: false; readonly reason: string }
  | {
      readonly called: true;
      readonly intent: string;
      readonly confidence: number;
      readonly entities: Readonly<Record<string, string>>;
      readonly destination: string;
    };

export type FallbackInfo = { readonly error: string };

export type Truncation = {
  readonly shown: number;
  readonly total: number;
  readonly atLeast: boolean;
};

/**
 * What the primary search actually did. OPTIONAL on the wire: a gateway that predates it sends no
 * such field, and the report then falls back to the candidates' scoring formula.
 */
export type PrimaryRetrieval = {
  readonly vectorRanked: boolean;
  readonly notes: readonly string[];
};

export type LocalContextPayload = {
  readonly searchTerms: string;
  readonly primaryRetrieval?: PrimaryRetrieval;
  readonly fallbackTermFired?: string;
  readonly truncation: Truncation;
  readonly pool: readonly LocalCandidate[];
  readonly discardedTail: readonly { service: string; type: string; count: number }[];
};

export type ExplainRecordBase = {
  readonly askedAt: number;
  readonly durationMs: number;
  readonly question: string;
  readonly source: "chatops" | "local";
  readonly persona: string;
  /** Absent means "no model route was resolved" — never fabricated. */
  readonly modelRoute?: ModelRoute;
  readonly classifier: ClassifierVerdict;
  /** Present when the local router threw and the turn silently re-ran on the agent. */
  readonly fallbackFromLocalRouter?: FallbackInfo;
};

export type ExplainRecordView = ExplainRecordBase &
  (
    | { readonly route: "empty_index" }
    | ({ readonly route: "local_context" } & LocalContextPayload)
    | {
        readonly route: "agent_tools";
        readonly toolCalls: readonly CollectedToolCall[];
        /**
         * Present only when a local indexed-context probe was ALSO built for this turn (the
         * local-router fallback path). Absent means none was built, never that one was lost.
         */
        readonly localContextAlsoGiven?: LocalContextPayload;
      }
    | { readonly route: "plan_dispatch"; readonly plan: string }
    | {
        readonly route: "failed";
        readonly stage: "classification" | "retrieval" | "model" | "dispatch";
        readonly error: string;
        /** Present only for a "dispatch"-stage failure — the plan that was being dispatched. */
        readonly plan?: string;
      }
  );

export type ExplainLastResult =
  | { readonly record: null; readonly reason: "no_ask_since_start" }
  | { readonly record: ExplainRecordView };

// ---------------------------------------------------------------------------
// Runtime narrowing from `unknown` — the IPC response is external data.
// ---------------------------------------------------------------------------

function isRecordObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(where: string): never {
  throw new Error(`ask.explainLast: malformed response at ${where}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") bad(where);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== "number") bad(where);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") bad(where);
  return v;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) bad(where);
  return v;
}

function parsePass(v: unknown, where: string): ContributingPass {
  if (!isRecordObj(v)) bad(where);
  const kind = v["kind"];
  if (kind === "primary-hybrid") return { kind };
  if (kind === "quoted") return { kind, query: str(v["query"], `${where}.query`) };
  if (kind === "repo-slug") return { kind, slug: str(v["slug"], `${where}.slug`) };
  if (kind === "fallback-term") return { kind, term: str(v["term"], `${where}.term`) };
  bad(`${where}.kind`);
}

function parseScoringFormula(v: unknown, where: string): "hybrid_rrf" | "fts_rank" {
  const s = str(v, where);
  if (s !== "hybrid_rrf" && s !== "fts_rank") bad(where);
  return s;
}

const CANDIDATE_OUTCOMES: ReadonlySet<string> = new Set([
  "shown",
  "cut: probe slice",
  "cut: over cap",
  "cut: service fairness",
]);

function parseOutcome(v: unknown, where: string): CandidateOutcome {
  const s = str(v, where);
  if (!CANDIDATE_OUTCOMES.has(s)) bad(where);
  return s as CandidateOutcome;
}

function parseCandidate(v: unknown, where: string): LocalCandidate {
  if (!isRecordObj(v)) bad(where);
  const modifiedAtRaw = v["modifiedAt"];
  const scoringFormulaRaw = v["scoringFormula"];
  return {
    sourceId: str(v["sourceId"], `${where}.sourceId`),
    service: str(v["service"], `${where}.service`),
    indexedType: str(v["indexedType"], `${where}.indexedType`),
    title: str(v["title"], `${where}.title`),
    ...(modifiedAtRaw === undefined
      ? {}
      : { modifiedAt: num(modifiedAtRaw, `${where}.modifiedAt`) }),
    // Bundled together, mirroring the gateway's own construction (`run-ask.ts`): a candidate
    // either has a full score breakdown or none of it, never a partial one.
    ...(scoringFormulaRaw === undefined
      ? {}
      : {
          score: num(v["score"], `${where}.score`),
          matchScore: num(v["matchScore"], `${where}.matchScore`),
          recencyComponent: num(v["recencyComponent"], `${where}.recencyComponent`),
          servicePriorityComponent: num(
            v["servicePriorityComponent"],
            `${where}.servicePriorityComponent`,
          ),
          scoringFormula: parseScoringFormula(scoringFormulaRaw, `${where}.scoringFormula`),
        }),
    pass: parsePass(v["pass"], `${where}.pass`),
    outcome: parseOutcome(v["outcome"], `${where}.outcome`),
  };
}

function parseDiscardedEntry(
  v: unknown,
  where: string,
): { service: string; type: string; count: number } {
  if (!isRecordObj(v)) bad(where);
  return {
    service: str(v["service"], `${where}.service`),
    type: str(v["type"], `${where}.type`),
    count: num(v["count"], `${where}.count`),
  };
}

function parseSourceSummaryEntry(v: unknown, where: string): SourceSummaryEntry {
  if (!isRecordObj(v)) bad(where);
  return {
    service: str(v["service"], `${where}.service`),
    type: str(v["type"], `${where}.type`),
    count: num(v["count"], `${where}.count`),
  };
}

function parseTruncation(v: unknown, where: string): Truncation {
  if (!isRecordObj(v)) bad(where);
  return {
    shown: num(v["shown"], `${where}.shown`),
    total: num(v["total"], `${where}.total`),
    atLeast: bool(v["atLeast"], `${where}.atLeast`),
  };
}

function parsePrimaryRetrieval(v: unknown, where: string): PrimaryRetrieval {
  if (!isRecordObj(v)) bad(where);
  return {
    vectorRanked: bool(v["vectorRanked"], `${where}.vectorRanked`),
    notes: arr(v["notes"], `${where}.notes`).map((n, i) => str(n, `${where}.notes[${i}]`)),
  };
}

function parseLocalContextPayload(v: unknown, where: string): LocalContextPayload {
  if (!isRecordObj(v)) bad(where);
  const fallbackTermFiredRaw = v["fallbackTermFired"];
  const primaryRetrievalRaw = v["primaryRetrieval"];
  return {
    searchTerms: str(v["searchTerms"], `${where}.searchTerms`),
    ...(primaryRetrievalRaw === undefined
      ? {}
      : {
          primaryRetrieval: parsePrimaryRetrieval(primaryRetrievalRaw, `${where}.primaryRetrieval`),
        }),
    ...(fallbackTermFiredRaw === undefined
      ? {}
      : { fallbackTermFired: str(fallbackTermFiredRaw, `${where}.fallbackTermFired`) }),
    truncation: parseTruncation(v["truncation"], `${where}.truncation`),
    pool: arr(v["pool"], `${where}.pool`).map((c, i) => parseCandidate(c, `${where}.pool[${i}]`)),
    discardedTail: arr(v["discardedTail"], `${where}.discardedTail`).map((d, i) =>
      parseDiscardedEntry(d, `${where}.discardedTail[${i}]`),
    ),
  };
}

function parseToolCall(v: unknown, where: string): CollectedToolCall {
  if (!isRecordObj(v)) bad(where);
  const status = str(v["status"], `${where}.status`);
  if (status !== "ok" && status !== "error") bad(`${where}.status`);
  const paramsJsonRaw = v["paramsJson"];
  const paramsJson = paramsJsonRaw === null ? null : str(paramsJsonRaw, `${where}.paramsJson`);
  const rankingRaw = v["ranking"];
  return {
    toolId: str(v["toolId"], `${where}.toolId`),
    service: str(v["service"], `${where}.service`),
    status,
    durationMs: num(v["durationMs"], `${where}.durationMs`),
    paramsJson,
    ...(rankingRaw === undefined ? {} : { ranking: parseRanking(rankingRaw, `${where}.ranking`) }),
  };
}

function parseRanking(v: unknown, where: string): NonNullable<CollectedToolCall["ranking"]> {
  if (!isRecordObj(v)) bad(where);
  return {
    totalMatches: num(v["totalMatches"], `${where}.totalMatches`),
    itemsInWindow: num(v["itemsInWindow"], `${where}.itemsInWindow`),
    sourceSummary: arr(v["sourceSummary"], `${where}.sourceSummary`).map((s, i) =>
      parseSourceSummaryEntry(s, `${where}.sourceSummary[${i}]`),
    ),
  };
}

function parseModelRouteValue(v: unknown, where: string): ModelRoute {
  if (!isRecordObj(v)) bad(where);
  return {
    provider: str(v["provider"], `${where}.provider`),
    model: str(v["model"], `${where}.model`),
    isLocal: bool(v["isLocal"], `${where}.isLocal`),
  };
}

function parseClassifier(v: unknown, where: string): ClassifierVerdict {
  if (!isRecordObj(v)) bad(where);
  const called = v["called"];
  if (called === false) {
    return { called, reason: str(v["reason"], `${where}.reason`) };
  }
  if (called === true) {
    const entitiesRaw = v["entities"];
    if (!isRecordObj(entitiesRaw)) bad(`${where}.entities`);
    const entities: Record<string, string> = {};
    for (const [k, val] of Object.entries(entitiesRaw)) {
      entities[k] = str(val, `${where}.entities.${k}`);
    }
    return {
      called,
      intent: str(v["intent"], `${where}.intent`),
      confidence: num(v["confidence"], `${where}.confidence`),
      entities,
      destination: str(v["destination"], `${where}.destination`),
    };
  }
  bad(`${where}.called`);
}

function parseFallbackValue(v: unknown, where: string): FallbackInfo {
  if (!isRecordObj(v)) bad(where);
  return { error: str(v["error"], `${where}.error`) };
}

function parseStage(
  v: unknown,
  where: string,
): "classification" | "retrieval" | "model" | "dispatch" {
  const s = str(v, where);
  if (s !== "classification" && s !== "retrieval" && s !== "model" && s !== "dispatch") bad(where);
  return s;
}

function parseBase(v: Record<string, unknown>): ExplainRecordBase {
  const source = str(v["source"], "source");
  if (source !== "chatops" && source !== "local") bad("source");
  const modelRouteRaw = v["modelRoute"];
  const fallbackRaw = v["fallbackFromLocalRouter"];
  return {
    askedAt: num(v["askedAt"], "askedAt"),
    durationMs: num(v["durationMs"], "durationMs"),
    question: str(v["question"], "question"),
    source,
    persona: str(v["persona"], "persona"),
    classifier: parseClassifier(v["classifier"], "classifier"),
    ...(modelRouteRaw === undefined
      ? {}
      : { modelRoute: parseModelRouteValue(modelRouteRaw, "modelRoute") }),
    ...(fallbackRaw === undefined
      ? {}
      : { fallbackFromLocalRouter: parseFallbackValue(fallbackRaw, "fallbackFromLocalRouter") }),
  };
}

/** Narrows the `record` half of `ask.explainLast`'s wire result. Throws on a malformed shape. */
export function parseExplainRecordView(v: unknown): ExplainRecordView {
  if (!isRecordObj(v)) bad("record");
  const base = parseBase(v);
  const route = v["route"];
  if (route === "empty_index") {
    return { ...base, route };
  }
  if (route === "local_context") {
    return { ...base, route, ...parseLocalContextPayload(v, "record") };
  }
  if (route === "agent_tools") {
    const toolCallsRaw = arr(v["toolCalls"], "toolCalls");
    const localContextRaw = v["localContextAlsoGiven"];
    return {
      ...base,
      route,
      toolCalls: toolCallsRaw.map((t, i) => parseToolCall(t, `toolCalls[${i}]`)),
      ...(localContextRaw === undefined
        ? {}
        : {
            localContextAlsoGiven: parseLocalContextPayload(
              localContextRaw,
              "localContextAlsoGiven",
            ),
          }),
    };
  }
  if (route === "plan_dispatch") {
    return { ...base, route, plan: str(v["plan"], "plan") };
  }
  if (route === "failed") {
    const planRaw = v["plan"];
    return {
      ...base,
      route,
      stage: parseStage(v["stage"], "stage"),
      error: str(v["error"], "error"),
      ...(planRaw === undefined ? {} : { plan: str(planRaw, "plan") }),
    };
  }
  bad("route");
}

/** Narrows the whole `ask.explainLast` wire result from `unknown`. Throws on a malformed shape. */
export function parseExplainLastResult(v: unknown): ExplainLastResult {
  if (!isRecordObj(v)) bad("<root>");
  if (v["record"] === null) {
    const reason = v["reason"];
    if (reason !== "no_ask_since_start") bad("reason");
    return { record: null, reason };
  }
  return { record: parseExplainRecordView(v["record"]) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type FormatExplainOptions = { readonly noColor?: boolean };

const ESC = String.fromCodePoint(27);
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

function fmtTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function renderModelRoute(m: ModelRoute | undefined): string {
  if (m === undefined) return "no model route was resolved";
  return `${m.provider} / ${m.model} (${m.isLocal ? "local" : "remote"})`;
}

function renderClassifier(c: ClassifierVerdict): string {
  if (!c.called) return `not called — ${c.reason}`;
  const entities = Object.entries(c.entities);
  const entitiesPart =
    entities.length === 0
      ? ""
      : ` entities={${entities.map(([k, val]) => `${k}=${val}`).join(", ")}}`;
  return `intent=${c.intent} confidence=${c.confidence.toFixed(2)} destination=${c.destination}${entitiesPart}`;
}

function renderCommonFields(r: ExplainRecordView): string[] {
  const lines: string[] = [
    `Asked:       ${fmtTimestamp(r.askedAt)}`,
    `Question:    ${r.question}`,
    `Duration:    ${r.durationMs}ms`,
    `Source:      ${r.source}`,
    `Persona:     ${r.persona}`,
    `Model route: ${renderModelRoute(r.modelRoute)}`,
    `Classifier:  ${renderClassifier(r.classifier)}`,
  ];
  if (r.fallbackFromLocalRouter !== undefined) {
    lines.push(
      "",
      "Fallback: the local model failed and this turn re-ran on the agent. " +
        `Error: ${r.fallbackFromLocalRouter.error}`,
    );
  }
  lines.push("", `Route: ${r.route}`, "");
  return lines;
}

function passKey(pass: ContributingPass): string {
  switch (pass.kind) {
    case "primary-hybrid":
      return "primary-hybrid";
    case "quoted":
      return `quoted:${pass.query}`;
    case "repo-slug":
      return `repo-slug:${pass.slug}`;
    case "fallback-term":
      return `fallback-term:${pass.term}`;
  }
}

/**
 * `LocalIndex.searchRankedAsync` falls back to plain FTS whenever semantic search is off,
 * `sqlite-vec` is unavailable, or the schema predates it — so the primary pass is NOT always
 * hybrid, and printing "primary hybrid search" unconditionally would claim semantic retrieval ran
 * when it did not. The label is derived from the GROUP's own `scoringFormula` (never from the
 * pass kind alone) so it reflects what actually happened on this turn: `undefined` — no candidate
 * in the group carried a formula at all — falls back to a neutral label rather than guessing.
 */
function passLabel(
  pass: ContributingPass,
  formula: LocalCandidate["scoringFormula"],
  retrieval: PrimaryRetrieval | undefined,
): string {
  switch (pass.kind) {
    case "primary-hybrid":
      // The search's own disclosure wins over the formula: a query whose embedding timed out or was
      // still loading is keyword-only, yet every row it returned still carries `hybrid_rrf`.
      if (retrieval?.vectorRanked === false) {
        return "primary search (keyword-only — semantic ranking did not run)";
      }
      if (formula === "hybrid_rrf") return "primary search (hybrid RRF)";
      if (formula === "fts_rank") return "primary search (FTS rank)";
      return "primary index search";
    case "quoted":
      return `quoted-phrase match "${pass.query}"`;
    case "repo-slug":
      return `repo-slug lookup ${pass.slug}`;
    case "fallback-term":
      return `fallback term search "${pass.term}"`;
  }
}

/** Score DESC within a group; score-less candidates sink to the end, original order preserved. */
function sortGroup(items: readonly LocalCandidate[]): LocalCandidate[] {
  return [...items].sort((a, b) => {
    if (a.score === undefined && b.score === undefined) return 0;
    if (a.score === undefined) return 1;
    if (b.score === undefined) return -1;
    return b.score - a.score;
  });
}

type PoolGroup = {
  readonly pass: ContributingPass;
  readonly formula: LocalCandidate["scoringFormula"];
  readonly items: readonly LocalCandidate[];
};

/**
 * Groups by contributing pass — never a single ranked list across passes, which is precisely the
 * cross-formula comparison the honesty rules forbid. Groups appear in first-seen order; within a
 * group, candidates are sorted by score, never across groups.
 */
function groupPool(pool: readonly LocalCandidate[]): PoolGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, LocalCandidate[]>();
  const passByKey = new Map<string, ContributingPass>();
  for (const c of pool) {
    const key = passKey(c.pass);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
      passByKey.set(key, c.pass);
      order.push(key);
    }
    bucket.push(c);
  }
  return order.map((key) => {
    const items = byKey.get(key) ?? [];
    const pass = passByKey.get(key) ?? { kind: "primary-hybrid" as const };
    const formula = items.find((c) => c.scoringFormula !== undefined)?.scoringFormula;
    return { pass, formula, items: sortGroup(items) };
  });
}

function distinctFormulas(pool: readonly LocalCandidate[]): Set<string> {
  const s = new Set<string>();
  for (const c of pool) {
    if (c.scoringFormula !== undefined) s.add(c.scoringFormula);
  }
  return s;
}

function fmtComponent(n: number | undefined): string {
  return n === undefined ? "n/a" : n.toFixed(2);
}

function renderCandidateLine(c: LocalCandidate): string {
  const outcome = outcomeLabel(c.outcome);
  // Absent for repo-slug rows (that projection does not select modified_at) — omitted rather than
  // printing a fabricated timestamp. Useful beside `recencyComponent`: it is the raw input that
  // component was computed from.
  const modifiedPart = c.modifiedAt === undefined ? "" : ` modified=${fmtTimestamp(c.modifiedAt)}`;
  const head = `  - [${outcome}] ${c.title} (${c.service} ${c.indexedType})${modifiedPart}`;
  if (c.score === undefined) return head;
  const components =
    `match=${fmtComponent(c.matchScore)} recency=${fmtComponent(c.recencyComponent)} ` +
    `priority=${fmtComponent(c.servicePriorityComponent)}`;
  return `${head} score=${c.score.toFixed(2)} (${components})`;
}

function outcomeLabel(o: CandidateOutcome): string {
  switch (o) {
    case "shown":
      return "shown";
    case "cut: probe slice":
      return "cut — outside the primary probe's top slice";
    case "cut: over cap":
      return "cut — over the final cap";
    case "cut: service fairness":
      return "cut — displaced by per-service fairness";
  }
}

/**
 * Shared renderer for a `local_context`-shaped payload — used both for the top-level
 * `local_context` route and for `agent_tools`'s optional `localContextAlsoGiven`. When `heading`
 * is given it is printed first, making this pool's status (assembled before a fallback, not the
 * primary retrieval for this turn) explicit rather than implied by position alone.
 */
function renderLocalContextPayload(p: LocalContextPayload, heading: string | undefined): string[] {
  const lines: string[] = [];
  if (heading !== undefined) {
    lines.push(heading, "");
  }
  lines.push(`Search terms: ${p.searchTerms}`);
  if (p.fallbackTermFired !== undefined) {
    lines.push(`Fallback term fired: ${p.fallbackTermFired}`);
  }
  // `atLeast` means the primary probe hit its own ceiling, so `total` is a floor, not an exact
  // count — printing an exact total there would overclaim exactly the class of defect this
  // feature exists to expose.
  const totalLabel = p.truncation.atLeast
    ? `at least ${p.truncation.total}`
    : `${p.truncation.total}`;
  lines.push(`Given to the model: ${p.truncation.shown} of ${totalLabel} matching items`);
  for (const note of p.primaryRetrieval?.notes ?? []) {
    lines.push(`Retrieval note: ${note}`);
  }
  lines.push("");

  const groups = groupPool(p.pool);
  if (distinctFormulas(p.pool).size > 1) {
    lines.push(
      "These groups use different scoring formulas and are not comparable to each other — " +
        "do not read this as one ranked list.",
      "",
    );
  }

  if (groups.length === 0) {
    lines.push("(no candidates in this pool)", "");
  }
  for (const g of groups) {
    // Absent for a score-less pass (repo-slug direct lookups): those rows were never ranked, so
    // "n/a (direct query)" is printed rather than a fabricated 0.00, which would claim the item
    // ranked last when it was never ranked at all.
    const formulaLabel = g.formula ?? "n/a (direct query)";
    lines.push(
      `Pass: ${passLabel(g.pass, g.formula, p.primaryRetrieval)} — scoring: ${formulaLabel}`,
    );
    for (const c of g.items) {
      lines.push(renderCandidateLine(c));
    }
    lines.push("");
  }

  if (p.discardedTail.length === 0) {
    lines.push("Discarded beyond the shown set: none.");
  } else {
    lines.push("Discarded beyond the shown set (not individually listed):");
    for (const d of p.discardedTail) {
      lines.push(`  - ${d.count} ${d.service} ${d.type}`);
    }
  }
  lines.push("");
  return lines;
}

function renderToolCallLine(t: CollectedToolCall): string {
  const head = `  - ${t.toolId} (${t.service}) [${t.status}] ${t.durationMs}ms`;
  if (t.ranking === undefined) return head;
  const sources =
    t.ranking.sourceSummary.length === 0
      ? "no sources"
      : t.ranking.sourceSummary.map((s) => `${s.count} ${s.service}/${s.type}`).join(", ");
  return `${head} — ranked internally: ${t.ranking.itemsInWindow} of ${t.ranking.totalMatches} in window (${sources})`;
}

function renderAgentToolsSection(
  r: Extract<ExplainRecordView, { route: "agent_tools" }>,
): string[] {
  const lines: string[] = [
    "The model chose which tools to call. Ranking happened per tool call — each " +
      "`searchLocalIndex` call ranked internally — but nothing ranked across the whole turn.",
    "",
  ];
  if (r.toolCalls.length === 0) {
    lines.push("(no tool calls were made)", "");
  } else {
    for (const t of r.toolCalls) {
      lines.push(renderToolCallLine(t));
    }
    lines.push("");
  }
  if (r.localContextAlsoGiven !== undefined) {
    lines.push(
      ...renderLocalContextPayload(
        r.localContextAlsoGiven,
        "Local context assembled before the fallback (this pool was in the agent's prompt on this turn)",
      ),
    );
  }
  return lines;
}

/** Renders a validated `ask.explainLast` record as human-readable text. */
export function formatExplain(record: ExplainRecordView, opts?: FormatExplainOptions): string {
  const noColor = opts?.noColor ?? false;
  const title = noColor ? "nimbus explain last" : `${BOLD}nimbus explain last${RESET}`;
  const lines: string[] = [title, "", ...renderCommonFields(record)];

  switch (record.route) {
    case "empty_index":
      lines.push(
        "The index was empty when this ask ran, so no local candidates were retrieved.",
        "",
      );
      break;
    case "local_context":
      lines.push(...renderLocalContextPayload(record, undefined));
      break;
    case "agent_tools":
      lines.push(...renderAgentToolsSection(record));
      break;
    case "plan_dispatch":
      lines.push(`Plan: ${record.plan}`, "");
      break;
    case "failed":
      lines.push(`Stage: ${record.stage}`, `Error: ${record.error}`);
      // Present only for a "dispatch"-stage failure — the plan a connector/executor error was
      // being dispatched against, without which a reader has no idea what the turn was doing.
      if (record.plan !== undefined) {
        lines.push(`Plan:  ${record.plan}`);
      }
      lines.push("");
      break;
  }

  return `${lines.join("\n")}\n`;
}
