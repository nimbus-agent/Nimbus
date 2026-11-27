/**
 * Phase 7 (the Cost Pack, slice 3): report definitions in the cost config.
 *
 * ```toml
 * [[cost.report]]
 * name = "checkout-weekly"
 * scope = { product = "checkout" }       # any of product, env, service, provider; all given must match
 * period = "week"                        # week | month | <N>d (1 to 400)
 * schedule = "0 8 * * 1"               # optional; delivered by a saved workflow (slice 4)
 * tz = "Europe/Berlin"                   # optional; default the gateway zone
 *
 * [[cost.report.channel]]
 * report = "checkout-weekly"
 * kind = "slack"                         # slack | teams | gmail | outlook
 * to = "C0123ABC"                        # slack: channel id; teams: { team, channel }; gmail/outlook: address(es)
 * format = "markdown"                    # slack: text|markdown; teams: text|markdown|html; gmail: text; outlook: text|html
 * template = "Checkout: {total} ({change})"   # or template_file = "x.md" in <configDir>/cost-templates/
 * # subject = "..."                      # gmail/outlook only, required, one line
 * ```
 *
 * Channels are their own array (not a sub-table of a report): the layered reader does not keep a sub-table
 * with its array element, and two arrays let a role pack ship reports while the owner adds channels in their
 * own layer. Pure: tables in, definitions out; any problem throws {@link CostReportConfigError}, and the
 * caller refuses the whole cost config with it.
 */
import { isValidTimeZone, machineTimeZone, scheduleRefusal } from "../automation/cron.ts";
import { COST_SET_VALUE_RE } from "../finops/cost-rules.ts";

export const COST_MAX_REPORTS = 50;
export const COST_MAX_REPORT_CHANNELS = 200;
export const COST_REPORT_MAX_ADDRESSES = 50;
export const COST_REPORT_SUBJECT_MAX = 255;
/** An inline template is capped like a template file. */
export const COST_REPORT_TEMPLATE_MAX_CHARS = 64 * 1024;
const COST_PERIOD_DAYS_MAX = 400;

export const COST_REPORT_SCOPE_KEYS = ["product", "env", "service", "provider"] as const;
export type CostReportScopeKey = (typeof COST_REPORT_SCOPE_KEYS)[number];
export type CostReportScope = Partial<Record<CostReportScopeKey, string>>;

export const COST_REPORT_KINDS = ["slack", "teams", "gmail", "outlook"] as const;
export type CostReportKind = (typeof COST_REPORT_KINDS)[number];
export type CostReportFormat = "text" | "markdown" | "html";

/** The formats each kind supports: the Gmail draft row takes plain text only. */
export const COST_REPORT_FORMATS: Readonly<Record<CostReportKind, readonly CostReportFormat[]>> = {
  slack: ["text", "markdown"],
  teams: ["text", "markdown", "html"],
  gmail: ["text"],
  outlook: ["text", "html"],
};

export type CostReportDestination =
  | string
  | { readonly team: string; readonly channel: string }
  | readonly string[];

export interface CostReportChannelDef {
  readonly kind: CostReportKind;
  readonly to: CostReportDestination;
  readonly format: CostReportFormat;
  readonly breakdown: "list" | "csv";
  readonly template: { readonly inline: string } | { readonly file: string };
  readonly subject: string | null;
}

export interface CostReportDef {
  readonly name: string;
  readonly scope: CostReportScope;
  readonly period: string;
  readonly schedule: string | null;
  readonly tz: string | null;
  readonly channels: readonly CostReportChannelDef[];
}

export class CostReportConfigError extends Error {
  override readonly name = "CostReportConfigError";
}

const REPORT_KEYS = ["name", "scope", "period", "schedule", "tz"];
const CHANNEL_KEYS = [
  "report",
  "kind",
  "to",
  "format",
  "breakdown",
  "template",
  "template_file",
  "subject",
];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PERIOD_RE = /^(?:week|month|(\d{1,3})d)$/;
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,31}$/;
const ADDRESS_RE = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;
const TEMPLATE_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** A `template_file` value: a plain file name (no path, no `..`, not hidden), read from `cost-templates/`. */
export function isCostTemplateFileName(name: string): boolean {
  return TEMPLATE_FILE_RE.test(name) && !name.includes("..");
}
// Control characters other than TAB and LF; a template is the owner's own literal text otherwise.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters.
export const TEMPLATE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters.
const SUBJECT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function only(t: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(t)) {
    if (!allowed.includes(k)) throw new CostReportConfigError(`${what}: unknown key "${k}"`);
  }
}

function isTable(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionalString(t: Record<string, unknown>, key: string, what: string): string | null {
  const v = t[key];
  if (v === undefined) return null;
  if (typeof v !== "string" || v.length === 0 || v.length > 256) {
    throw new CostReportConfigError(`${what}: ${key} must be a string of 1 to 256 characters`);
  }
  return v;
}

// ---- reports -------------------------------------------------------------------------------------

export function readScope(v: unknown, what: string): CostReportScope {
  const keys = COST_REPORT_SCOPE_KEYS.join(", ");
  if (!isTable(v) || Object.keys(v).length === 0) {
    throw new CostReportConfigError(`${what}: scope must name at least one of ${keys}`);
  }
  const out: CostReportScope = {};
  for (const [k, value] of Object.entries(v)) {
    if (!(COST_REPORT_SCOPE_KEYS as readonly string[]).includes(k)) {
      throw new CostReportConfigError(`${what}: unknown scope key "${k}" (known: ${keys})`);
    }
    if (typeof value !== "string" || !COST_SET_VALUE_RE.test(value)) {
      throw new CostReportConfigError(
        `${what}: scope.${k} must be a name (letters, digits and . _ : / @ + -, 1 to 64)`,
      );
    }
    out[k as CostReportScopeKey] = value;
  }
  return out;
}

export function readPeriod(v: unknown, what: string): string {
  const m = typeof v === "string" ? PERIOD_RE.exec(v) : null;
  const days = m?.[1] === undefined ? null : Number(m[1]);
  if (m === null || (days !== null && (days < 1 || days > COST_PERIOD_DAYS_MAX))) {
    throw new CostReportConfigError(
      `${what}: period must be week, month or <N>d (1 to ${String(COST_PERIOD_DAYS_MAX)})`,
    );
  }
  return v as string;
}

function readZoneAndSchedule(
  t: Record<string, unknown>,
  what: string,
): { tz: string | null; schedule: string | null } {
  const tz = optionalString(t, "tz", what);
  if (tz !== null && !isValidTimeZone(tz)) {
    throw new CostReportConfigError(`${what}: tz must be an IANA time zone such as Europe/Berlin`);
  }
  const schedule = optionalString(t, "schedule", what);
  if (schedule !== null) {
    const refusal = scheduleRefusal(schedule, tz ?? machineTimeZone());
    if (refusal !== undefined) throw new CostReportConfigError(`${what}: schedule: ${refusal}`);
  }
  return { tz, schedule };
}

function readReport(
  t: Record<string, unknown>,
  i: number,
  seen: Set<string>,
): Omit<CostReportDef, "channels"> {
  const what = `[[cost.report]] ${String(i + 1)}`;
  only(t, REPORT_KEYS, what);
  const name = t["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new CostReportConfigError(
      `${what}: name must be lowercase letters, digits and -, 1 to 64, starting with a letter or digit`,
    );
  }
  if (seen.has(name))
    throw new CostReportConfigError(`${what}: the name "${name}" is already used`);
  seen.add(name);
  const { tz, schedule } = readZoneAndSchedule(t, what);
  return {
    name,
    scope: readScope(t["scope"], what),
    period: readPeriod(t["period"], what),
    schedule,
    tz,
  };
}

// ---- channels ------------------------------------------------------------------------------------

export function readKind(v: unknown, what: string): CostReportKind {
  if (typeof v !== "string" || !(COST_REPORT_KINDS as readonly string[]).includes(v)) {
    throw new CostReportConfigError(`${what}: kind must be one of ${COST_REPORT_KINDS.join(", ")}`);
  }
  return v as CostReportKind;
}

function readAddresses(v: unknown, what: string): readonly string[] {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length < 1 || list.length > COST_REPORT_MAX_ADDRESSES) {
    throw new CostReportConfigError(
      `${what}: to must be 1 to ${String(COST_REPORT_MAX_ADDRESSES)} email addresses`,
    );
  }
  for (const a of list) {
    if (typeof a !== "string" || a.length > 254 || !ADDRESS_RE.test(a)) {
      throw new CostReportConfigError(`${what}: to holds something that is not an email address`);
    }
  }
  return Object.freeze([...(list as string[])]);
}

function readTeamsTarget(v: unknown, what: string): { team: string; channel: string } {
  const ok = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 256;
  if (!isTable(v) || !ok(v["team"]) || !ok(v["channel"]) || Object.keys(v).length !== 2) {
    throw new CostReportConfigError(`${what}: to must be { team, channel } for teams`);
  }
  return { team: v["team"], channel: v["channel"] };
}

function readDestination(kind: CostReportKind, v: unknown, what: string): CostReportDestination {
  if (kind === "teams") return readTeamsTarget(v, what);
  if (kind === "gmail" || kind === "outlook") return readAddresses(v, what);
  if (typeof v !== "string" || !SLACK_CHANNEL_RE.test(v)) {
    throw new CostReportConfigError(`${what}: to must be a Slack channel id such as C0123ABC`);
  }
  return v;
}

export function readFormat(kind: CostReportKind, v: unknown, what: string): CostReportFormat {
  const allowed = COST_REPORT_FORMATS[kind];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new CostReportConfigError(
      `${what}: format ${String(v)} is not available for ${kind} (use ${allowed.join(" or ")})`,
    );
  }
  return v as CostReportFormat;
}

function readTemplate(t: Record<string, unknown>, what: string): CostReportChannelDef["template"] {
  const inline = t["template"];
  const file = t["template_file"];
  if ((inline === undefined) === (file === undefined)) {
    throw new CostReportConfigError(`${what}: set exactly one of template or template_file`);
  }
  if (file !== undefined) {
    if (typeof file !== "string" || !isCostTemplateFileName(file)) {
      throw new CostReportConfigError(
        `${what}: template_file must be a plain file name in cost-templates/ (letters, digits, . _ -; no path)`,
      );
    }
    return { file };
  }
  return { inline: readInlineTemplate(inline, what) };
}

/** An inline template's text: 1 to 65 536 characters, no control character but TAB and LF. */
export function readInlineTemplate(inline: unknown, what: string): string {
  if (
    typeof inline !== "string" ||
    inline.length === 0 ||
    inline.length > COST_REPORT_TEMPLATE_MAX_CHARS
  ) {
    throw new CostReportConfigError(`${what}: template must be a string of 1 to 65536 characters`);
  }
  if (TEMPLATE_CONTROL_RE.test(inline)) {
    throw new CostReportConfigError(`${what}: template holds a control character`);
  }
  return inline;
}

/** A report name: lowercase letters, digits and `-`, 1 to 64, starting with a letter or digit. */
export const isCostReportName = (v: unknown): v is string =>
  typeof v === "string" && NAME_RE.test(v);

export function readSubject(kind: CostReportKind, v: unknown, what: string): string | null {
  const isMail = kind === "gmail" || kind === "outlook";
  if (!isMail) {
    if (v !== undefined)
      throw new CostReportConfigError(`${what}: subject is only for gmail and outlook`);
    return null;
  }
  if (v === undefined) throw new CostReportConfigError(`${what}: subject is required for ${kind}`);
  if (typeof v !== "string" || v.length === 0 || v.length > COST_REPORT_SUBJECT_MAX) {
    throw new CostReportConfigError(
      `${what}: subject must be a string of 1 to ${String(COST_REPORT_SUBJECT_MAX)} characters`,
    );
  }
  // A line break in a mail subject would be a header injection.
  if (SUBJECT_CONTROL_RE.test(v)) {
    throw new CostReportConfigError(`${what}: subject must be one line with no control characters`);
  }
  return v;
}

export function readBreakdown(v: unknown, what: string): "list" | "csv" {
  if (v === undefined) return "list";
  if (v !== "list" && v !== "csv")
    throw new CostReportConfigError(`${what}: breakdown must be list or csv`);
  return v;
}

function readChannel(
  t: Record<string, unknown>,
  i: number,
): { report: unknown; channel: CostReportChannelDef } {
  const what = `[[cost.report.channel]] ${String(i + 1)}`;
  only(t, CHANNEL_KEYS, what);
  const kind = readKind(t["kind"], what);
  const channel: CostReportChannelDef = {
    kind,
    to: readDestination(kind, t["to"], what),
    format: readFormat(kind, t["format"], what),
    breakdown: readBreakdown(t["breakdown"], what),
    template: readTemplate(t, what),
    subject: readSubject(kind, t["subject"], what),
  };
  return { report: t["report"], channel };
}

/** Attach each channel to its report; a channel naming no report, or a second of one kind, is refused. */
function attachChannels(
  reports: readonly Omit<CostReportDef, "channels">[],
  channelTables: readonly Record<string, unknown>[],
): Map<string, CostReportChannelDef[]> {
  const byReport = new Map<string, CostReportChannelDef[]>(reports.map((r) => [r.name, []]));
  channelTables.forEach((t, i) => {
    const { report, channel } = readChannel(t, i);
    const what = `[[cost.report.channel]] ${String(i + 1)}`;
    const list = typeof report === "string" ? byReport.get(report) : undefined;
    if (list === undefined) {
      throw new CostReportConfigError(`${what}: no [[cost.report]] is named "${String(report)}"`);
    }
    if (list.some((c) => c.kind === channel.kind)) {
      throw new CostReportConfigError(
        `${what}: report "${String(report)}" already has a ${channel.kind} channel`,
      );
    }
    list.push(channel);
  });
  return byReport;
}

/** The report definitions from the parsed `[[cost.report]]` and `[[cost.report.channel]]` tables. */
export function compileCostReports(
  reportTables: readonly Record<string, unknown>[],
  channelTables: readonly Record<string, unknown>[],
): readonly CostReportDef[] {
  if (reportTables.length > COST_MAX_REPORTS) {
    throw new CostReportConfigError(`at most ${String(COST_MAX_REPORTS)} [[cost.report]] blocks`);
  }
  if (channelTables.length > COST_MAX_REPORT_CHANNELS) {
    throw new CostReportConfigError(
      `at most ${String(COST_MAX_REPORT_CHANNELS)} [[cost.report.channel]] blocks`,
    );
  }
  const seen = new Set<string>();
  const reports = reportTables.map((t, i) => readReport(t, i, seen));
  const byReport = attachChannels(reports, channelTables);
  return Object.freeze(
    reports.map((r) =>
      Object.freeze({ ...r, channels: Object.freeze(byReport.get(r.name) ?? []) }),
    ),
  );
}
