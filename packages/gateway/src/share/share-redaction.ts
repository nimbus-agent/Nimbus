import { SENSITIVE_VALUE_PATTERNS } from "../audit/format-audit-payload.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

// Share-specific PII patterns, each tagged with a stable family name (added on top of secrets).
// A family may appear more than once (e.g. `ips` = one IPv4 + one IPv6 pattern) so each individual
// regex stays simple — keeping the alternations apart avoids a single over-complex expression.
// All quantifiers are EXPLICITLY BOUNDED (no unbounded `+`/`*` over overlapping classes) so the
// matcher is linear and cannot exhibit super-linear backtracking on adversarial input — these run
// over share payloads that may contain attacker-influenced text (e.g. a quoted external tool
// result). Bounds reflect real-world limits (RFC-5321 local-part ≤64, label ≤63, etc.). The IPv4
// form intentionally over-matches dotted-decimal runs (`\d{1,3}`) rather than range-validating each
// octet — over-redaction is the safe direction for a privacy filter and keeps the regex linear.
const SHARE_PII_PATTERNS: ReadonlyArray<{ readonly family: string; readonly pattern: RegExp }> = [
  { family: "emails", pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g },
  { family: "slack-handles", pattern: /<[@#][A-Z0-9]{6,32}(?:\|[^>]{1,256})?>/g },
  { family: "credit-cards", pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g },
  { family: "ips", pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g },
  { family: "ips", pattern: /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g },
  {
    family: "hostnames",
    pattern: /(?<![\w.])(?:[a-z0-9-]{1,63}\.){1,16}(?:internal|local|corp|lan|intra)(?!\w)/gi,
  },
];

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
  for (const { family, pattern } of SHARE_PII_PATTERNS) {
    if (pattern.test(out)) {
      applied.add(family);
      out = out.replace(pattern, "[REDACTED]");
    }
    pattern.lastIndex = 0;
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
  return { redacted, applied: [...applied].sort(codeUnitCompare) };
}
