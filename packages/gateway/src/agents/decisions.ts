import type { Database } from "bun:sqlite";

import { explainConfidence, maxReachableConfidence } from "../decisions/decision-confidence.ts";
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

function buildGaps(
  db: Database,
  counts: { total: number; pending: number; extracted: number; vetoed: number },
  lastPassAt: number | null,
  entryCount: number,
  serviceUnmatched: number,
  snippetCount: number,
  truncation: { totalSources: number; truncatedSources: number },
): GapNote[] {
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

  // Second standing honesty note, also unconditional: the score scale a reader sees is not the
  // scale the pass can actually reach.
  //
  // The CEILING is derived, not written down (F25). A prose `0.86` beside the arithmetic that
  // produces it is two copies of one fact, and `brief-disclosures.ts` exists because two copies
  // of a disclosure drifted; this is the same failure one level up.
  //
  // The stated CAUSE was stale and is corrected here. It used to read "no connector indexes
  // changed-file paths" — true when written, false since V55 shipped `pr_changed_file` /
  // `pr_files_state`, which `nimbus query --not-touching` already queries and which the same
  // gateway reported as 100% covered in the same session the brief was read. The ceiling is real;
  // its reason is that the extraction pass was never wired to that substrate, which is a small
  // wiring task rather than a permanent fact a reader should stop expecting to change. Those two
  // readings call for opposite actions, and the brief was giving the wrong one.
  //
  // I31 protected the false sentence perfectly — constructed, withheld, re-attached,
  // anchor-checked — and every mechanism made it MORE durable. `confidence-ceiling.test.ts` is
  // the expiry check that was missing: it fails when either half of the premise changes.
  const ceiling = maxReachableConfidence().toFixed(2);
  gaps.push({
    category: "missing_relation_emit",
    detail:
      `Confidence tops out at ${ceiling}, not 1.0. The corroboration term reserves its full ` +
      "score for migration/iac evidence — derived from a corroborating change's file paths — " +
      "and the extraction pass does not yet read the indexed changed-file paths, so that " +
      "evidence is specified but never emitted. With only PR/commit corroboration reachable, " +
      `corroboration caps at 0.6 and total confidence at ${ceiling}.`,
    remediation:
      `Read scores against a ${ceiling} ceiling, not a full-marks scale; a ${ceiling} decision ` +
      "is a maximally-corroborated one. This is a wiring gap, not a permanent limit — the " +
      "changed-file paths it needs are already indexed.",
  });

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

  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps(
      ctx.db,
      counts,
      passState.lastPassAt,
      entries.length,
      serviceUnmatched,
      snippetCount,
      { totalSources, truncatedSources },
    ),
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
