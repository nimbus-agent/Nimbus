// Phase 7 (the Cost Pack): ONE render-then-check sequence for a cost report channel, used by the preview
// (`cost.reportRender`, slice 3), the workflow generator (`nimbus cost report schedule`) and the `report` step
// of a scheduled run (slice 4). It lives outside `finops/` because static rule D48 keeps `finops/` free of the
// connector door code, and outside `ipc/` so the runner can use it.
//
// Order: the send door's detectors on the template's own literal text; the render (pure, `finops/`); the
// subject; then the door's FULL destination check on the post as it would be made (`costReportDoorRefusal`:
// ChatOps channel, broadcast mention, remote content). No tool id is named here (static D20).
import type {
  CostReportDestination,
  CostReportFormat,
  CostReportKind,
} from "../config/cost-report-toml.ts";
import { costReportDoorRefusal } from "../connectors/connector-writes/cost-report-rows.ts";
import { broadcastMentionIn } from "../connectors/connector-writes/model-write-refusals.ts";
import { remoteContentIn } from "../connectors/connector-writes/remote-content.ts";
import type { CostReportModel } from "../finops/cost-report-model.ts";
import {
  COST_REPORT_BODY_MAX,
  CostTemplateError,
  parseCostTemplate,
  renderCostSubject,
  renderCostTemplate,
} from "../finops/cost-template.ts";
import type { ChatopsPolicy } from "../policy/types.ts";

/** What a channel renders: its kind, format, breakdown mode and the template and subject TEXT. */
export interface ReportChannelSpec {
  readonly kind: CostReportKind;
  readonly format: CostReportFormat;
  readonly breakdown: "list" | "csv";
  readonly template: string;
  readonly subject: string | null;
}

export interface ReportText {
  readonly body: string;
  readonly subject: string | null;
  readonly truncated: { readonly breakdown: number; readonly topMovers: number };
}

const BROADCAST = "notifies a whole channel, group or team (a broadcast mention)";
const REMOTE =
  "loads remote content (an external image, embed, frame or stylesheet) when it is opened";

/** What the send door's detectors find in `text` for this channel kind and format, or null. */
export function templateDoorFinding(
  ch: { readonly kind: CostReportKind; readonly format: CostReportFormat },
  text: string,
): string | null {
  const html = ch.format === "html";
  if ((ch.kind === "slack" || ch.kind === "teams") && broadcastMentionIn(ch.kind, text, { html }))
    return BROADCAST;
  if (html && ch.kind === "teams" && remoteContentIn("teams-html", text)) return REMOTE;
  if (html && ch.kind === "outlook" && remoteContentIn("outlook-html", text)) return REMOTE;
  return null;
}

/** The body and subject of one channel. Throws {@link CostTemplateError} for a template or cap refusal. */
export function renderReportText(spec: ReportChannelSpec, model: CostReportModel): ReportText {
  const out = renderCostTemplate(parseCostTemplate(spec.template), model, {
    kind: spec.kind,
    format: spec.format,
    breakdown: spec.breakdown,
    maxChars: COST_REPORT_BODY_MAX[spec.kind],
  });
  const subject =
    spec.subject === null ? null : renderCostSubject(parseCostTemplate(spec.subject), model);
  return { body: out.text, subject, truncated: out.truncated };
}

export type ReportChannelOutcome =
  | ({ readonly ok: true; readonly doorRefusal: string | null } & ReportText)
  | { readonly ok: false; readonly error: string | null; readonly doorRefusal: string | null };

/** The full sequence for one channel and its destination. A template or cap refusal is `error`. */
export function renderReportChannel(
  spec: ReportChannelSpec & { readonly to: CostReportDestination },
  model: CostReportModel,
  chatops: ChatopsPolicy | undefined,
): ReportChannelOutcome {
  const literal = templateDoorFinding(spec, spec.template);
  if (literal !== null) return { ok: false, error: null, doorRefusal: `the template ${literal}` };
  try {
    const text = renderReportText(spec, model);
    const doorRefusal = costReportDoorRefusal(
      { kind: spec.kind, to: spec.to, format: spec.format, body: text.body, subject: text.subject },
      chatops,
    );
    return { ok: true, doorRefusal, ...text };
  } catch (e) {
    if (!(e instanceof CostTemplateError)) throw e;
    return { ok: false, error: e.message, doorRefusal: null };
  }
}
