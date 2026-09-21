// packages/gateway/src/agents/_lib/tour-selectors.ts

/**
 * The six deterministic `nimbus wow` tour SELECTORS — one per {@link TourStepKind} — each asking
 * "is there something in this index worth showing, and with what arguments?".
 *
 * Every selector's predicate IS the agent's own read predicate, imported — never a re-written
 * `SELECT 1 FROM <table>`. Lives in `agents/_lib/` for the reason `tour-types.ts` states: static
 * rule D22(d) forbids importing an `agents/<name>.ts` emitter (or query module) from outside
 * `ipc/agents-rpc.ts`, and `agents/_lib/` is the precedent-established exception.
 */
import type { Database } from "bun:sqlite";
import { isAbsolute, join, relative } from "node:path";
import { listDecisions } from "../../decisions/decision-store.ts";
import { enumeratePaths } from "../../fleet/fleet-sweep-enumerators.ts";
import { listConsolidated } from "../../glossary/glossary-store.ts";
import { codeUnitCompare } from "../../util/code-unit-compare.ts";
import { selectNewestIncident } from "../oncall-queries.ts";
import {
  selectActivePrs,
  selectIncidentsResponded,
  selectMergedPrs,
  selectMessages,
  selectReviews,
  selectTicketsOpened,
  type Window,
} from "../standup-queries.ts";
import { pickDemoSymbol } from "./demo-symbol.ts";
import type { TourStepKind } from "./tour-types.ts";

export interface TourCandidate {
  readonly title: string;
  readonly args: readonly string[];
  readonly reason: string;
}
export type TourSelectorResult = { readonly ok: TourCandidate } | { readonly skip: string };
export interface TourSelectorCtx {
  readonly db: Database;
  readonly nowMs: number;
  /** `[[filesystem.roots]]` paths, VERBATIM as configured (what `pickDemoSymbol` keys on). */
  readonly fsRoots: readonly string[];
  /** `ownershipRoots(configDir)` — the git-aware roots the ownership pass covers. */
  readonly ownershipRoots: readonly string[];
  /** `[decisions] min_confidence`, or 0 — the SAME default `handleDecisions` applies. */
  readonly decisionsMinConfidence: number;
  /** Resolves "me", or null. MUST NOT throw. */
  readonly resolveSelf: () => Promise<string | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors `agents/decisions.ts` DEFAULT_WINDOW_MS — the brief's own default window. */
const DECISIONS_WINDOW_MS = 90 * DAY_MS;

function selectWhy(ctx: TourSelectorCtx): TourSelectorResult {
  for (const root of ctx.fsRoots) {
    const sym = pickDemoSymbol(ctx.db, root);
    if (sym !== null) {
      return {
        ok: {
          title: "Why this code exists",
          args: [join(root, sym.file), "--line", String(sym.line)],
          reason: `symbol \`${sym.name}\``,
        },
      };
    }
  }
  return { skip: "no indexed symbols in configured roots" };
}

function selectOwners(ctx: TourSelectorCtx): TourSelectorResult {
  const { subjects } = enumeratePaths(ctx.db, ctx.ownershipRoots, "path", null);
  const files: string[] = [];
  const dirs: string[] = [];
  for (const s of subjects) {
    const p = s.params["path"];
    if (p === undefined) continue;
    (s.key.startsWith("paths:file:") ? files : dirs).push(p);
  }
  if (dirs.length === 0 || files.length === 0) return { skip: "no ownership pass data indexed" };
  const roots = new Set(ctx.ownershipRoots);
  const nonRoot = dirs.filter((d) => !roots.has(d));
  const pool = nonRoot.length > 0 ? nonRoot : dirs;
  // The same containment fence `matchConfiguredRoot` uses — separator-safe on every OS, and
  // `/repo/src` never claims `/repo/src-old/x.ts` the way a `startsWith` would.
  const isUnder = (d: string, f: string): boolean => {
    const rel = relative(d, f);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const under = (d: string): number => files.filter((f) => isUnder(d, f)).length;
  const ranked = pool
    .map((d) => ({ d, n: under(d) }))
    .sort((a, b) => b.n - a.n || codeUnitCompare(a.d, b.d));
  const best = ranked[0];
  if (best === undefined || best.n === 0) return { skip: "no ownership pass data indexed" };
  return {
    ok: {
      title: "Who owns this code",
      args: [best.d],
      reason: `${String(best.n)} files under ownership`,
    },
  };
}

function selectOncall(ctx: TourSelectorCtx): TourSelectorResult {
  const inc = selectNewestIncident(ctx.db);
  if (inc === null) return { skip: "no indexed incidents" };
  return {
    ok: { title: "On-call triage", args: ["--incident", inc.id], reason: `incident: ${inc.title}` },
  };
}

async function selectStandup(ctx: TourSelectorCtx): Promise<TourSelectorResult> {
  const skip: TourSelectorResult = { skip: "no recent activity attributable to you" };
  let me: string | null;
  try {
    me = await ctx.resolveSelf();
  } catch {
    return skip;
  }
  if (me === null) return skip;
  const w: Window = { fromMs: ctx.nowMs - DAY_MS, toMs: ctx.nowMs };
  const lanes = [
    selectActivePrs,
    selectMergedPrs,
    selectReviews,
    selectTicketsOpened,
    selectIncidentsResponded,
    selectMessages,
  ];
  const hasRecentActivity = lanes.some((lane) => lane(ctx.db, w, me).length > 0);
  return hasRecentActivity
    ? {
        ok: {
          title: "Your last 24 hours",
          args: [],
          reason: "activity attributed to you in the last 24h",
        },
      }
    : skip;
}

function selectDecisions(ctx: TourSelectorCtx): TourSelectorResult {
  const rows = listDecisions(ctx.db, {
    sinceMs: ctx.nowMs - DECISIONS_WINDOW_MS,
    minConfidence: ctx.decisionsMinConfidence,
    limit: 1,
  });
  return rows.length > 0
    ? {
        ok: {
          title: "Decisions your team made",
          args: [],
          reason: "extracted decisions in the last 90 days",
        },
      }
    : { skip: "no extracted decisions in the last 90 days" };
}

function selectGlossary(ctx: TourSelectorCtx): TourSelectorResult {
  return listConsolidated(ctx.db, 1).length > 0
    ? {
        ok: {
          title: "Your team's vocabulary",
          args: [],
          reason: "consolidated glossary terms are indexed",
        },
      }
    : { skip: "no consolidated glossary terms" };
}

export const TOUR_SELECTORS: Readonly<
  Record<TourStepKind, (ctx: TourSelectorCtx) => TourSelectorResult | Promise<TourSelectorResult>>
> = {
  why: selectWhy,
  owners: selectOwners,
  oncall: selectOncall,
  standup: selectStandup,
  decisions: selectDecisions,
  glossary: selectGlossary,
};
