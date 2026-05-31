const DEFAULT_MAX_BYTES = 4096;

const SENSITIVE_KEY = /(token|key|secret|password|credential|bearer|auth|^pat$)/i;

const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[boapr]s?-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9_.\-+/]{16,}={0,2}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

function redactSensitiveValueString(s: string): string {
  let out = s;
  for (const pat of SENSITIVE_VALUE_PATTERNS) {
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
