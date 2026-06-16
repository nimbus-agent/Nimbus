import { SENSITIVE_VALUE_PATTERNS } from "../audit/format-audit-payload.ts";

// Share-specific PII patterns, keyed by stable family name (added on top of secrets).
// All quantifiers are EXPLICITLY BOUNDED (no unbounded `+`/`*` over overlapping classes) so the
// matcher is linear and cannot exhibit super-linear backtracking on adversarial input — these run
// over share payloads that may contain attacker-influenced text (e.g. a quoted external tool
// result). Bounds reflect real-world limits (RFC-5321 local-part ≤64, label ≤63, etc.).
const SHARE_PII_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["emails", /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g],
  ["slack-handles", /<[@#][A-Z0-9]{6,32}(?:\|[^>]{1,256})?>/g],
  ["credit-cards", /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g],
  [
    "ips",
    /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g,
  ],
  ["hostnames", /(?<![\w.])(?:[a-z0-9-]{1,63}\.){1,16}(?:internal|local|corp|lan|intra)(?![\w])/gi],
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
      let sk = scrub(k, applied, caller);
      // Redaction can collapse two distinct keys onto the same value (e.g. both `[REDACTED]`).
      // Disambiguate so no field is silently dropped by an overwrite.
      if (Object.hasOwn(out, sk)) {
        let i = 2;
        while (Object.hasOwn(out, `${sk}#${i}`)) i++;
        sk = `${sk}#${i}`;
      }
      out[sk] = walk(v, applied, caller);
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
  // Deterministic code-unit order (NOT locale-dependent localeCompare): the redaction set is
  // embedded in the signed share body, so its order must be stable across machines.
  return { redacted, applied: [...applied].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}
