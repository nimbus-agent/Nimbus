// packages/gateway/src/automation/workflow-guard.ts
// The `when` guard of a workflow step: evaluation, owner-facing text and THE definition of which
// guards a standing rule may cover. Pure: no I/O, no clock, no executor, vault, network or model
// import (static D44(g) pins that), so the one decision "does this step run" is made from nothing
// but the run's own declared-query results.
//
// A guard is a closed comparison over the COUNT of an earlier `query` step (`workflow-steps.ts`
// validates the shape, the earlier-query rule and the operand matrix). Everything here reads the
// parsed `WorkflowGuard[]`.
import { sanitisePreviewText } from "../connectors/connector-writes/sanitise.ts";
import type { GuardOp, WorkflowGuard, WorkflowStep } from "./workflow-steps.ts";

/** What a run keeps of one `query` step: where it sat, what it selected, whether it hit its limit. */
export type QueryCount = {
  readonly index: number;
  readonly values: readonly string[];
  /** The SELECT returned `limit` rows, so `values.length` is only a lower bound of the real count. */
  readonly capped: boolean;
};

/** One comparison as it was evaluated: small numbers and fixed words only (it goes into the audit row). */
export type GuardObservation = {
  /** The flat step index of the query step (never its label: labels have no length cap). */
  readonly query: number;
  readonly op: GuardOp;
  readonly value: number;
  readonly observed: number;
  readonly capped: boolean;
  readonly holds: boolean;
};

export type GuardEvaluation = {
  readonly holds: boolean;
  /** One entry per comparison, in order, even after one failed. */
  readonly observed: readonly GuardObservation[];
};

function compare(count: number, op: GuardOp, value: number): boolean {
  switch (op) {
    case "gt":
      return count > value;
    case "gte":
      return count >= value;
    case "lt":
      return count < value;
    case "lte":
      return count <= value;
    case "eq":
      return count === value;
    case "ne":
      return count !== value;
  }
}

/**
 * Whether one comparison holds. On a CAPPED query the observed count is a lower bound of the real
 * one, so only a statement that stays true as the count rises can hold: `gt` and `gte` (when the
 * lower bound already satisfies them) and `ne 0` (when the lower bound is at least 1: more rows
 * cannot bring the count to zero). Every other comparison on a capped query fails closed.
 */
function holdsOn(count: number, capped: boolean, op: GuardOp, value: number): boolean {
  if (!compare(count, op, value)) return false;
  if (!capped) return true;
  return op === "gt" || op === "gte" || (op === "ne" && value === 0);
}

/**
 * Evaluates every comparison of `when` against the run's query results. Throws when a named query
 * has no result (the parser guarantees an earlier query step, and a failed query halts the run
 * first), so a missing result can never read as "holds" or as a count of zero.
 */
export function evaluateGuard(
  when: readonly WorkflowGuard[],
  queries: ReadonlyMap<string, QueryCount>,
): GuardEvaluation {
  const observed: GuardObservation[] = when.map((g) => {
    const q = queries.get(g.count);
    if (q === undefined) throw new Error(`guard: query "${g.count}" has not run`);
    const count = q.values.length;
    return {
      query: q.index,
      op: g.op,
      value: g.value,
      observed: count,
      capped: q.capped,
      holds: holdsOn(count, q.capped, g.op, g.value),
    };
  });
  return { holds: observed.every((o) => o.holds), observed };
}

/**
 * THE definition of which guards a standing rule may cover (I55): a step with NO guard, or a guard
 * in which EVERY comparison is false at a count of zero. An empty result is also what a failed
 * sync, a lapsed credential and an empty index produce, so a guard that can hold at zero could let
 * a broken connector trigger a write nobody was asked about. Rule creation, rule resume, the
 * learner and the rule text all call this one function.
 */
export function guardRequiresPresence(when: readonly WorkflowGuard[] | undefined): boolean {
  if (when === undefined) return true;
  return when.every((g) => !compare(0, g.op, g.value));
}

const SYMBOL: Readonly<Record<GuardOp, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "==",
  ne: "!=",
};

const WORDS: Readonly<Record<GuardOp, string>> = {
  gt: "more than",
  gte: "at least",
  lt: "fewer than",
  lte: "at most",
  eq: "exactly",
  ne: "anything but",
};

/** The guard as one sanitised line: `count(old-read-mail) > 0 AND count(p1) == 0`. */
export function guardText(when: readonly WorkflowGuard[]): string {
  return when
    .map((g) => `count(${sanitisePreviewText(g.count)}) ${SYMBOL[g.op]} ${String(g.value)}`)
    .join(" AND ");
}

/** The observation as the step record shows it, for example `old-read-mail selects 0`. */
export function observationText(o: GuardObservation): string {
  return `${String(o.observed)}${o.capped ? " (capped, at least)" : ""}`;
}

/**
 * The lines the standing-rule approval text carries for a guarded write, one per comparison
 * (`query step 2 (old-read-mail) selects more than 0`), then a closing line when there are several.
 * The query's flat number is the one `scopeLine` uses. Every stored word goes through
 * `sanitisePreviewText`.
 */
export function guardRuleLines(
  when: readonly WorkflowGuard[],
  steps: readonly WorkflowStep[],
): string[] {
  const lines = when.map((g) => {
    const at = steps.findIndex((s) => s.kind === "query" && s.label === g.count);
    return `Runs only when: query step ${String(at + 1)} (${sanitisePreviewText(g.count)}) selects ${WORDS[g.op]} ${String(g.value)}`;
  });
  if (lines.length > 1) lines.push("(all of these must hold)");
  return lines;
}
