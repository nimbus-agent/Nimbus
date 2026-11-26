import { machineTimeZone } from "../automation/cron.ts";
import type {
  CostReportChannelDef,
  CostReportDef,
  CostReportDestination,
} from "../config/cost-report-toml.ts";
import { costReportDoorRefusal } from "../connectors/connector-writes/cost-report-rows.ts";
import { broadcastMentionIn } from "../connectors/connector-writes/model-write-refusals.ts";
import { remoteContentIn } from "../connectors/connector-writes/remote-content.ts";
import { buildCostReport, type CostReportModel } from "../finops/cost-report-model.ts";
import { reportPeriods } from "../finops/cost-report-period.ts";
import {
  COST_REPORT_BODY_MAX,
  CostTemplateError,
  parseCostTemplate,
  renderCostSubject,
  renderCostTemplate,
} from "../finops/cost-template.ts";
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

const BROADCAST = "notifies a whole channel, group or team (a broadcast mention)";
const REMOTE =
  "loads remote content (an external image, embed, frame or stylesheet) when it is opened";

/** What the send door's detectors find in `text` for this channel, or null. */
function doorFinding(ch: CostReportChannelDef, text: string): string | null {
  const html = ch.format === "html";
  if ((ch.kind === "slack" || ch.kind === "teams") && broadcastMentionIn(ch.kind, text, { html }))
    return BROADCAST;
  if (html && ch.kind === "teams" && remoteContentIn("teams-html", text)) return REMOTE;
  if (html && ch.kind === "outlook" && remoteContentIn("outlook-html", text)) return REMOTE;
  return null;
}

function templateText(ch: CostReportChannelDef, configDir: string | undefined): string {
  if ("inline" in ch.template) return ch.template.inline;
  if (configDir === undefined)
    throw new CostTemplateFileError("no config directory to read template files from");
  return readCostTemplateFile(configDir, ch.template.file);
}

/** The enforced ChatOps policy, or undefined when it cannot be read (the door then refuses chat posts). */
function readChatops(ctx: CostViewsRpcCtx): ChatopsPolicy | undefined {
  try {
    return ctx.chatops?.();
  } catch {
    return undefined;
  }
}

const NOT_TRUNCATED = { breakdown: 0, topMovers: 0 } as const;

/** One channel: template → door check of the literal → body → subject → door check of the body. */
function renderChannel(
  ch: CostReportChannelDef,
  model: CostReportModel,
  configDir: string | undefined,
  chatops: ChatopsPolicy | undefined,
): CostReportChannelRender {
  const base = { kind: ch.kind, format: ch.format, to: ch.to };
  try {
    const text = templateText(ch, configDir);
    const literal = doorFinding(ch, text);
    if (literal !== null) {
      return {
        ...base,
        subject: null,
        body: null,
        truncated: NOT_TRUNCATED,
        error: null,
        doorRefusal: `the template ${literal}`,
      };
    }
    const out = renderCostTemplate(parseCostTemplate(text), model, {
      kind: ch.kind,
      format: ch.format,
      breakdown: ch.breakdown,
      maxChars: COST_REPORT_BODY_MAX[ch.kind],
    });
    const subject =
      ch.subject === null ? null : renderCostSubject(parseCostTemplate(ch.subject), model);
    // The send door's FULL destination check on the post as it would be made (ChatOps channel, broadcast
    // mention, remote content), through the row table's own module (static D20 keeps tool ids there).
    const doorRefusal = costReportDoorRefusal(
      { kind: ch.kind, to: ch.to, format: ch.format, body: out.text, subject },
      chatops,
    );
    return { ...base, subject, body: out.text, truncated: out.truncated, error: null, doorRefusal };
  } catch (e) {
    if (!(e instanceof CostTemplateError) && !(e instanceof CostTemplateFileError)) throw e;
    return {
      ...base,
      subject: null,
      body: null,
      truncated: NOT_TRUNCATED,
      error: e.message,
      doorRefusal: null,
    };
  }
}

function findReport(
  reports: readonly CostReportDef[],
  name: unknown,
  configError: string | null,
): CostReportDef {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    throw new CostViewsRpcError(-32602, "cost.reportRender: name must be a report name");
  }
  const def = reports.find((r) => r.name === name);
  if (def !== undefined) return def;
  const known = reports.length === 0 ? "none" : reports.map((r) => r.name).join(", ");
  const refused = configError === null ? "" : ` (the [cost] config was refused: ${configError})`;
  throw new CostViewsRpcError(
    -32602,
    `cost.reportRender: no report named "${name}" (known: ${known})${refused}`,
  );
}

function channelsOf(def: CostReportDef, channel: unknown): readonly CostReportChannelDef[] {
  if (channel === undefined) return def.channels;
  const picked = def.channels.filter((c) => c.kind === channel);
  if (picked.length === 0) {
    const kinds = def.channels.map((c) => c.kind).join(", ") || "none";
    throw new CostViewsRpcError(
      -32602,
      `cost.reportRender: report "${def.name}" has no ${String(channel).slice(0, 16)} channel (it has: ${kinds})`,
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
    configError: cfg.error,
  };
}

export function handleCostReportRender(raw: unknown, ctx: CostViewsRpcCtx): CostReportRenderResult {
  requireOwner(ctx, "cost.reportRender");
  const p = params(raw ?? {}, "cost.reportRender", ["name", "channel"]);
  const cfg = config(ctx);
  const def = findReport(cfg.reports, p["name"], cfg.error);
  const channels = channelsOf(def, p["channel"]);
  const nowMs = (ctx.now ?? Date.now)();
  const { range, previous, weekStart } = reportPeriods(
    def.period,
    def.tz ?? machineTimeZone(),
    nowMs,
  );
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
    empty: both.empty,
  });
  const chatops = readChatops(ctx);
  return {
    model,
    channels: channels.map((ch) => renderChannel(ch, model, ctx.configDir, chatops)),
  };
}
