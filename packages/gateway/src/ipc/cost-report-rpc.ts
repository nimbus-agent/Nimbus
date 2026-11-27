import { renderReportChannel } from "../automation/cost-report-render.ts";
import { machineTimeZone } from "../automation/cron.ts";
import type {
  CostReportChannelDef,
  CostReportDef,
  CostReportDestination,
} from "../config/cost-report-toml.ts";
import { buildCostReport, type CostReportModel } from "../finops/cost-report-model.ts";
import { reportPeriods } from "../finops/cost-report-period.ts";
import { CostTemplateFileError, readCostTemplateFile } from "../finops/cost-template-file.ts";
import { gatherCostViewInput } from "../finops/cost-view-input.ts";
import type { ChatopsPolicy } from "../policy/types.ts";
import {
  type CostViewsRpcCtx,
  CostViewsRpcError,
  config,
  params,
  requireOwner,
} from "./cost-views-rpc.ts";

/**
 * `cost.reportList` and `cost.reportRender` (Phase 7, the Cost Pack, slice 3): the configured
 * `[[cost.report]]` definitions, and a report rendered for each of its channels exactly as it would be posted.
 * Nothing is sent: delivery is a saved workflow (slice 4). Reads of the local index and the owner's template
 * files only — no network, no model, no egress row. Served only to a connection whose DECLARED kind is `cli`
 * or `ui`; the `cost` namespace is LAN-forbidden (I5) and neither is on the renderer allowlist (I7).
 *
 * Static rule D48 keeps `finops/` free of the connector door code, so the render (pure, in `finops/`) and the
 * door detectors meet here: the template's own literal text and every rendered body are run through the same
 * broadcast-mention and remote-content detectors the send door uses, and a finding is returned per channel as
 * `doorRefusal`. The send door still runs its full checks on the real input when a report is delivered.
 */

export interface CostReportListEntry {
  readonly name: string;
  readonly scope: CostReportDef["scope"];
  readonly period: string;
  readonly schedule: string | null;
  readonly tz: string | null;
  readonly channels: { readonly kind: string; readonly format: string }[];
}

export interface CostReportChannelRender {
  readonly kind: CostReportChannelDef["kind"];
  readonly format: CostReportChannelDef["format"];
  readonly to: CostReportDestination;
  readonly subject: string | null;
  /** The body as it would be posted, or null when `error` is set. */
  readonly body: string | null;
  readonly truncated: { readonly breakdown: number; readonly topMovers: number };
  /** A template or cap refusal: nothing could be rendered for this channel. */
  readonly error: string | null;
  /** What the send door would refuse in the template or the rendered body. */
  readonly doorRefusal: string | null;
}

export interface CostReportRenderResult {
  readonly model: CostReportModel;
  readonly channels: CostReportChannelRender[];
}

export function templateText(ch: CostReportChannelDef, configDir: string | undefined): string {
  if ("inline" in ch.template) return ch.template.inline;
  if (configDir === undefined)
    throw new CostTemplateFileError("no config directory to read template files from");
  return readCostTemplateFile(configDir, ch.template.file);
}

/** The enforced ChatOps policy, or undefined when it cannot be read (the door then refuses chat posts). */
export function readChatops(ctx: CostViewsRpcCtx): ChatopsPolicy | undefined {
  try {
    return ctx.chatops?.();
  } catch {
    return undefined;
  }
}

const NOT_TRUNCATED = { breakdown: 0, topMovers: 0 } as const;

/** One channel: the template text, then the shared render-then-check sequence (`automation/cost-report-render.ts`). */
function renderChannel(
  ch: CostReportChannelDef,
  model: CostReportModel,
  configDir: string | undefined,
  chatops: ChatopsPolicy | undefined,
): CostReportChannelRender {
  const base = { kind: ch.kind, format: ch.format, to: ch.to };
  let template: string;
  try {
    template = templateText(ch, configDir);
  } catch (e) {
    if (!(e instanceof CostTemplateFileError)) throw e;
    return {
      ...base,
      subject: null,
      body: null,
      truncated: NOT_TRUNCATED,
      error: e.message,
      doorRefusal: null,
    };
  }
  const out = renderReportChannel({ ...ch, template }, model, chatops);
  if (!out.ok) {
    return {
      ...base,
      subject: null,
      body: null,
      truncated: NOT_TRUNCATED,
      error: out.error,
      doorRefusal: out.doorRefusal,
    };
  }
  return {
    ...base,
    subject: out.subject,
    body: out.body,
    truncated: out.truncated,
    error: null,
    doorRefusal: out.doorRefusal,
  };
}

export function findReport(
  reports: readonly CostReportDef[],
  name: unknown,
  configError: string | null,
  method = "cost.reportRender",
): CostReportDef {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    throw new CostViewsRpcError(-32602, `${method}: name must be a report name`);
  }
  const def = reports.find((r) => r.name === name);
  if (def !== undefined) return def;
  const known = reports.length === 0 ? "none" : reports.map((r) => r.name).join(", ");
  const refused = configError === null ? "" : ` (the report config was refused: ${configError})`;
  throw new CostViewsRpcError(
    -32602,
    `${method}: no report named "${name}" (known: ${known})${refused}`,
  );
}

export function channelsOf(
  def: CostReportDef,
  channel: unknown,
  method = "cost.reportRender",
): readonly CostReportChannelDef[] {
  if (channel === undefined) return def.channels;
  const picked = def.channels.filter((c) => c.kind === channel);
  if (picked.length === 0) {
    const kinds = def.channels.map((c) => c.kind).join(", ") || "none";
    throw new CostViewsRpcError(
      -32602,
      `${method}: report "${def.name}" has no ${String(channel).slice(0, 16)} channel (it has: ${kinds})`,
    );
  }
  return picked;
}

export function handleCostReportList(
  raw: unknown,
  ctx: CostViewsRpcCtx,
): { reports: CostReportListEntry[]; configError: string | null } {
  requireOwner(ctx, "cost.reportList");
  params(raw, "cost.reportList", []);
  const cfg = config(ctx);
  return {
    reports: cfg.reports.map((r) => ({
      name: r.name,
      scope: r.scope,
      period: r.period,
      schedule: r.schedule,
      tz: r.tz,
      channels: r.channels.map((c) => ({ kind: c.kind, format: c.format })),
    })),
    configError: cfg.error ?? cfg.reportsError,
  };
}

export function handleCostReportRender(raw: unknown, ctx: CostViewsRpcCtx): CostReportRenderResult {
  requireOwner(ctx, "cost.reportRender");
  const p = params(raw ?? {}, "cost.reportRender", ["name", "channel"]);
  const cfg = config(ctx);
  const def = findReport(cfg.reports, p["name"], cfg.error ?? cfg.reportsError);
  const channels = channelsOf(def, p["channel"]);
  const model = reportModel(ctx, cfg, def, def.tz ?? machineTimeZone());
  const chatops = readChatops(ctx);
  return {
    model,
    channels: channels.map((ch) => renderChannel(ch, model, ctx.configDir, chatops)),
  };
}

/** The report over the local cost lines for its current period in zone `tz` (no network, no model). */
export function reportModel(
  ctx: CostViewsRpcCtx,
  cfg: ReturnType<typeof config>,
  def: CostReportDef,
  tz: string,
): CostReportModel {
  const nowMs = (ctx.now ?? Date.now)();
  const { range, previous, weekStart } = reportPeriods(def.period, tz, nowMs);
  // ONE gather over both periods, so one source rule applies to both (as `cost.why` does).
  const both = gatherCostViewInput(
    ctx.db,
    cfg,
    {
      fromDay: previous.fromDay,
      toDay: range.toDay,
      label: `${previous.label} and ${range.label}`,
    },
    nowMs,
  );
  return buildCostReport({
    lines: both.lines,
    rules: cfg.rules,
    configError: cfg.error,
    def,
    range,
    previous,
    weekStart,
    nowMs,
    lastDays: both.lastDays,
    empty: both.empty,
  });
}
