// `decisions.status` (role packs P5): what the decisions pass has read and found, in numbers a
// first-run screen can say in plain words. Read-only. `shown` and `recent` are exactly what
// `nimbus decisions` lists (the brief's read rule, `decisionVisibilityFilter`, its floor and its
// default window); `candidates` uses the same rule over the same window — unlike the brief's own
// status totals, which are all-time — so a row older than the window can never make the screen
// say "too uncertain to show" about decisions the list would not show anyway.

import type { Database } from "bun:sqlite";
import type { SourceMapping } from "../sources/source-mapping.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { countByStatusSince, countShown, listDecisions, readPassState } from "./decision-store.ts";
import { DECISIONS_DEFAULT_WINDOW_MS } from "./decision-types.ts";

export type DecisionPassState = "idle" | "running" | "stopped" | "disabled";

export interface DecisionStatusResult {
  /** A decisions refresher exists (`[decisions] enabled` at boot). */
  readonly enabled: boolean;
  readonly state: DecisionPassState;
  readonly lastPassAt: number | null;
  readonly minConfidence: number;
  readonly windowDays: number;
  /** Effective decision source types with at least one item modified inside the window. */
  readonly sources: readonly {
    readonly service: string;
    readonly type: string;
    readonly kind: string;
    readonly items: number;
  }[];
  readonly candidates: {
    readonly pending: number;
    readonly extracted: number;
    readonly vetoed: number;
  };
  /** Extracted rows at or above `minConfidence` inside the window: what the brief would list. */
  readonly shown: number;
  readonly recent: readonly {
    readonly statement: string;
    readonly service: string;
    readonly at: number;
  }[];
}

const RECENT_LIMIT = 5;
const STATEMENT_MAX = 280;

function sourceCounts(
  db: Database,
  mapping: SourceMapping,
  sinceMs: number,
): DecisionStatusResult["sources"] {
  const out: { service: string; type: string; kind: string; items: number }[] = [];
  const count = db.query(
    "SELECT COUNT(*) AS n FROM item WHERE service = ? AND type = ? AND modified_at >= ?",
  );
  try {
    const effective = new Set(mapping.typesFor("decisions"));
    for (const entry of mapping.entries) {
      if (!effective.has(entry.serviceType)) continue;
      const sep = entry.serviceType.indexOf(":");
      const service = entry.serviceType.slice(0, sep);
      const type = entry.serviceType.slice(sep + 1);
      const n = (count.get(service, type, sinceMs) as { n: number }).n;
      if (n > 0) out.push({ service, type, kind: entry.kind, items: n });
    }
  } finally {
    count.finalize();
  }
  return out.sort(
    (a, b) =>
      b.items - a.items || codeUnitCompare(`${a.service}:${a.type}`, `${b.service}:${b.type}`),
  );
}

function serviceByItem(db: Database, ids: readonly string[]): ReadonlyMap<string, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .query(`SELECT id, service FROM item WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Array<{ id: string; service: string }>;
  return new Map(rows.map((r) => [r.id, r.service]));
}

export function readDecisionStatus(
  db: Database,
  opts: {
    readonly mapping: SourceMapping;
    readonly nowMs: number;
    readonly minConfidence: number;
    /** The refresher's `status()`; `undefined` when no refresher was constructed. */
    readonly refresherState: DecisionPassState | undefined;
  },
): DecisionStatusResult {
  const sinceMs = opts.nowMs - DECISIONS_DEFAULT_WINDOW_MS;
  const read = { sinceMs, minConfidence: opts.minConfidence, mapping: opts.mapping };
  const latest = listDecisions(db, { ...read, limit: RECENT_LIMIT });
  const services = serviceByItem(
    db,
    latest.map((d) => d.sourceItemId),
  );
  return {
    enabled: opts.refresherState !== undefined,
    state: opts.refresherState ?? "disabled",
    lastPassAt: readPassState(db).lastPassAt,
    minConfidence: opts.minConfidence,
    windowDays: DECISIONS_DEFAULT_WINDOW_MS / 86_400_000,
    sources: sourceCounts(db, opts.mapping, sinceMs),
    candidates: countByStatusSince(db, opts.mapping, sinceMs),
    shown: countShown(db, read),
    recent: latest.map((d) => ({
      statement: (d.statement ?? d.cueText).slice(0, STATEMENT_MAX),
      service: services.get(d.sourceItemId) ?? "unknown",
      at: d.decidedAt,
    })),
  };
}
