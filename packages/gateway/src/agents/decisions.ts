import type { Database } from "bun:sqlite";

import { computeConfidence, explainConfidence } from "../decisions/decision-confidence.ts";
import { loadDecisionCandidates } from "../decisions/decision-extract.ts";
import { matchesService, type ServiceMatchRoute } from "../decisions/decision-service-scope.ts";
import { countByStatus, listDecisions, readPassState } from "../decisions/decision-store.ts";
import type { DecisionRecord } from "../decisions/decision-types.ts";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type { DecisionsBrief, DecisionsEntry, DecisionsInput } from "./_lib/decisions-types.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { decode, subAgent } from "./_lib/sub-agent.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

export type DecisionsContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  runner?: SynthesisRunner;
  /**
   * `[decisions].min_confidence` from `nimbus.toml`, resolved by the caller
   * (`ipc/agents-rpc.ts`) so this module keeps no config-file dependency. Used
   * ONLY when the request omits `minConfidence` — an explicit `--min-confidence`
   * always wins, including an explicit `0`.
   */
  defaultMinConfidence?: number;
};

const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;

function serviceTypeOf(db: Database, itemId: string): string {
  const r = db.query("SELECT service, type FROM item WHERE id = ?").get(itemId) as {
    service: string;
    type: string;
  } | null;
  return r === null ? "unknown:unknown" : `${r.service}:${r.type}`;
}

function toEntry(
  db: Database,
  r: DecisionRecord,
  explain: boolean,
  matchedVia: ServiceMatchRoute | null,
): DecisionsEntry {
  return {
    id: r.id,
    statement: r.statement ?? "",
    rationale: r.rationale,
    alternatives: [...r.alternatives],
    confidence: r.confidence,
    decidedAt: r.decidedAt,
    hasAdr: r.hasAdr,
    extractionSource: r.extractionSource,
    evidence: [...r.evidence],
    explain: explain
      ? explainConfidence({
          tier: r.cueTier,
          serviceType: serviceTypeOf(db, r.sourceItemId),
          evidenceKinds: r.evidence.map((e) => e.kind),
          hasRationale: r.rationale !== null,
          hasAlternatives: r.alternatives.length > 0,
        })
      : [],
    matchedVia,
  };
}

/**
 * One object rather than eight positionals (Sonar `S107`). At that arity the call site is a
 * column of bare numbers whose meaning depends on order — `entryCount, serviceUnmatched,
 * snippetCount` are three `number`s the compiler will happily let you transpose.
 */
interface GapInputs {
  readonly counts: { total: number; pending: number; extracted: number; vetoed: number };
  readonly lastPassAt: number | null;
  readonly entryCount: number;
  readonly serviceUnmatched: number;
  readonly snippetCount: number;
  readonly truncation: { totalSources: number; truncatedSources: number };
  readonly staleScoreCount: number;
}

function buildGaps(db: Database, input: GapInputs): GapNote[] {
  const {
    counts,
    lastPassAt,
    entryCount,
    serviceUnmatched,
    snippetCount,
    truncation,
    staleScoreCount,
  } = input;
  const gaps: GapNote[] = [];
  const anyItems = db.query("SELECT 1 FROM item LIMIT 1").get() !== null;

  // Claim an empty index ONLY when also returning nothing. Telling a user the
  // index is empty while showing them decisions is self-contradictory — the
  // same bug glossary already fixed.
  if (!anyItems && entryCount === 0) {
    gaps.push({
      category: "empty_index",
      detail: "The local index is empty, so no decisions could be extracted.",
      remediation: "Connect a source and run a sync, then try again.",
    });
  } else if (lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The decision extraction pass has not run yet.",
      remediation: "Run `nimbus decisions --refresh`, or wait for the next connector sync.",
    });
  }

  if (counts.pending > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(counts.pending)} candidate(s) are still awaiting extraction.`,
      remediation: "The list fills in progressively — later passes will extract them.",
    });
  }

  if (snippetCount > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(snippetCount)} decision(s) are verbatim snippets rather than model-extracted.`,
      remediation:
        "Start a local model (Ollama or llama.cpp) and run `nimbus decisions --refresh`; " +
        "snippet rows are re-extracted automatically on later passes.",
    });
  }

  if (serviceUnmatched > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail: `${String(serviceUnmatched)} decision(s) match neither a repository nor a ticket project key.`,
      remediation:
        "Decisions recorded only in a chat channel or wiki page cannot be service-scoped " +
        "until those connectors index a human-readable channel/space name.",
    });
  }

  // Honesty note, now precise rather than a blanket cap claim: most sources
  // carry a full body since V48, but a source is truncated when its connector
  // has not declared a full body yet, or declared one that exceeded its
  // type's cap. Conditional, not standing — an all-complete window states
  // nothing false by staying silent.
  if (truncation.truncatedSources > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        `${String(truncation.truncatedSources)} of ${String(truncation.totalSources)} ` +
        "source(s) considered in this window were indexed with a truncated body, so a " +
        "decision stated past that cutoff is not visible to this pass. Recall is capped " +
        "for those sources only, not complete.",
    });
  }

  // The standing "confidence tops out at 0.86" note is GONE (F25). It said the ceiling existed
  // because no connector indexed changed-file paths — true when written, false since V55 — and
  // the real cause was that `corroboration()` reserved its top score for `migration`/`iac`
  // evidence that nothing emits. Those two dead branches were removed rather than re-explained,
  // so the ceiling is 1.0 and there is nothing left to disclose.
  //
  // What IS disclosed is the transition. `listDecisions` filters on the STORED `confidence`
  // column in SQL, so a row scored under the old formula reads low until a later pass
  // re-verifies it — and a low score with no explanation is exactly the "under-evidenced"
  // misreading the old note existed to prevent. Conditional and self-clearing: it names a count
  // it measured, and says nothing once every row has been rescored.
  if (staleScoreCount > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        `${String(staleScoreCount)} decision(s) still carry a confidence scored on the previous ` +
        "scale, which capped at 0.86, and read lower than the same evidence would score now.",
      remediation:
        "They are rescored automatically as later passes re-verify them; " +
        "`nimbus decisions --refresh` does it immediately.",
    });
  }

  return gaps;
}

export async function runDecisions(
  input: DecisionsInput,
  ctx: DecisionsContext,
): Promise<DecisionsBrief> {
  const start = performance.now();
  const now = Date.now();
  // `input.sinceMs` is a DURATION (the repo-wide convention every other agent
  // follows — see `catchup.ts`'s `now - sinceMs` — and what the CLI's
  // `parseDurationToMs("90d")` produces). Reading it as an absolute epoch
  // cutoff made `--since` inert: `7d` filtered on `decided_at >= 604800000`
  // (Jan 1970) and matched everything.
  const windowMs = input.sinceMs ?? DEFAULT_WINDOW_MS;
  // The store, by contrast, filters on an ABSOLUTE `decided_at` floor, and
  // `query.sinceMs` carries that same absolute cutoff so `renderDecisions`'s
  // `decisionsWindowDays(generatedAt, sinceMs)` recovers the window in days.
  const cutoffMs = now - windowMs;
  const minConfidence = input.minConfidence ?? ctx.defaultMinConfidence ?? 0;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const explain = input.explain === true;
  const service = input.service ?? null;

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `decisions:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    subAgent(() => listDecisions(ctx.db, { sinceMs: cutoffMs, minConfidence, limit })),
    subAgent(() => countByStatus(ctx.db)),
    subAgent(() => readPassState(ctx.db)),
    // The honesty count: how many of the decision-source items considered in
    // this window were indexed with a truncated body. A separate scan from
    // `listDecisions` above — it covers every candidate source in the window,
    // not just the ones that produced a decision.
    subAgent(() => loadDecisionCandidates(ctx.db, { sinceMs: cutoffMs })),
  ];
  const results = await coordinator.run(tasks);

  const rows = decode<DecisionRecord[]>(results[0]?.text, []);
  const counts = decode(results[1]?.text, { total: 0, pending: 0, extracted: 0, vetoed: 0 });
  const passState = decode<{ lastPassAt: number | null }>(results[2]?.text, { lastPassAt: null });
  const candidates = decode<{ total: number; truncatedSources: number }>(results[3]?.text, {
    total: 0,
    truncatedSources: 0,
  });
  const totalSources = candidates.total;
  const truncatedSources = candidates.truncatedSources;

  let serviceUnmatched = 0;
  const entries: DecisionsEntry[] = [];
  for (const r of rows) {
    if (service === null) {
      entries.push(toEntry(ctx.db, r, explain, null));
      continue;
    }
    const route = matchesService(ctx.db, {
      sourceItemId: r.sourceItemId,
      evidence: r.evidence,
      service,
    });
    if (route === null) {
      serviceUnmatched++;
      continue;
    }
    entries.push(toEntry(ctx.db, r, explain, route));
  }

  // Counted over the ENTRIES, not over `rows`. Every gap note describes the
  // brief the reader is holding, and with `--service` set `rows` still contains
  // the service-unmatched decisions that were filtered out above — counting
  // those would report "N decision(s) are verbatim snippets" about rows the
  // response never shows.
  const snippetCount = entries.filter((e) => e.extractionSource === "snippet").length;

  // A row whose STORED score disagrees with what its own evidence scores today was written by
  // the pre-rescale formula. Recomputed from the record's own fields — the same inputs
  // `explainConfidence` already uses — so this measures the actual disagreement rather than
  // guessing from a timestamp.
  const staleScoreCount = rows.filter((r) => {
    const fresh = computeConfidence({
      tier: r.cueTier,
      serviceType: serviceTypeOf(ctx.db, r.sourceItemId),
      evidenceKinds: r.evidence.map((e) => e.kind),
      hasRationale: r.rationale !== null,
      hasAlternatives: r.alternatives.length > 0,
    });
    return Math.abs(fresh - r.confidence) > 0.005;
  }).length;

  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps(ctx.db, {
      counts,
      lastPassAt: passState.lastPassAt,
      entryCount: entries.length,
      serviceUnmatched,
      snippetCount,
      truncation: { totalSources, truncatedSources },
      staleScoreCount,
    }),
    query: { sinceMs: cutoffMs, service, minConfidence, explain },
    entries,
    stats: { ...counts, lastPassAt: passState.lastPassAt, truncatedSources },
  };
}

export function emitDecisionsBrief(
  input: DecisionsInput,
  ctx: DecisionsContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "decisions.briefReady",
    briefErrorMethod: "decisions.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runDecisions(input, ctx),
  });
}
