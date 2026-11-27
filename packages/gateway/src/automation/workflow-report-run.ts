// Phase 7 (the Cost Pack, slice 4): runs a workflow's `report` step — the ONLY producer of a report output
// (static D44 clause `standing-report-source-confined`).
//
// The step renders the report EMBEDDED in the workflow (its template text, scope, period and frozen zone) over
// the local cost lines and the CURRENT `[cost]` config (rules, authoritative source), with no model, no tool
// output and no network. Its `{ body, subject }` reach a later write only through the `{ report }` value source
// (`workflow-write-step.ts`). Owner ruling 2026-11-27: when no cost line of any source falls in the report's
// period, the step ends the run `skipped` with the reason (nothing is dispatched; the scheduler tells the owner).
import type { Database } from "bun:sqlite";

import { loadNimbusCostFromConfigDir } from "../config/cost-toml.ts";
import { buildCostReport } from "../finops/cost-report-model.ts";
import { reportPeriods } from "../finops/cost-report-period.ts";
import { gatherCostViewInput } from "../finops/cost-view-input.ts";
import { renderReportText } from "./cost-report-render.ts";
import type { ReportWorkflowStep } from "./workflow-step-report.ts";
import { updateWorkflowRunStepRow } from "./workflow-store.ts";

/** A report step's rendered output, by its label. */
export type ReportOutputs = Map<
  string,
  { readonly index: number; readonly body: string; readonly subject: string | null }
>;

export interface ReportRunDeps {
  readonly db: Database;
  /** Where the `[cost]` config is read from; absent means this gateway cannot run report steps. */
  readonly configDir: string | undefined;
  readonly now: () => number;
}

export type ReportRunOutcome =
  | { readonly kind: "ok"; readonly label: string; readonly reply: string }
  | { readonly kind: "err"; readonly label: string; readonly message: string; readonly halt: true }
  /** No cost data for the period: the run ends `skipped` with this reason. */
  | { readonly kind: "skipped_run"; readonly label: string; readonly message: string };

function finish(
  deps: ReportRunDeps,
  runId: string,
  stepIndex: number,
  status: string,
  detail: unknown,
): void {
  updateWorkflowRunStepRow(deps.db, runId, stepIndex, {
    status,
    resultJson: JSON.stringify(detail),
    finishedAt: Date.now(),
  });
}

export function executeReportStep(
  deps: ReportRunDeps,
  runId: string,
  stepIndex: number,
  step: ReportWorkflowStep,
  reports: ReportOutputs,
): ReportRunOutcome {
  const label = step.label;
  const fail = (message: string): ReportRunOutcome => {
    finish(deps, runId, stepIndex, "error", { error: message });
    return { kind: "err", label, message, halt: true };
  };
  if (deps.configDir === undefined) {
    return fail("this gateway cannot run report steps (no config directory for the [cost] config)");
  }
  try {
    const r = step.report;
    const nowMs = deps.now();
    const cfg = loadNimbusCostFromConfigDir(deps.configDir);
    if (cfg.error !== null) {
      return fail(`the [cost] config was refused, so no report was rendered: ${cfg.error}`);
    }
    const { range, previous, weekStart } = reportPeriods(r.period, r.tz, nowMs);
    const both = gatherCostViewInput(
      deps.db,
      cfg,
      {
        fromDay: previous.fromDay,
        toDay: range.toDay,
        label: `${previous.label} and ${range.label}`,
      },
      nowMs,
    );
    // Owner ruling 2: "no cost data" means no line of ANY source in the report's period (not
    // `CostReportModel.empty`, and before `[cost] authoritative` drops a provider's other sources).
    const present = [...(both.presentDays ?? [])];
    if (!present.some((d) => d >= range.fromDay && d <= range.toDay)) {
      const message = `no cost data for ${range.fromDay} to ${range.toDay}; nothing was posted`;
      finish(deps, runId, stepIndex, "skipped", { skipped: message });
      return { kind: "skipped_run", label, message };
    }
    const def = {
      name: r.name,
      scope: r.scope,
      period: r.period,
      schedule: null,
      tz: r.tz,
      channels: [],
    };
    const model = buildCostReport({
      lines: both.lines,
      rules: cfg.rules,
      configError: cfg.error,
      def,
      range,
      previous,
      weekStart,
      nowMs,
      lastDays: both.lastDays,
      sourceGaps: both.sourceGaps ?? new Map(),
      empty: both.empty,
    });
    const text = renderReportText(r, model);
    reports.set(label, { index: stepIndex, body: text.body, subject: text.subject });
    finish(deps, runId, stepIndex, "done", {
      range: [range.fromDay, range.toDay],
      chars: text.body.length,
      truncated: text.truncated,
    });
    return { kind: "ok", label, reply: `rendered ${String(text.body.length)} characters` };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
