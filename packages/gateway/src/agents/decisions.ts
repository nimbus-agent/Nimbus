import type { Database } from "bun:sqlite";

import { explainConfidence } from "../decisions/decision-confidence.ts";
import { matchesService, type ServiceMatchRoute } from "../decisions/decision-service-scope.ts";
import { countByStatus, listDecisions, readPassState } from "../decisions/decision-store.ts";
import type { DecisionRecord } from "../decisions/decision-types.ts";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type { DecisionsBrief, DecisionsEntry, DecisionsInput } from "./_lib/decisions-types.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type DecisionsContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
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

  // Standing honesty note — permanent, not conditional. Recall is capped by
  // what the index actually holds, and a brief that omits this overstates it.
  gaps.push({
    category: "missing_relation_emit",
    detail:
      "Item bodies are indexed to 512 characters, so a decision stated later in a long " +
      "document or thread is not visible to this pass. Recall is capped, not complete.",
  });

  // Second standing honesty note, also unconditional: the score scale a reader
  // sees is not the scale the pass can actually reach. The corroboration term
  // reserves its full 1.0 for `migration`/`iac` evidence, but no connector
  // indexes changed-file paths today, so that kind is specified and never
  // emitted. Presenting a 0..1 score without saying 1.0 is unreachable would
  // make every real decision look under-evidenced.
  gaps.push({
    category: "missing_relation_emit",
    detail:
      "Confidence tops out at 0.86, not 1.0. The corroboration term reserves its full score " +
      "for migration/iac evidence — derived from a corroborating change's file paths — and no " +
      "connector indexes changed-file paths, so that evidence is specified but never emitted. " +
      "With only PR/commit corroboration reachable, corroboration caps at 0.6 and total " +
      "confidence at 0.86.",
    remediation:
      "Read scores against a 0.86 ceiling, not a full-marks scale; a 0.86 decision is a " +
      "maximally-corroborated one.",
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
  ];
  const results = await coordinator.run(tasks);

  const rows = decode<DecisionRecord[]>(results[0]?.text, []);
  const counts = decode(results[1]?.text, { total: 0, pending: 0, extracted: 0, vetoed: 0 });
  const passState = decode<{ lastPassAt: number | null }>(results[2]?.text, { lastPassAt: null });

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
    ),
    query: { sinceMs: cutoffMs, service, minConfidence, explain },
    entries,
    stats: { ...counts, lastPassAt: passState.lastPassAt },
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
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runDecisions(input, ctx),
  });
}
