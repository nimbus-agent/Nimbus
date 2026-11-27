// `cost.reportSchedule` (Phase 7, the Cost Pack, slice 4): generates ONE scheduled workflow per channel of a
// `[[cost.report]]`, `cost-<report>-<kind>`, through the SAME save path as `workflow.save`
// (`saveWorkflowDefinition`, so static D50(c) is unchanged). Served only to a connection whose DECLARED kind
// is `cli` (the connection's kind, never a param); refused on a demo gateway (it has no scheduler, I41). The
// `cost` namespace is LAN-forbidden (I5) and not on the renderer allowlist (I7).
//
// Owner rulings 2026-11-27: (1) a report with no `tz` is frozen to the gateway's zone NOW, so a later machine
// zone change does not move it; (3) each channel is rendered once and run through the send door's checks
// (`renderReportChannel`: the template's literal text, then the full destination check on the rendered post);
// a channel the door would refuse is NOT generated, with the reason, and the report's other channels still
// are. Nothing is sent. Regenerating replaces a workflow in place (same id); a changed workflow has a new hash,
// so a standing rule for it stops matching until the owner approves it again.
import { renderReportChannel } from "../automation/cost-report-render.ts";
import {
  buildCostReportWorkflowSteps,
  COST_REPORT_DEFAULT_SCHEDULE,
  COST_REPORT_WRITE_STEP_NUMBER,
  costReportWorkflowName,
} from "../automation/cost-report-workflow.ts";
import { machineTimeZone } from "../automation/cron.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "../automation/workflow-steps.ts";
import { getWorkflowByName } from "../automation/workflow-store.ts";
import type { CostReportChannelDef } from "../config/cost-report-toml.ts";
import { CostTemplateFileError } from "../finops/cost-template-file.ts";
import { saveWorkflowDefinition } from "./automation-rpc.ts";
import {
  channelsOf,
  findReport,
  readChatops,
  reportModel,
  templateText,
} from "./cost-report-rpc.ts";
import { type CostViewsRpcCtx, CostViewsRpcError, config, params } from "./cost-views-rpc.ts";

const METHOD = "cost.reportSchedule";

export type ScheduledChannel =
  | {
      readonly kind: string;
      readonly workflow: string;
      /** `new`; `replaced` (the content changed: a standing rule must be approved again); `unchanged`. */
      readonly status: "new" | "replaced" | "unchanged";
      readonly schedule: string;
      readonly tz: string;
      /** The exact command that approves the generated write step as a standing rule. */
      readonly approve: string;
    }
  | {
      readonly kind: string;
      readonly workflow: string;
      readonly status: "skipped";
      readonly reason: string;
    };

export interface CostReportScheduleResult {
  readonly report: string;
  readonly channels: readonly ScheduledChannel[];
}

export interface CostReportScheduleCtx extends CostViewsRpcCtx {
  readonly demo?: boolean;
}

function requireCliOwner(ctx: CostReportScheduleCtx): void {
  if (ctx.caller?.kind !== "cli") {
    throw new CostViewsRpcError(
      -32000,
      `ERR_COST_FORBIDDEN_CLIENT: ${METHOD} is served only to the owner's terminal, on a connection that declared the cli kind`,
    );
  }
  if (ctx.demo === true) {
    throw new CostViewsRpcError(
      -32000,
      `ERR_COST_DEMO: ${METHOD} is not available on the demo gateway (it has no scheduler)`,
    );
  }
}

/** The stored content hash of a workflow, or null when it has none that parses. */
function storedHash(stepsJson: string): string | null {
  try {
    return workflowStepsSha256(parseWorkflowSteps(stepsJson));
  } catch {
    return null;
  }
}

/** The template text of one channel, or the reason it cannot be read. */
function readTemplate(
  ch: CostReportChannelDef,
  configDir: string | undefined,
): { text: string } | { reason: string } {
  try {
    return { text: templateText(ch, configDir) };
  } catch (e) {
    if (!(e instanceof CostTemplateFileError)) throw e;
    return { reason: e.message };
  }
}

export function handleCostReportSchedule(
  raw: unknown,
  ctx: CostReportScheduleCtx,
): CostReportScheduleResult {
  requireCliOwner(ctx);
  const p = params(raw ?? {}, METHOD, ["name", "channel"]);
  const cfg = config(ctx);
  const def = findReport(cfg.reports, p["name"], cfg.error ?? cfg.reportsError, METHOD);
  const channels = channelsOf(def, p["channel"], METHOD);
  const tz = def.tz ?? machineTimeZone(); // owner ruling 1: frozen at generation
  const schedule = def.schedule ?? COST_REPORT_DEFAULT_SCHEDULE;
  const model = reportModel(ctx, cfg, def, tz);
  const chatops = readChatops(ctx);
  const now = (ctx.now ?? Date.now)();
  const out: ScheduledChannel[] = [];
  for (const ch of channels) {
    const workflow = costReportWorkflowName(def.name, ch.kind);
    const skip = (reason: string): void => {
      out.push({ kind: ch.kind, workflow, status: "skipped", reason });
    };
    const template = readTemplate(ch, ctx.configDir);
    if ("reason" in template) {
      skip(template.reason);
      continue;
    }
    // Owner ruling 3: the send door's checks before anything is saved.
    const check = renderReportChannel({ ...ch, template: template.text }, model, chatops);
    if (check.doorRefusal !== null) {
      skip(`the send door would refuse it: ${check.doorRefusal}`);
      continue;
    }
    if (!check.ok) {
      skip(check.error);
      continue;
    }
    const stepsJson = JSON.stringify(buildCostReportWorkflowSteps(def, ch, template.text, tz));
    const before = getWorkflowByName(ctx.db, workflow);
    // The config and the step parser share their validators and the channel was rendered above, so a
    // save refusal here would be a disagreement between them: it is NOT a skip, it fails the call.
    saveWorkflowDefinition(ctx.db, {
      name: workflow,
      description: `Cost report ${def.name} to ${ch.kind} (generated by nimbus cost report schedule)`,
      stepsJson,
      schedule,
      scheduleTz: tz,
      clientKind: ctx.caller?.kind,
      now,
    });
    let status: "new" | "replaced" | "unchanged" = "new";
    if (before !== null) {
      const old = storedHash(before.steps_json);
      status = old !== null && old === storedHash(stepsJson) ? "unchanged" : "replaced";
    }
    out.push({
      kind: ch.kind,
      workflow,
      status,
      schedule,
      tz,
      approve: `nimbus approve add --workflow ${workflow} --step ${String(COST_REPORT_WRITE_STEP_NUMBER)}`,
    });
  }
  return { report: def.name, channels: out };
}
