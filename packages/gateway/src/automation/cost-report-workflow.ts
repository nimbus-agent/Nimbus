// Phase 7 (the Cost Pack, slice 4): the workflow `nimbus cost report schedule` saves for ONE channel of a
// `[[cost.report]]` (spec Resolved 8): `cost-<report>-<kind>`, step 1 the `report` step with every value
// EMBEDDED (the template TEXT, read once here; the zone frozen, owner ruling 1), step 2 the channel's write.
// The write's destination and routing fields (channel, team, `to`, `contentType`) are constants; only the
// body and a draft's subject come from the report step (`REPORT_BODY_FIELDS`). Pure: no I/O, no tool id named
// here (static D20: the row and its fields come from `cost-report-rows.ts`).
import type { CostReportChannelDef, CostReportDef } from "../config/cost-report-toml.ts";
import {
  costReportPostInput,
  costReportToolFor,
  REPORT_BODY_FIELDS,
} from "../connectors/connector-writes/cost-report-rows.ts";

/** The weekly default when a report names no schedule: Mondays at 08:00 in the report's zone. */
export const COST_REPORT_DEFAULT_SCHEDULE = "0 8 * * 1";

/** The labels of the two generated steps; the write is step 2 (1-based, as `nimbus approve add --step`). */
export const COST_REPORT_STEP_LABELS = { report: "render", write: "post" } as const;
export const COST_REPORT_WRITE_STEP_NUMBER = 2;

export const costReportWorkflowName = (report: string, kind: string): string =>
  `cost-${report}-${kind}`;

/** The steps of the generated workflow for one channel, with its template text and the frozen zone. */
export function buildCostReportWorkflowSteps(
  def: CostReportDef,
  ch: CostReportChannelDef,
  template: string,
  tz: string,
): unknown[] {
  const tool = costReportToolFor(ch.kind);
  const fields = REPORT_BODY_FIELDS[tool];
  if (fields === undefined) throw new Error(`no report body fields for ${ch.kind}`);
  const label = COST_REPORT_STEP_LABELS.report;
  // The input exactly as the door would see it, with the body and subject left to the report step.
  const sample = costReportPostInput({
    kind: ch.kind,
    to: ch.to,
    format: ch.format,
    body: "",
    subject: ch.subject === null ? null : "",
  });
  const input: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(sample)) {
    if (field === fields.body) input[field] = { report: label, part: "body" };
    else if (fields.subject !== null && field === fields.subject) {
      input[field] = { report: label, part: "subject" };
    } else input[field] = { const: value };
  }
  return [
    {
      kind: "report",
      label,
      report: {
        name: def.name,
        scope: def.scope,
        period: def.period,
        tz,
        kind: ch.kind,
        format: ch.format,
        breakdown: ch.breakdown,
        template,
        subject: ch.subject,
      },
    },
    { kind: "write", label: COST_REPORT_STEP_LABELS.write, tool, input },
  ];
}
