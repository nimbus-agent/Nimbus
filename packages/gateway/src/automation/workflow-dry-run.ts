import type { Database } from "bun:sqlite";
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import type { WorkflowTrigger } from "../engine/types.ts";
import { type DeclaredQueryResult, runDeclaredQuery } from "./declared-query.ts";
import { evaluateGuard, guardText, observationText, type QueryCount } from "./workflow-guard.ts";
import { previewHitlActionsForStepText } from "./workflow-hitl-preview.ts";
import type { DeclaredQuery, RunWorkflowStep, WorkflowStep } from "./workflow-steps.ts";

/**
 * The dry run's preview of a workflow's steps (moved out of `workflow-runner.ts`, unchanged): each
 * step as its declared form, and for a guarded step what its `when` would do on the index now.
 */

/** One entry of a run's `stepResults`. */
export type WorkflowStepResult = {
  label?: string;
  status: string;
  output?: string;
  error?: string;
  hitlActions?: readonly string[];
  /** A guarded step's `when`, as one sanitised line. */
  guard?: string;
  /** Dry run only: what the guard would do now. */
  evaluation?: string;
};

/** What the dry run reads its guard counts with (a subset of the run's params). */
export type DryRunQueryParams = {
  readonly db: Database;
  readonly trigger?: WorkflowTrigger;
  readonly queryRunner?: (db: Database, q: DeclaredQuery) => DeclaredQueryResult;
};

export function stepLabelOf(step: WorkflowStep, stepIndex: number): string {
  return step.label ?? `step-${String(stepIndex + 1)}`;
}

/** What the dry run learned about one query a guard names: its count, or why it could not be read. */
export type DryObservation = { readonly count: QueryCount } | { readonly error: string };

const DRY_AS_OF = "as of now; a real run re-reads the index";
const NOT_EVALUATED = "not evaluated: only the owner's CLI or desktop connection evaluates guards";

/** What a guard would do against the dry run's observations, as one owner-readable line. */
function dryEvaluation(
  when: NonNullable<RunWorkflowStep["when"]>,
  observed: ReadonlyMap<string, DryObservation> | undefined,
): string {
  if (observed === undefined) return NOT_EVALUATED;
  const queries = new Map<string, QueryCount>();
  for (const g of when) {
    const o = observed.get(g.count);
    if (o === undefined) return `cannot tell: query "${g.count}" was not read`;
    if ("error" in o) return `cannot tell: ${o.error}`;
    queries.set(g.count, o.count);
  }
  const ev = evaluateGuard(when, queries);
  const counts = ev.observed.map((o) => observationText(o)).join(", ");
  if (ev.holds) return `would run (selects ${counts}; ${DRY_AS_OF})`;
  const cappedFailure = ev.observed.some((o) => o.capped && !o.holds);
  return cappedFailure
    ? `would not run (selects ${counts}; a query hit its limit, so a comparison other than gt, gte or ne 0 cannot be established; ${DRY_AS_OF})`
    : `would not run (selects ${counts}; ${DRY_AS_OF})`;
}

/** One step's dry-run entry: a prompt as before; a query or write shown as the declared form. */
export function previewStep(
  s: WorkflowStep,
  i: number,
  observed: ReadonlyMap<string, DryObservation> | undefined,
): WorkflowStepResult {
  const label = stepLabelOf(s, i);
  if (s.kind === "query") {
    return { label, status: "preview", output: JSON.stringify(s.query), hitlActions: [] };
  }
  let entry: WorkflowStepResult;
  if (s.kind === "run") {
    entry = {
      label,
      status: "preview",
      output: s.run,
      hitlActions: previewHitlActionsForStepText(s.run),
    };
  } else {
    const row = connectorWriteRowByToolId(s.tool);
    entry = {
      label,
      status: "preview",
      output: `write ${s.tool} ${JSON.stringify(s.input)}`,
      hitlActions: row === undefined ? [] : [row.actionType],
    };
  }
  if (s.when !== undefined) {
    entry.guard = guardText(s.when);
    entry.evaluation = dryEvaluation(s.when, observed);
  }
  return entry;
}

/**
 * Reads, once each, the queries the guards of `steps` name (read-only bound SELECTs), for a dry run.
 * Only the owner's CLI or desktop connection gets counts (the trigger is derived from the declared
 * kind, never from params): another local kind gets the guard text and no count.
 */
export function observeGuardQueries(
  p: DryRunQueryParams,
  steps: readonly WorkflowStep[],
): ReadonlyMap<string, DryObservation> | undefined {
  if (p.trigger !== "owner_cli" && p.trigger !== "owner_ui") return undefined;
  const named = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "query" && s.when !== undefined) for (const g of s.when) named.add(g.count);
  }
  const out = new Map<string, DryObservation>();
  steps.forEach((s, index) => {
    if (s.kind !== "query" || !named.has(s.label)) return;
    try {
      const r = (p.queryRunner ?? runDeclaredQuery)(p.db, s.query);
      out.set(s.label, { count: { index, values: r.values, capped: r.rows >= s.query.limit } });
    } catch (err) {
      out.set(s.label, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return out;
}
