import { MAX_CITATIONS_PER_ITEM, MAX_CONFLICTS, MAX_FINDINGS } from "./brief-constants.ts";
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

/**
 * Resolves an item's refs against the registry. Unknown tokens vanish; a quote
 * that cannot be verified against the cited body is dropped while its citation
 * survives. Returns null when nothing resolved.
 */
function resolveItem(item: ModelItem, registry: SourceRegistry): ReportItem | null {
  const citations: SourceRef[] = [];
  const seen = new Set<string>();
  for (const token of item.refs) {
    if (seen.has(token)) continue;
    const entry = registry.get(token);
    if (entry === undefined) continue;
    seen.add(token);
    const claimed = item.quotes?.[token];
    const verified = claimed === undefined ? null : verifyQuote(entry.body, claimed);
    citations.push({
      ...entry.ref,
      ...(verified === null ? {} : { quote: verified }),
    });
    if (citations.length >= MAX_CITATIONS_PER_ITEM) break;
  }
  if (citations.length === 0) return null;
  return { text: item.text, citations };
}

/**
 * Turns raw model output into a report that cannot contain a claim the server
 * could not tie back to a real source. Also applies the report bounds, so the
 * result always serializes well under RAW_META_MAX_BYTES.
 */
export function validateReport(
  model: ModelReport,
  registry: SourceRegistry,
): { report: Omit<Report, "gaps" | "synthesis">; boundGaps: string[] } {
  const boundGaps: string[] = [];

  const findings = model.findings
    .map((f) => resolveItem(f, registry))
    .filter((f): f is ReportItem => f !== null);
  const conflicts = model.conflicts
    .map((c) => resolveItem(c, registry))
    .filter((c): c is ReportItem => c !== null)
    // A conflict needs two DISTINCT sources or it is not a conflict.
    .filter((c) => c.citations.length >= 2);

  if (findings.length > MAX_FINDINGS) {
    boundGaps.push(`${findings.length - MAX_FINDINGS} further findings omitted (report bound).`);
  }
  if (conflicts.length > MAX_CONFLICTS) {
    boundGaps.push(`${conflicts.length - MAX_CONFLICTS} further conflicts omitted (report bound).`);
  }

  return {
    report: {
      summary: model.summary,
      findings: findings.slice(0, MAX_FINDINGS),
      conflicts: conflicts.slice(0, MAX_CONFLICTS),
    },
    boundGaps,
  };
}
