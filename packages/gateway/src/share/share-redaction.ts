import { SENSITIVE_VALUE_PATTERNS } from "../audit/format-audit-payload.ts";

/** Share-specific PII patterns, keyed by stable family name (added on top of secrets). */
const SHARE_PII_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["emails", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["slack-handles", /<[@#][A-Z0-9]{6,}(?:\|[^>]+)?>/g],
  ["credit-cards", /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g],
  [
    "ips",
    /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g,
  ],
  ["hostnames", /(?<![\w.])(?:[a-z0-9-]+\.)+(?:internal|local|corp|lan|intra)(?![\w])/gi],
]);

export interface ShareRedactionResult {
  readonly redacted: unknown;
  readonly applied: readonly string[];
}

function scrub(s: string, applied: Set<string>, caller: readonly RegExp[]): string {
  let out = s;
  for (const [, pat] of SENSITIVE_VALUE_PATTERNS) {
    if (pat.test(out)) {
      applied.add("secrets");
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  for (const [family, pat] of SHARE_PII_PATTERNS) {
    if (pat.test(out)) {
      applied.add(family);
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  for (const pat of caller) {
    if (pat.test(out)) {
      applied.add("caller");
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  return out;
}

function walk(value: unknown, applied: Set<string>, caller: readonly RegExp[]): unknown {
  if (typeof value === "string") return scrub(value, applied, caller);
  if (Array.isArray(value)) return value.map((v) => walk(v, applied, caller));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, applied, caller);
    }
    return out;
  }
  return value;
}

export function redactForShare(
  payload: unknown,
  callerPatterns: readonly RegExp[] = [],
): ShareRedactionResult {
  const applied = new Set<string>();
  const redacted = walk(payload, applied, callerPatterns);
  return { redacted, applied: [...applied].sort() };
}
