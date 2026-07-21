import {
  MAX_CITATIONS_PER_ITEM,
  MAX_CONFLICTS,
  MAX_FINDINGS,
  MAX_ITEM_TEXT_CHARS,
  MAX_SUMMARY_CHARS,
} from "./brief-constants.ts";
import type { Report, ReportItem, SourceRef, SourceRegistry } from "./brief-types.ts";
import { verifyQuote } from "./quote-verify.ts";

export class SynthesisParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesisParseError";
  }
}

export type ModelItem = {
  text: string;
  refs: string[];
  /** ref token -> the model's claimed supporting quote. */
  quotes?: Record<string, string>;
};

export type ModelReport = {
  summary: string;
  findings: ModelItem[];
  conflicts: ModelItem[];
  gaps: string[];
};

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new SynthesisParseError("expected a JSON object");
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string") throw new SynthesisParseError(`${what} must be a string`);
  return v;
}

function asStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new SynthesisParseError(`${what} must be an array`);
  return v.map((e, i) => asString(e, `${what}[${i}]`));
}

function asQuotes(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const rec = asRecord(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function asItems(v: unknown, what: string): ModelItem[] {
  if (!Array.isArray(v)) throw new SynthesisParseError(`${what} must be an array`);
  return v.map((raw, i) => {
    const rec = asRecord(raw);
    const quotes = asQuotes(rec["quotes"]);
    return {
      text: asString(rec["text"], `${what}[${i}].text`),
      refs: asStringArray(rec["refs"], `${what}[${i}].refs`),
      ...(quotes === undefined ? {} : { quotes }),
    };
  });
}

/** Strips a ``` fence if the model wrapped its JSON in one. */
function unfence(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("```")) return t;
  const firstNewline = t.indexOf("\n");
  const closing = t.lastIndexOf("```");
  if (firstNewline < 0 || closing <= firstNewline) return t;
  return t.slice(firstNewline + 1, closing).trim();
}

export function parseModelJson(raw: string): ModelReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    throw new SynthesisParseError("model output is not valid JSON");
  }
  const rec = asRecord(parsed);
  return {
    summary: asString(rec["summary"], "summary"),
    findings: asItems(rec["findings"], "findings"),
    conflicts: asItems(rec["conflicts"], "conflicts"),
    gaps: asStringArray(rec["gaps"] ?? [], "gaps"),
  };
}

/** Result of resolving one model item against the registry. */
type ResolvedItem = {
  readonly item: ReportItem;
  /** True when refs resolved past MAX_CITATIONS_PER_ITEM and were cut off. */
  readonly citationsTruncated: boolean;
};

/**
 * Resolves an item's refs against the registry. Unknown tokens vanish; a quote
 * that cannot be verified against the cited body is dropped while its citation
 * survives. Returns null when nothing resolved. `citationsTruncated` is true
 * when more than MAX_CITATIONS_PER_ITEM distinct refs resolved, so the caller
 * can report the bound rather than let it pass silently.
 */
function resolveItem(item: ModelItem, registry: SourceRegistry): ResolvedItem | null {
  const citations: SourceRef[] = [];
  const seen = new Set<string>();
  let citationsTruncated = false;
  for (const token of item.refs) {
    if (seen.has(token)) continue;
    const entry = registry.get(token);
    if (entry === undefined) continue;
    seen.add(token);
    if (citations.length >= MAX_CITATIONS_PER_ITEM) {
      citationsTruncated = true;
      break;
    }
    const claimed = item.quotes?.[token];
    const verified = claimed === undefined ? null : verifyQuote(entry.body, claimed);
    citations.push({
      ...entry.ref,
      ...(verified === null ? {} : { quote: verified }),
    });
  }
  if (citations.length === 0) return null;
  return { item: { text: item.text, citations }, citationsTruncated };
}

/** Truncates `text` to `max` chars, reporting whether it cut anything. */
function capChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * Turns raw model output into a report that cannot contain a claim the server
 * could not tie back to a real source. Also applies the report's count bounds
 * (findings/conflicts/citations-per-item) and length caps (summary/item
 * text), every one of which is named in the returned `boundGaps` when it
 * fires — never applied silently.
 *
 * These bounds substantially reduce the report's size but do NOT by
 * themselves guarantee it serializes under RAW_META_MAX_BYTES (64 KB):
 * citation `title` and `url` are supplied by the source registry and are not
 * length-capped here (that belongs to the registry builder). The 64 KB
 * ceiling is enforced downstream, in brief-save.ts, which fails loudly rather
 * than silently shredding a saved report.
 */
export function validateReport(
  model: ModelReport,
  registry: SourceRegistry,
): { report: Omit<Report, "gaps" | "synthesis">; boundGaps: string[] } {
  const boundGaps: string[] = [];

  const resolvedFindings = model.findings
    .map((f) => resolveItem(f, registry))
    .filter((f): f is ResolvedItem => f !== null);
  const resolvedConflicts = model.conflicts
    .map((c) => resolveItem(c, registry))
    .filter((c): c is ResolvedItem => c !== null)
    // A conflict needs two DISTINCT sources or it is not a conflict.
    .filter((c) => c.item.citations.length >= 2);

  const anyCitationsTruncated = [...resolvedFindings, ...resolvedConflicts].some(
    (r) => r.citationsTruncated,
  );
  if (anyCitationsTruncated) {
    boundGaps.push(
      `Some findings cite more sources than the report shows (limit ${MAX_CITATIONS_PER_ITEM} per item).`,
    );
  }

  let findings = resolvedFindings.map((r) => r.item);
  let conflicts = resolvedConflicts.map((r) => r.item);

  if (findings.length > MAX_FINDINGS) {
    boundGaps.push(`${findings.length - MAX_FINDINGS} further findings omitted (report bound).`);
  }
  if (conflicts.length > MAX_CONFLICTS) {
    boundGaps.push(`${conflicts.length - MAX_CONFLICTS} further conflicts omitted (report bound).`);
  }

  findings = findings.slice(0, MAX_FINDINGS);
  conflicts = conflicts.slice(0, MAX_CONFLICTS);

  let textTruncated = false;
  const capItemText = (it: ReportItem): ReportItem => {
    const capped = capChars(it.text, MAX_ITEM_TEXT_CHARS);
    if (!capped.truncated) return it;
    textTruncated = true;
    return { ...it, text: capped.text };
  };
  findings = findings.map(capItemText);
  conflicts = conflicts.map(capItemText);

  const cappedSummary = capChars(model.summary, MAX_SUMMARY_CHARS);
  if (cappedSummary.truncated) textTruncated = true;

  if (textTruncated) {
    boundGaps.push(
      `Some text was shortened to fit the report's length limits (summary ${MAX_SUMMARY_CHARS} chars, item text ${MAX_ITEM_TEXT_CHARS} chars).`,
    );
  }

  return {
    report: {
      summary: cappedSummary.text,
      findings,
      conflicts,
    },
    boundGaps,
  };
}
