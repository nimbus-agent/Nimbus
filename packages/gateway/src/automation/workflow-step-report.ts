// Phase 7 (the Cost Pack, slice 4): the `report` workflow step and the `{ report }` value source.
//
//   { "kind": "report", "label": "render", "report": { "name", "scope", "period", "tz", "kind", "format",
//     "breakdown", "template", "subject" } }
//   { "kind": "write", "tool": <the row for report.kind>,
//     "input": { "channel": { "const": "C0123ABC" }, "text": { "report": "render", "part": "body" } } }
//
// The report definition is EMBEDDED (spec, Resolved 1): the template TEXT, scope, period and zone are part of the
// workflow, so the workflow hash a standing rule binds covers them. The embedded values are checked by the same
// rules as the `[cost]` config, and the template and subject are parsed here, at save, so an unknown placeholder
// can never reach an unattended run. A `{ report }` value may fill ONLY the body (and a draft's subject) of the
// row for the report's kind (`REPORT_BODY_FIELDS`, spec Fixes 1); every other field of that write is a constant.

import {
  CostReportConfigError,
  type CostReportKind,
  type CostReportScope,
  isCostReportName,
  readBreakdown,
  readFormat,
  readInlineTemplate,
  readKind,
  readPeriod,
  readScope,
  readSubject,
} from "../config/cost-report-toml.ts";
import {
  costReportToolFor,
  REPORT_BODY_FIELDS,
} from "../connectors/connector-writes/cost-report-rows.ts";
import {
  assertSubjectTemplate,
  CostTemplateError,
  parseCostTemplate,
} from "../finops/cost-template.ts";
import { isValidTimeZone } from "./cron.ts";
import { isPlainRecord, onlyKeys, parseLabel, refuse } from "./workflow-step-base.ts";
import type { WorkflowStep } from "./workflow-steps.ts";

/** The report a `report` step renders, embedded in the workflow. */
export interface EmbeddedReport {
  readonly name: string;
  readonly scope: CostReportScope;
  readonly period: string;
  /** Always a zone: a report with none has the gateway zone frozen in at generation (owner ruling 2026-11-27). */
  readonly tz: string;
  readonly kind: CostReportKind;
  readonly format: "text" | "markdown" | "html";
  readonly breakdown: "list" | "csv";
  /** The template TEXT. */
  readonly template: string;
  /** The subject template (Gmail and Outlook only), else null. */
  readonly subject: string | null;
}

export type ReportWorkflowStep = { kind: "report"; label: string; report: EmbeddedReport };

/** A write value filled by an earlier report step's rendered body or subject. */
export type ReportValue = { readonly report: string; readonly part: "body" | "subject" };

const REPORT_KEYS = [
  "name",
  "scope",
  "period",
  "tz",
  "kind",
  "format",
  "breakdown",
  "template",
  "subject",
];

/** Run one of the config validators, carrying its message as a step refusal. */
function checked<T>(where: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof CostReportConfigError || e instanceof CostTemplateError) {
      return refuse(e.message.startsWith(where) ? e.message : `${where}: ${e.message}`);
    }
    throw e;
  }
}

function parseEmbedded(raw: unknown, where: string): EmbeddedReport {
  if (!isPlainRecord(raw)) refuse(`${where}: report must be an object`);
  onlyKeys(raw, REPORT_KEYS, `${where} report`);
  const name = raw["name"];
  if (!isCostReportName(name)) {
    refuse(`${where}: name must be lowercase letters, digits and -, 1 to 64`);
  }
  const tz = raw["tz"];
  if (typeof tz !== "string" || !isValidTimeZone(tz)) {
    refuse(`${where}: tz must be an IANA time zone such as Europe/Berlin`);
  }
  const kind = checked(where, () => readKind(raw["kind"], where));
  const subject = checked(where, () => readSubject(kind, raw["subject"] ?? undefined, where));
  const template = checked(where, () => readInlineTemplate(raw["template"], where));
  checked(where, () => parseCostTemplate(template));
  if (subject !== null) checked(where, () => assertSubjectTemplate(parseCostTemplate(subject)));
  return {
    name,
    scope: checked(where, () => readScope(raw["scope"], where)),
    period: checked(where, () => readPeriod(raw["period"], where)),
    tz,
    kind,
    format: checked(where, () => readFormat(kind, raw["format"], where)),
    breakdown: checked(where, () => readBreakdown(raw["breakdown"], where)),
    template,
    subject,
  };
}

export function parseReportRow(rec: Record<string, unknown>, index: number): ReportWorkflowStep {
  const where = `step ${String(index + 1)} (report)`;
  onlyKeys(rec, ["kind", "label", "report"], where);
  const label = parseLabel(rec, where, true) as string;
  return { kind: "report", label, report: parseEmbedded(rec["report"], where) };
}

/** A `{ report, part }` write value (the caller has seen the `report` key). */
export function parseReportValue(
  field: string,
  raw: Record<string, unknown>,
  where: string,
): ReportValue {
  onlyKeys(raw, ["report", "part"], `${where} input.${field}`);
  const report = raw["report"];
  const part = raw["part"];
  if (typeof report !== "string" || report === "") {
    refuse(`${where}: input.${field} needs a report (a report step label)`);
  }
  if (part !== "body" && part !== "subject")
    refuse(`${where}: input.${field} part must be body or subject`);
  return { report, part };
}

const isReportValue = (v: object): v is ReportValue => "report" in v;

/** One write's report values: an EARLIER report step, its own kind's row, the body/subject fields only. */
function checkWrite(
  step: WorkflowStep & { kind: "write" },
  i: number,
  reportAt: ReadonlyMap<string, number>,
  steps: readonly WorkflowStep[],
): void {
  const where = `step ${String(i + 1)} (write)`;
  const entries = Object.entries(step.input);
  const fed = entries.filter(([, v]) => isReportValue(v)) as [string, ReportValue][];
  if (fed.length === 0) return;
  if (entries.some(([, v]) => "from" in v)) {
    refuse(`${where}: a write fed by a report step holds only constants besides it`);
  }
  const fields = REPORT_BODY_FIELDS[step.tool];
  for (const [field, v] of fed) {
    const at = reportAt.get(v.report);
    if (at === undefined || at >= i)
      refuse(`${where}: report "${v.report}": it must name an earlier report step`);
    const target = steps[at];
    if (target?.kind !== "report")
      refuse(`${where}: report "${v.report}": it must name an earlier report step`);
    if (fields === undefined || step.tool !== costReportToolFor(target.report.kind)) {
      refuse(`${where}: a ${target.report.kind} report feeds only the ${target.report.kind} row`);
    }
    if (field !== fields.body && field !== fields.subject)
      refuse(`${where}: ${field} cannot take a report value`);
    if (v.part === "subject" && field !== fields.subject)
      refuse(`${where}: ${field} cannot take the report subject`);
    if (v.part === "body" && field !== fields.body)
      refuse(`${where}: ${field} cannot take the report body`);
  }
  if (new Set(fed.map(([, v]) => v.report)).size > 1) {
    refuse(`${where}: a write may read from only one report step`);
  }
}

/** Cross-step rules for report steps: unique labels, no run step beside them, and every `{ report }` value. */
export function validateReportReferences(steps: readonly WorkflowStep[]): void {
  const reportAt = new Map<string, number>();
  const labelAt = new Map<string, number>();
  steps.forEach((s, i) => {
    const label = s.label ?? `step-${String(i + 1)}`;
    if (s.kind === "report" && (labelAt.has(label) || reportAt.has(label))) {
      refuse(`step ${String(i + 1)}: label "${label}" is already used`);
    }
    if (s.kind !== "report" && reportAt.has(label)) {
      refuse(`step ${String(i + 1)}: label "${label}" is a report step's label`);
    }
    if (s.kind === "report") reportAt.set(label, i);
    labelAt.set(label, i);
  });
  if (reportAt.size > 1) refuse("a workflow can hold at most one report step");
  if (reportAt.size > 0 && steps.some((s) => s.kind === "run")) {
    refuse("a workflow with a report step can hold no run step (it is scheduled and unattended)");
  }
  steps.forEach((s, i) => {
    if (s.kind === "write") checkWrite(s, i, reportAt, steps);
  });
  const reportIndex = reportAt.size === 1 ? [...reportAt.values()][0] : undefined;
  if (reportIndex !== undefined && steps.slice(0, reportIndex).some((s) => s.kind === "write")) {
    // A skipped period ends the run saying nothing was posted; no write may run before the report.
    refuse("a write step cannot come before the report step");
  }
}
