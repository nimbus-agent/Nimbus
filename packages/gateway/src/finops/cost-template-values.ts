// Phase 7 (the Cost Pack, slice 3): the values a cost report template substitutes, formatted and escaped for
// the channel they go to (spec, Resolved 9).
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
//
// Every substituted value is first NFKC-normalised, stripped of control and format-invisible characters and
// capped at 128 characters. Then, per channel:
// - Slack, Teams and every `html` body: `< > & @` become `‹ › ⅋ (at)` — stand-ins the send door's detectors do
//   not decode or fold back — so a value can never open a tag, form an entity, mention or load content.
// - Chat (`text`, `markdown`): `* _ ~ [ ]` and the backtick also become look-alikes (no backslash escape
//   exists), so a value cannot format text or form a `[label](url)` link.
// - `html`: `" '` are entity-escaped, and `= ( )` become `꞊ ❨ ❩` (the remote-content detector reads
//   `src=http…` and `url(…)` even outside a tag).
// - Mail `text` (Gmail, Outlook): only stripped; the door does not scan it.
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

/**
 * Characters a value could use to mention, link, load or format, and their inert stand-ins. The stand-ins are
 * stable under NFKC and are not entities, because the send door's detectors decode entities and fold
 * look-alikes before they scan (`＠` folds back to `@`, `&lt;` decodes to `<`), so an escape the detectors
 * undo would be refused at the door.
 */
const INERT: Readonly<Record<string, string>> = { "<": "‹", ">": "›", "&": "⅋", "@": "(at)" };
/** Markup characters in chat (Slack mrkdwn, Teams markdown), which have no backslash escape. */
const CHAT_MARKUP: Readonly<Record<string, string>> = {
  "*": "∗",
  _: "＿",
  "~": "∼",
  "`": "ˋ",
  // A `[label](url)` value would render as a link with a label of its own choosing.
  "[": "［",
  "]": "］",
};
/**
 * In html, quotes are entity-escaped, and `=` and parentheses get NFKC-stable stand-ins: the remote-content
 * detector refuses attribute-like `src=http…` and CSS `url(…)` text even outside a tag.
 */
const HTML_INERT: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "'": "&#39;",
  "=": "꞊",
  "(": "❨",
  ")": "❩",
};

/** Make a cleaned value inert for a chat or html channel (mail `text` is left as is). */
function inert(s: string, t: CostRenderTarget): string {
  if (t.format !== "html" && t.kind !== "slack" && t.kind !== "teams") return s;
  const base = s.replace(/[<>&@]/g, (c) => INERT[c] ?? c);
  if (t.format === "html") return base.replace(/["'=()]/g, (c) => HTML_INERT[c] ?? c);
  return base.replace(/[*_~`[\]]/g, (c) => CHAT_MARKUP[c] ?? c);
}

/**
 * NFKC-normalise (so a full-width `＠` or `＜` becomes the ASCII character the stand-ins below then replace,
 * exactly as the send door's detectors would fold it), strip control and invisible characters, then cap at
 * 128 characters (by code point).
 */
export function cleanValue(v: string): string {
  const stripped = v.normalize("NFKC").replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
  return Array.from(stripped).slice(0, COST_TEMPLATE_VALUE_MAX).join("");
}

/** One value, cleaned and made inert for its channel. */
export function escapeValue(v: string, t: CostRenderTarget): string {
  return inert(cleanValue(v), t);
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
function csvCell(v: string, t: CostRenderTarget): string {
  const s = inert(cleanValue(v), t);
  const guarded = CSV_FORMULA_RE.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export const COST_REPORT_CSV_HEADER = "part,provider,env,currency,amount";

/** The breakdown as CSV rows (no header), formula-guarded and inert for the channel. */
export function breakdownCsvRows(m: CostReportModel, t: CostRenderTarget): string[] {
  return Object.entries(m.byCurrency).flatMap(([c, b]) =>
    b.breakdown.map((r) =>
      [
        csvCell(r.part, t),
        csvCell(r.provider, t),
        csvCell(r.env ?? "", t),
        csvCell(c, t),
        r.amount.toFixed(2),
      ].join(","),
    ),
  );
}
