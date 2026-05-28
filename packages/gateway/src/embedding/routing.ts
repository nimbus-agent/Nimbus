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
  "snyk:vulnerability",
]);

export function routingKey(service: string, type: string): string {
  return `${service}:${type}`;
}

export function isProseHeavy(service: string, type: string): boolean {
  return PROSE_HEAVY_TYPES.has(routingKey(service, type));
}
