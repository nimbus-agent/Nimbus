/**
 * Curated, prefix-anchored, low-false-positive regexes for v1 of
 * `nimbus security scan`. Pure module — no DB, no I/O. Each entry is a
 * `{ name, category, regex }` triple. All regexes are global-flagged so
 * `body.matchAll(p.regex)` iterates non-overlapping matches.
 *
 * Pure-entropy / sibling-gated patterns (AWS secret key, Twilio auth
 * token, Azure storage key, Heroku UUID) are deferred to v2 — flagging
 * them solo produces a false-positive flood. See the design spec at
 * docs/superpowers/specs/2026-05-21-nimbus-security-scan-design.md §5.
 */

export type SecretCategory = "api_key" | "private_key" | "token";

export interface SecretPattern {
  readonly name: string;
  readonly category: SecretCategory;
  readonly regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { name: "aws_access_key", category: "api_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github_pat_classic", category: "token", regex: /\bghp_[A-Za-z0-9]{36,}\b/g },
  {
    name: "github_pat_fine_grained",
    category: "token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
  },
  { name: "github_oauth", category: "token", regex: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { name: "gitlab_pat", category: "token", regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g },
  {
    name: "slack_bot_token",
    category: "token",
    regex: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}\b/g,
  },
  {
    name: "slack_user_token",
    category: "token",
    regex: /\bxoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{32}\b/g,
  },
  // sk-ant- patterns are matched FIRST (longer prefix wins via name ordering
  // when the scanner iterates patterns); openai_api_key is the broader
  // fallback. The pure scanner does not deduplicate cross-pattern overlaps
  // in v1; downstream users should treat the more-specific name as the truth
  // if both match the same offset.
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
]);

/**
 * Redact a secret value for safe display. Returns first-4 + "****" + last-4
 * when the secret is at least 8 chars, otherwise a generic 4-asterisk mask.
 * The full secret value never appears in the output.
 */
export function redactSecret(raw: string): string {
  if (raw.length < 8) return "****";
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

const CONTEXT_RADIUS = 40;

/**
 * Build a ±CONTEXT_RADIUS context snippet around the match with the secret
 * middle replaced by the literal string `[REDACTED]`. The snippet is bounded
 * by the body endpoints; it never contains the original secret bytes.
 */
export function buildContextSnippet(body: string, offset: number, length: number): string {
  const start = Math.max(0, offset - CONTEXT_RADIUS);
  const end = Math.min(body.length, offset + length + CONTEXT_RADIUS);
  const before = body.slice(start, offset);
  const after = body.slice(offset + length, end);
  return `${before}[REDACTED]${after}`;
}
