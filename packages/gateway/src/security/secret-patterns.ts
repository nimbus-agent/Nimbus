export type SecretCategory = "api_key" | "private_key" | "token";

export interface SecretPattern {
  readonly name: string;
  readonly category: SecretCategory;
  readonly regex: RegExp;
  readonly confidence: "high" | "extended";
}

const HIGH_CONFIDENCE_PATTERNS: ReadonlyArray<Omit<SecretPattern, "confidence">> = [
  { name: "aws_access_key", category: "api_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github_pat_classic", category: "token", regex: /\bghp_[A-Za-z0-9]{36,}\b/g },
  {
    name: "github_pat_fine_grained",
    category: "token",
    regex: /\bgithub_pat_\w{82,}\b/g,
  },
  { name: "github_oauth", category: "token", regex: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { name: "gitlab_pat", category: "token", regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g },
  {
    name: "slack_bot_token",
    category: "token",
    regex: /\bxoxb-\d{10,}-\d{10,}-[A-Za-z0-9]{24}\b/g,
  },
  {
    name: "slack_user_token",
    category: "token",
    regex: /\bxoxp-\d{10,}-\d{10,}-\d{10,}-[A-Za-z0-9]{32}\b/g,
  },
  { name: "anthropic_api_key", category: "api_key", regex: /\bsk-ant-[a-z0-9-]{32,}\b/g },
  { name: "openai_api_key", category: "api_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "stripe_live_secret", category: "api_key", regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { name: "stripe_test_secret", category: "api_key", regex: /\bsk_test_[A-Za-z0-9]{20,}\b/g },
  { name: "twilio_sid", category: "api_key", regex: /\bAC[a-f0-9]{32}\b/g },
  { name: "google_api_key", category: "api_key", regex: /\bAIza[A-Za-z0-9\-_]{35}\b/g },
  {
    name: "gcp_service_account_json",
    category: "private_key",
    regex: /"type"\s*:\s*"service_account"/g,
  },
  { name: "npm_token", category: "token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "docker_token", category: "token", regex: /\bdckr_pat_[A-Za-z0-9\-_]{27,}\b/g },
  {
    name: "pem_private_key",
    category: "private_key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
  },
  {
    name: "pgp_private_key",
    category: "private_key",
    regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
  },
  {
    name: "jwt",
    category: "token",
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "sendgrid_api_key",
    category: "api_key",
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  { name: "mailgun_api_key", category: "api_key", regex: /\bkey-[a-f0-9]{32}\b/g },
];

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze(
  HIGH_CONFIDENCE_PATTERNS.map((p) => ({ ...p, confidence: "high" as const })),
);

/**
 * Opt-in low-confidence tier (`[security].extended_patterns` / `--extended`).
 * Generic heuristics that catch more but false-positive more — never on by default.
 */
export const EXTENDED_SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    name: "generic_secret_assignment",
    category: "api_key",
    confidence: "extended",
    // an identifier containing secret/token/api[-_]key/passwd/password assigned a
    // 32+ char base64-ish literal, e.g. `apiSecret = "…"`, `API_KEY: '…'`
    regex: /\b\w*(?:secret|token|api[_-]?key|passwd|password)\s*[:=]\s*["'`][\w+/-]{32,}["'`]/gi,
  },
  {
    name: "generic_bearer_like",
    category: "token",
    confidence: "extended",
    regex: /\bbearer\s+[\w.-]{24,}\b/gi,
  },
]);

export function effectivePatterns(extended: boolean): readonly SecretPattern[] {
  return extended ? [...SECRET_PATTERNS, ...EXTENDED_SECRET_PATTERNS] : SECRET_PATTERNS;
}

export function redactSecret(raw: string): string {
  if (raw.length < 8) return "****";
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

const CONTEXT_RADIUS = 40;

export function buildContextSnippet(body: string, offset: number, length: number): string {
  const start = Math.max(0, offset - CONTEXT_RADIUS);
  const end = Math.min(body.length, offset + length + CONTEXT_RADIUS);
  const before = body.slice(start, offset);
  const after = body.slice(offset + length, end);
  return `${before}[REDACTED]${after}`;
}
