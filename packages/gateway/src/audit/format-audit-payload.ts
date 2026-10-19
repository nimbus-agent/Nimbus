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
  ["stripe", /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g],
  ["gitlab", /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ["google_api", /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g],
  ["slack_app", /(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g],
  // The whole block, header to footer. Both runs are bounded, so the lazy body cannot backtrack
  // super-linearly; a key longer than 16 KiB of base64 is not a real private key.
  [
    "pem_private_key",
    /-----BEGIN [A-Z ]{0,24}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,24}PRIVATE KEY-----/g,
  ],
  // `scheme://user:password@host`: only the userinfo goes, so the host stays readable.
  ["url_userinfo", /(?<=[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}(?=@)/g],
  // A secret-named query parameter's value (`?access_token=…`, `&sig=…`); the name stays.
  [
    "url_secret_param",
    /(?<=[?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|client_secret|password|secret)=)[^&#\s"']{1,2048}/gi,
  ],
  // A credential matching no family above but labelled as one: `password=…`, `api_key: "…"`. The
  // label goes too. A quoted value is consumed whole (spaces included) before the unquoted form.
  [
    "labelled_credential",
    /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)(?![A-Za-z0-9])\s{0,8}[=:]\s{0,8}(?:"[^"]{0,2048}"|'[^']{0,2048}'|[^\s"'&,;]{1,2048})/gi,
  ],
]);

/**
 * Contact details, scrubbed from the egress ledger's payload summary (`redactEgressSummary`) and
 * from shares. NOT applied to `audit_log`: an audit row is the owner's record of what an approved
 * action did and to whom, and blanking the recipient there would make it useless for that; its
 * exposure is bounded by retention instead. Quantifiers are bounded so matching stays linear.
 *
 * A phone number must carry a leading `+` (international grouping, `+44 20 7946 0958`) or
 * separators between North American groups (`(415) 555-0100`): a bare run of digits is far more
 * often an id or an epoch timestamp, and those fill audit payloads.
 */
export const CONTACT_VALUE_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["emails", /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g],
  [
    "phones",
    /(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\w)|(?<![\w+])\+\d{1,3}(?:[ .-]?\d{2,4}){2,5}(?!\w)/g,
  ],
]);

/** True when an object key names a credential (`apiKey`, `client_secret`, `pat`, …). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Every credential-shaped run in `s` replaced by `[REDACTED]`. */
export function redactSensitiveValueString(s: string): string {
  let out = s;
  for (const pat of SENSITIVE_VALUE_PATTERNS.values()) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

function redactContactsString(s: string): string {
  let out = s;
  for (const pat of CONTACT_VALUE_PATTERNS.values()) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

function redact(value: unknown, contacts: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const scrubbed = redactSensitiveValueString(value);
    return contacts ? redactContactsString(scrubbed) : scrubbed;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, contacts));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, contacts);
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
  return formatAuditPayload(redact(payload, false), maxBytes);
}

/**
 * {@link redactAuditPayload} plus {@link CONTACT_VALUE_PATTERNS}: for a record whose job is to say
 * THAT something left the machine, not who it was addressed to (the egress ledger).
 */
export function redactPayloadWithContacts(payload: unknown, maxBytes = DEFAULT_MAX_BYTES): string {
  return formatAuditPayload(redact(payload, true), maxBytes);
}
