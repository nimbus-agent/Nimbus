// Phase 7 (the Cost Pack, slice 3): cost report templates — a closed set of placeholders, no loops, no
// expressions, no includes (spec § 5). An unknown placeholder refuses the template when it is parsed.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
//
// Caps (builder, spec § 5): a body is at most `COST_REPORT_BODY_MAX[kind]` characters. When it is longer, the
// `{breakdown}` list shrinks first and then `{top_movers}`, each ending with "… and N more"; a body that still
// does not fit is REFUSED, never cut. A subject is one plain line of at most 255 characters.
import { COST_REPORT_SUBJECT_MAX } from "../config/cost-report-toml.ts";
import type { CostReportModel } from "./cost-report-model.ts";
import {
  breakdownCsvRows,
  breakdownItems,
  COST_REPORT_CSV_HEADER,
  type CostChannelKind,
  type CostRenderTarget,
  moverItems,
  scalarValues,
} from "./cost-template-values.ts";

export const COST_TEMPLATE_PLACEHOLDERS = [
  "report_name",
  "period_start",
  "period_end",
  "week_start",
  "total",
  "currency",
  "change",
  "change_pct",
  "top_movers",
  "breakdown",
  "unassigned",
  "unassigned_pct",
  "freshness",
  "command",
] as const;
export type CostTemplatePlaceholder = (typeof COST_TEMPLATE_PLACEHOLDERS)[number];

/** Body caps per channel kind (Slack's own limit is 40 000; the repo's update precedent is 12 000). */
export const COST_REPORT_BODY_MAX: Readonly<Record<CostChannelKind, number>> = {
  slack: 12_000,
  teams: 12_000,
  gmail: 100_000,
  outlook: 100_000,
};

/** Multi-line placeholders a one-line subject cannot hold. */
const NOT_IN_SUBJECT: readonly CostTemplatePlaceholder[] = ["top_movers", "breakdown", "freshness"];

export type CostTemplatePart = { readonly lit: string } | { readonly ph: CostTemplatePlaceholder };
export interface CostTemplate {
  readonly parts: readonly CostTemplatePart[];
}

export class CostTemplateError extends Error {
  override readonly name = "CostTemplateError";
}

const isPlaceholder = (n: string): n is CostTemplatePlaceholder =>
  (COST_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(n);

/** Parse a template. `{{` and `}}` are literal braces. Throws {@link CostTemplateError}. */
export function parseCostTemplate(text: string): CostTemplate {
  const parts: CostTemplatePart[] = [];
  let lit = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if ((c === "{" && next === "{") || (c === "}" && next === "}")) {
      lit += c;
      i += 2;
    } else if (c === "}") {
      throw new CostTemplateError(`a } with no { at character ${String(i + 1)}`);
    } else if (c === "{") {
      const end = text.indexOf("}", i + 1);
      const open = text.indexOf("{", i + 1);
      if (end === -1 || (open !== -1 && open < end)) {
        throw new CostTemplateError(`an unclosed { at character ${String(i + 1)}`);
      }
      const name = text.slice(i + 1, end);
      if (!isPlaceholder(name)) {
        const known = COST_TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");
        throw new CostTemplateError(`unknown placeholder {${name.slice(0, 64)}} (known: ${known})`);
      }
      if (lit !== "") parts.push({ lit });
      lit = "";
      parts.push({ ph: name });
      i = end + 1;
    } else {
      lit += c;
      i += 1;
    }
  }
  if (lit !== "") parts.push({ lit });
  return { parts };
}

export interface CostRenderOptions extends CostRenderTarget {
  readonly breakdown: "list" | "csv";
  readonly maxChars: number;
}

export interface CostRenderResult {
  readonly text: string;
  /** How many breakdown rows and movers were left out to fit the cap. */
  readonly truncated: { readonly breakdown: number; readonly topMovers: number };
}

/** A list in the channel's form, keeping the first `keep` items and stating how many were left out. */
function listText(items: readonly string[], keep: number, t: CostRenderTarget): string {
  const kept = items.slice(0, keep);
  const more = items.length - kept.length;
  if (kept.length === 0 && more === 0) return "none";
  const tail = more > 0 ? [`… and ${String(more)} more`] : [];
  if (t.format === "html")
    return `<ul>${[...kept, ...tail].map((x) => `<li>${x}</li>`).join("")}</ul>`;
  return [...kept.map((x) => `- ${x}`), ...tail].join("\n");
}

function csvText(rows: readonly string[], keep: number, t: CostRenderTarget): string {
  const kept = rows.slice(0, keep);
  const more = rows.length - kept.length;
  const body = [COST_REPORT_CSV_HEADER, ...kept].join("\n");
  const tail = more > 0 ? `\n… and ${String(more)} more rows` : "";
  if (t.format === "html") {
    const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<pre>${escaped}</pre>${tail}`;
  }
  if (t.kind === "slack" || t.kind === "teams") return `\`\`\`\n${body}\n\`\`\`${tail}`;
  return `${body}${tail}`;
}

interface Lists {
  readonly movers: readonly string[];
  readonly breakdown: readonly string[];
  readonly csv: readonly string[];
}

function assemble(
  t: CostTemplate,
  scalars: Readonly<Record<string, string>>,
  lists: Lists,
  keep: { breakdown: number; movers: number },
  o: CostRenderOptions,
): string {
  return t.parts
    .map((p) => {
      if ("lit" in p) return p.lit;
      if (p.ph === "top_movers") return listText(lists.movers, keep.movers, o);
      if (p.ph === "breakdown") {
        return o.breakdown === "csv"
          ? csvText(lists.csv, keep.breakdown, o)
          : listText(lists.breakdown, keep.breakdown, o);
      }
      return scalars[p.ph] ?? "";
    })
    .join("");
}

/** The largest `n` in [0, max] for which `fits(n)` holds, assuming `fits` is monotone; -1 when none. */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  if (!fits(0)) return -1;
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Render a body for one channel, shrinking the lists to fit its cap. Throws when it cannot fit. */
export function renderCostTemplate(
  t: CostTemplate,
  m: CostReportModel,
  o: CostRenderOptions,
): CostRenderResult {
  const scalars = scalarValues(m, o);
  const lists: Lists = {
    movers: moverItems(m, o),
    breakdown: breakdownItems(m, o),
    csv: breakdownCsvRows(m),
  };
  const rows = o.breakdown === "csv" ? lists.csv.length : lists.breakdown.length;
  const render = (breakdown: number, movers: number) =>
    assemble(t, scalars, lists, { breakdown, movers }, o);
  const fits = (s: string) => s.length <= o.maxChars;
  const full = render(rows, lists.movers.length);
  if (fits(full)) return { text: full, truncated: { breakdown: 0, topMovers: 0 } };
  const keepRows = largestFitting(rows, (n) => fits(render(n, lists.movers.length)));
  if (keepRows >= 0) {
    return {
      text: render(keepRows, lists.movers.length),
      truncated: { breakdown: rows - keepRows, topMovers: 0 },
    };
  }
  const keepMovers = largestFitting(lists.movers.length, (n) => fits(render(0, n)));
  if (keepMovers >= 0) {
    return {
      text: render(0, keepMovers),
      truncated: { breakdown: rows, topMovers: lists.movers.length - keepMovers },
    };
  }
  throw new CostTemplateError(
    `the rendered body is ${String(render(0, 0).length)} characters, over the ${String(o.maxChars)}-character cap for ${o.kind}, even with no breakdown or movers`,
  );
}

/** A mail subject: one plain line, at most 255 characters. Throws {@link CostTemplateError}. */
export function renderCostSubject(t: CostTemplate, m: CostReportModel): string {
  for (const p of t.parts) {
    if ("ph" in p && NOT_IN_SUBJECT.includes(p.ph)) {
      throw new CostTemplateError(`{${p.ph}} cannot be used in a subject`);
    }
  }
  const text = assemble(
    t,
    scalarValues(m, { kind: "gmail", format: "text" }),
    { movers: [], breakdown: [], csv: [] },
    { breakdown: 0, movers: 0 },
    { kind: "gmail", format: "text", breakdown: "list", maxChars: COST_REPORT_SUBJECT_MAX },
  );
  if (/[\r\n]/.test(text)) throw new CostTemplateError("the subject must be one line");
  if (text.length > COST_REPORT_SUBJECT_MAX) {
    throw new CostTemplateError(
      `the subject is ${String(text.length)} characters, over ${String(COST_REPORT_SUBJECT_MAX)} characters`,
    );
  }
  return text;
}
