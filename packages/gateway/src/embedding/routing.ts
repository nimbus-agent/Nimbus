/**
 * Embedding-routing policy and supported-dimension catalogue.
 *
 * The two `EMBEDDING_DIM_*` constants are the only valid `vec_items_<dim>`
 * suffixes. Adding a new provider track means adding a new constant + its
 * companion `vec_items_<dim>` migration; everything else routes through
 * `SUPPORTED_EMBEDDING_DIMS`.
 *
 * `PROSE_HEAVY_TYPES` holds the `(service, type)` pairs whose primary
 * content is natural-language prose. In `provider="hybrid"` mode these
 * route to OpenAI `text-embedding-3-small` (1536-dim); everything else
 * stays on local MiniLM-L6-v2 (384-dim).
 */

export const EMBEDDING_DIM_LOCAL = 384 as const;
export const EMBEDDING_DIM_OPENAI = 1536 as const;
export const SUPPORTED_EMBEDDING_DIMS: ReadonlySet<number> = new Set([
  EMBEDDING_DIM_LOCAL,
  EMBEDDING_DIM_OPENAI,
]);

export const PROSE_HEAVY_TYPES: ReadonlySet<string> = new Set([
  "slack:message",
  "discord:message",
  "teams:message",
  "gmail:email",
  "outlook:email",
  "notion:page",
  "confluence:page",
  "obsidian:obsidian_note",
  "pagerduty:incident",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
  "bitbucket:issue",
  // Snyk aggregated-issues carry a markdown `description` field that is
  // genuinely paragraph-shaped (attack-surface explanation + remediation
  // discussion). Hybrid-mode users opt in to OpenAI embeddings via the
  // `openai.api_key` vault key; the MiniLM fallback kicks in automatically
  // when the key is missing (see `nimbus-embedding-routing` skill).
  "snyk:vulnerability",
]);

export function routingKey(service: string, type: string): string {
  return `${service}:${type}`;
}

export function isProseHeavy(service: string, type: string): boolean {
  return PROSE_HEAVY_TYPES.has(routingKey(service, type));
}
