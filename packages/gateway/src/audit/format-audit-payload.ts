const DEFAULT_MAX_BYTES = 4096;

const SENSITIVE_KEY = /(token|key|secret|password|credential|bearer|auth|^pat$)/i;

/**
 * Credential-shaped value patterns, keyed by a stable family name.
 *
 * Boundary design: JavaScript `\b` treats `_` as a word character, so a token
 * adjacent to — or containing — `_` sits between two "word" chars, produces no
 * boundary, and silently escapes redaction. Each pattern instead uses an
 * explicit leading `(?<![A-Za-z0-9])` and a trailing negative lookahead aligned
 * to that pattern's OWN body charset.
 *
 * The two GitHub prefixes are kept as separate patterns because their bodies
 * differ (classic `gh[pousr]_` excludes `_`; fine-grained `github_pat_` includes
 * it). A single shared trailing lookahead over a union would have to pick one
 * charset, and an `_`-inclusive lookahead re-opens the `ghp_…_x` escape this
 * scrubber fixes.
 *
 * Exported so the redaction property test can assert 1:1 generator coverage.
 */
export const SENSITIVE_VALUE_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["github_classic", /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g],
  ["github_fine_grained", /(?<![A-Za-z0-9])github_pat_\w{20,}(?!\w)/g],
  ["openai", /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ["anthropic", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ["slack", /(?<![A-Za-z0-9])xox[boapr]s?-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g],
  // Trailing lookahead EXCLUDES `=` on purpose: a token with 3+ trailing `=`
  // (e.g. `Bearer <body>===`) would otherwise backtrack-fail and LEAK the whole
  // credential. Excluding `=` lets `={0,2}` consume the padding and redact.
  ["bearer", /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9_.\-+/]{16,}={0,2}(?![A-Za-z0-9_./+-])/g],
  ["jwt", /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g],
  ["aws", /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
]);

function redactSensitiveValueString(s: string): string {
  let out = s;
  for (const pat of SENSITIVE_VALUE_PATTERNS.values()) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveValueString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

export function formatAuditPayload(payload: unknown, maxBytes = DEFAULT_MAX_BYTES): string {
  const serialized = JSON.stringify(payload);
  if (serialized.length > maxBytes) {
    return `${serialized.slice(0, maxBytes)}…[truncated]`;
  }
  return serialized;
}

export function redactAuditPayload(payload: unknown, maxBytes = DEFAULT_MAX_BYTES): string {
  return formatAuditPayload(redact(payload), maxBytes);
}
