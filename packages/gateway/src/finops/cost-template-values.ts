// Phase 7 (the Cost Pack, slice 3): the values a cost report template substitutes, formatted and escaped for
// the channel they go to (spec, Resolved 9).
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
//
// Every substituted value is first stripped of control and format-invisible characters and capped at 128
// characters. Then, per channel:
// - `html` (Teams, Outlook): `& < > " '` HTML-escaped.
// - Slack (`text`, `markdown`): `& < >` as Slack's own entities, and `@ * _ ~` and the backtick swapped for
//   look-alikes, so a value can never mention, link or format (Slack's markup has no backslash escape).
// - Teams `text`/`markdown`: `< > &` and `@ * _ ~` and the backtick swapped for look-alikes.
// - Mail `text` (Gmail, Outlook): only stripped.
// The template's own literal text is the owner's and is never escaped.
import { FORMAT_INVISIBLE_RANGES, rangesRegExp } from "../util/invisible-text.ts";
import type { CostReportCurrency, CostReportModel } from "./cost-report-model.ts";

export type CostChannelKind = "slack" | "teams" | "gmail" | "outlook";
export type CostChannelFormat = "text" | "markdown" | "html";
export interface CostRenderTarget {
  readonly kind: CostChannelKind;
  readonly format: CostChannelFormat;
}

export const COST_TEMPLATE_VALUE_MAX = 128;

const INVISIBLE_RE = rangesRegExp(FORMAT_INVISIBLE_RANGES);
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const LOOKALIKE: Readonly<Record<string, string>> = {
  "@": "＠",
  "*": "∗",
  _: "＿",
  "~": "∼",
  "`": "ˋ",
  "<": "‹",
  ">": "›",
  "&": "＆",
};
const SLACK_ENTITY: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const HTML_ENTITY: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Strip control and invisible characters, then cap at 128 characters (by code point). */
export function cleanValue(v: string): string {
  const stripped = v.replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
  return Array.from(stripped).slice(0, COST_TEMPLATE_VALUE_MAX).join("");
}

/** One value, cleaned and escaped for its channel. */
export function escapeValue(v: string, t: CostRenderTarget): string {
  const s = cleanValue(v);
  if (t.format === "html") {
    const html = s.replace(/[&<>"']/g, (c) => HTML_ENTITY[c] ?? c);
    // A Teams html body still reads `@channel` as a mention.
    return t.kind === "teams" ? html.replaceAll("@", LOOKALIKE["@"] ?? "@") : html;
  }
  if (t.kind === "slack") {
    return s
      .replace(/[&<>]/g, (c) => SLACK_ENTITY[c] ?? c)
      .replace(/[@*_~`]/g, (c) => LOOKALIKE[c] ?? c);
  }
  if (t.kind === "teams") return s.replace(/[@*_~`<>&]/g, (c) => LOOKALIKE[c] ?? c);
  return s;
}

const money = (n: number, currency: string, t: CostRenderTarget): string =>
  `${n.toFixed(2)} ${escapeValue(currency, t)}`;
const signedMoney = (n: number, currency: string, t: CostRenderTarget): string =>
  `${n > 0 ? "+" : ""}${money(n, currency, t)}`;
const signedPct = (p: number | null): string =>
  p === null ? "new" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

/** One entry per currency of the model, in its (code-unit) order, joined `; `. */
function perCurrency(
  m: CostReportModel,
  f: (c: string, b: CostReportCurrency) => string,
  none: string,
): string {
  const parts = Object.entries(m.byCurrency).map(([c, b]) => f(c, b));
  return parts.length === 0 ? none : parts.join("; ");
}

/** The scalar placeholders (every one except the two lists). */
export function scalarValues(
  m: CostReportModel,
  t: CostRenderTarget,
): Readonly<Record<string, string>> {
  const provisional = m.provisionalFrom === null ? "" : ` (provisional from ${m.provisionalFrom})`;
  return {
    report_name: escapeValue(m.name, t),
    period_start: m.range.fromDay,
    period_end: m.range.toDay,
    week_start: m.weekStart ?? "",
    total: `${perCurrency(m, (c, b) => money(b.total, c, t), "0.00")}${provisional}`,
    currency: perCurrency(m, (c) => escapeValue(c, t), ""),
    change: perCurrency(m, (c, b) => signedMoney(b.change, c, t), "0.00"),
    change_pct: perCurrency(m, (_c, b) => signedPct(b.changePct), "new"),
    unassigned: perCurrency(m, (c, b) => money(b.unassigned, c, t), "0.00"),
    unassigned_pct: perCurrency(
      m,
      (_c, b) => (b.unassignedPct === null ? "n/a" : `${b.unassignedPct.toFixed(1)}%`),
      "n/a",
    ),
    freshness: freshnessText(m, t),
    command: escapeValue(m.command, t),
  };
}

function freshnessText(m: CostReportModel, t: CostRenderTarget): string {
  if (m.freshness.length === 0) return "no cost data";
  const lines = m.freshness.map((f) => {
    const prov = f.provisionalFrom === null ? "" : ` (provisional from ${f.provisionalFrom})`;
    return `${escapeValue(f.source, t)}: data up to ${f.lastDay ?? "none"}${prov}`;
  });
  return lines.join(t.format === "html" ? "<br>" : "\n");
}

/** The movers, one item per mover, across currencies in order. */
export function moverItems(m: CostReportModel, t: CostRenderTarget): string[] {
  return Object.entries(m.byCurrency).flatMap(([c, b]) =>
    b.topMovers.map((x) => {
      const who = x.service === null ? "" : `${escapeValue(x.service, t)} `;
      return `${who}${escapeValue(x.part, t)} (${escapeValue(x.provider, t)}): ${signedMoney(x.change, c, t)}`;
    }),
  );
}

/** The breakdown, one item per row, across currencies in order. */
export function breakdownItems(m: CostReportModel, t: CostRenderTarget): string[] {
  return Object.entries(m.byCurrency).flatMap(([c, b]) =>
    b.breakdown.map((r) => {
      const where =
        r.env === null
          ? escapeValue(r.provider, t)
          : `${escapeValue(r.provider, t)}, ${escapeValue(r.env, t)}`;
      return `${escapeValue(r.part, t)} (${where}): ${money(r.amount, c, t)}`;
    }),
  );
}

const CSV_FORMULA_RE = /^[=+\-@\t\r]/;
function csvCell(v: string): string {
  const s = cleanValue(v);
  const guarded = CSV_FORMULA_RE.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export const COST_REPORT_CSV_HEADER = "part,provider,env,currency,amount";

/** The breakdown as CSV rows (no header), formula-guarded. */
export function breakdownCsvRows(m: CostReportModel): string[] {
  return Object.entries(m.byCurrency).flatMap(([c, b]) =>
    b.breakdown.map((r) =>
      [
        csvCell(r.part),
        csvCell(r.provider),
        csvCell(r.env ?? ""),
        csvCell(c),
        r.amount.toFixed(2),
      ].join(","),
    ),
  );
}
