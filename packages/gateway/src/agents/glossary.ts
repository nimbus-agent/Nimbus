import type { Database } from "bun:sqlite";

import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import { loadGlossaryCandidates } from "../glossary/glossary-extract.ts";
import {
  countByStatus,
  countSnippetSourced,
  findBySynonym,
  getTerm,
  listConsolidated,
  readPassState,
} from "../glossary/glossary-store.ts";
import type { GlossaryTerm } from "../glossary/glossary-types.ts";
import { findNearMisses } from "../glossary/near-miss.ts";
import { normalizeTerm } from "../glossary/term-normalize.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type {
  GlossaryBrief,
  GlossaryEntry,
  GlossaryInput,
  GlossaryMatchedVia,
} from "./_lib/glossary-types.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type GlossaryContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
};

const DEFAULT_LIMIT = 50;

/** How many consolidated terms to consider as near-miss candidates. */
const NEAR_MISS_POOL = 500;

function toEntry(t: GlossaryTerm): GlossaryEntry {
  return {
    term: t.displayTerm,
    definition: t.definition,
    definitionSource: t.definitionSource,
    docFreq: t.docFreq,
    serviceSpread: t.serviceSpread,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    topSources: t.topSources,
    synonyms: t.synonyms,
    nearMisses: t.nearMisses,
  };
}

function subAgent(fn: () => unknown): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => ({ text: JSON.stringify(fn()), tokensIn: 0, tokensOut: 0 }),
  };
}

function decode<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resolves a query in the documented order: exact key, then synonym, then
 * near-miss suggestions.
 *
 * Synonym resolution is not polish — the motivating user encounters the
 * EXPANDED phrase and wants the team's meaning. Requiring them to already know
 * the acronym would invert the feature.
 */
function resolveTerm(
  db: Database,
  raw: string,
): { term: GlossaryTerm | null; matchedVia: GlossaryMatchedVia } {
  const key = normalizeTerm(raw);
  if (key === "") return { term: null, matchedVia: null };

  const exact = getTerm(db, key);
  if (exact !== null && exact.status === "consolidated") {
    return { term: exact, matchedVia: "exact" };
  }
  const bySynonym = findBySynonym(db, key);
  if (bySynonym !== null) return { term: bySynonym, matchedVia: "synonym" };

  return { term: null, matchedVia: null };
}

function buildGaps(
  db: Database,
  counts: { total: number; pending: number; vetoed: number },
  lastPassAt: number | null,
  entryCount: number,
  truncation: { totalSources: number; truncatedSources: number },
): GapNote[] {
  const gaps: GapNote[] = [];
  const anyItems = db.query("SELECT 1 FROM item LIMIT 1").get() !== null;

  // Only claim an empty index when we are ALSO returning nothing. An index
  // reset clears `item` while consolidated glossary rows survive, and telling
  // a user the index is empty while showing them entries is self-contradictory.
  if (!anyItems && entryCount === 0) {
    gaps.push({
      category: "empty_index",
      detail: "The local index is empty, so no terminology could be extracted.",
      remediation: "Connect a source and run a sync, then try again.",
    });
    return gaps;
  }
  if (lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The glossary extraction pass has not run yet.",
      remediation: "Run `nimbus glossary --refresh`, or wait for the next connector sync.",
    });
    return gaps;
  }
  if (counts.total === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "A pass ran but no candidate met the minimum document frequency.",
      remediation: "Lower `[glossary].min_doc_freq`, or index more discussion sources.",
    });
  }
  if (counts.pending > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(counts.pending)} candidate term(s) are still awaiting consolidation.`,
      remediation: "The glossary fills in progressively — later passes will consolidate them.",
    });
  }
  // Snippet-sourced definitions are verbatim quotes, not consolidations. They
  // are labelled per-entry by the renderer, but a user whose local model is
  // simply not running has no way to notice the pattern — the glossary looks
  // built, just oddly worded. Report the ratio rather than picking a
  // "predominantly" threshold nobody can justify.
  const snippetCount = countSnippetSourced(db);
  if (snippetCount > 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(snippetCount)} of ${String(counts.total)} definition(s) are verbatim snippets ` +
        "rather than model-consolidated.",
      remediation:
        "Start a local model (Ollama or llama.cpp) and run `nimbus glossary --refresh`; " +
        "snippet definitions are re-consolidated automatically on later passes.",
    });
  }
  // Honesty note, precise rather than a blanket cap claim: a source is
  // truncated when its connector has not declared a full body yet, or
  // declared one that exceeded its type's cap. Conditional, not standing —
  // an all-complete corpus states nothing false by staying silent.
  if (truncation.truncatedSources > 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(truncation.truncatedSources)} of ${String(truncation.totalSources)} ` +
        "glossary source(s) are indexed with a truncated body, so a term mentioned only past " +
        "that cutoff is not visible to this pass.",
    });
  }
  return gaps;
}

export async function runGlossary(
  input: GlossaryInput,
  ctx: GlossaryContext,
): Promise<GlossaryBrief> {
  const start = performance.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rawTerm = input.term?.trim() ?? "";

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `glossary:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const counts = countByStatus(ctx.db);
  const passState = readPassState(ctx.db);
  // The honesty count: how many of the glossary-source items indexed so far
  // carry a truncated body. No time window here — unlike `decisions`, the
  // glossary has no `--since`, so this covers the whole corpus.
  const candidates = loadGlossaryCandidates(ctx.db, { sinceMs: 0 });
  const truncation = {
    totalSources: candidates.rows.length,
    truncatedSources: candidates.truncatedSources,
  };

  let mode: GlossaryBrief["mode"];
  let entries: GlossaryEntry[] = [];
  let matchedVia: GlossaryMatchedVia = null;
  let suggestions: string[] = [];

  if (rawTerm === "") {
    // List mode: ranked list / coverage stats. Gap notes need the entry
    // count, so they are computed after the lanes rather than inside one —
    // otherwise the empty-index note cannot know whether anything is
    // actually being returned.
    // One lane: `countByStatus` for stats/gaps is already computed in the
    // outer `counts` variable above — a second sub-task recomputing it was
    // dead code, its result never decoded. Matches term mode's earlier fix.
    const tasks: SubTask[] = [subAgent(() => listConsolidated(ctx.db, limit))];
    const results = await coordinator.run(tasks);
    const terms = decode<GlossaryTerm[]>(results[0]?.text, []);
    entries = terms.map(toEntry);
    mode = "list";
    const gaps = buildGaps(ctx.db, counts, passState.lastPassAt, entries.length, truncation);
    return {
      kind: "glossary",
      agentVersion: 1,
      generatedAt: Date.now(),
      latencyMs: Math.round(performance.now() - start),
      gaps,
      query: { term: null, limit },
      mode,
      entries,
      matchedVia: null,
      suggestions: [],
      stats: {
        ...counts,
        lastPassAt: passState.lastPassAt,
        truncatedSources: truncation.truncatedSources,
      },
    };
  }

  // Two lanes, not four. `toEntry` already carries topSources and synonyms from
  // the resolved term, so separate lanes for them recomputed `resolveTerm` and
  // threw the result away — burning coordinator budget and making "four parallel
  // lanes" a misnomer.
  //
  // Near-miss keys come from CONSOLIDATED terms only. Drawing from every key
  // suggests pending terms that have no definition yet, so following the
  // suggestion returns another miss — a loop with no exit.
  const tasks: SubTask[] = [
    subAgent(() => resolveTerm(ctx.db, rawTerm)),
    subAgent(() =>
      findNearMisses(
        normalizeTerm(rawTerm),
        listConsolidated(ctx.db, NEAR_MISS_POOL).map((t) => t.termKey),
      ),
    ),
  ];
  const results = await coordinator.run(tasks);

  const resolved = decode<{ term: GlossaryTerm | null; matchedVia: GlossaryMatchedVia }>(
    results[0]?.text,
    { term: null, matchedVia: null },
  );
  const nearMisses = decode<string[]>(results[1]?.text, []);

  if (resolved.term === null) {
    mode = "miss";
    suggestions = nearMisses;
  } else {
    mode = "term";
    matchedVia = resolved.matchedVia;
    entries = [toEntry(resolved.term)];
  }

  return {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps(ctx.db, counts, passState.lastPassAt, entries.length, truncation),
    query: { term: rawTerm, limit },
    mode,
    entries,
    matchedVia,
    suggestions,
    stats: {
      ...counts,
      lastPassAt: passState.lastPassAt,
      truncatedSources: truncation.truncatedSources,
    },
  };
}

export function emitGlossaryBrief(
  input: GlossaryInput,
  ctx: GlossaryContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "glossary.briefReady",
    briefErrorMethod: "glossary.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runGlossary(input, ctx),
  });
}
