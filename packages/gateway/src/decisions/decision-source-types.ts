/**
 * Which indexed item types feed decision mining.
 *
 * Email and calendar are deliberately absent, matching `glossary`: mining a
 * personal inbox into a TEAM artifact is not a posture to adopt silently.
 *
 * Keys are `service:type`. Filtering on the bare `type` half would silently
 * widen scope — `message`, `page` and `issue` are generic names shared across
 * services, so `type IN (...)` also admits `wiz:issue` (cloud-security posture
 * findings) today and any user-installed extension emitting `message`
 * tomorrow.
 */
export const DECISION_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "slack:message",
  "discord:message",
  "teams:message",
  "notion:page",
  "confluence:page",
  "obsidian:obsidian_note",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
]);

/** The table MUST be aliased `i`. */
const DECISION_SOURCE_MATCH_SQL = "(i.service || ':' || i.type)";

export function decisionSourceFilter(): { sql: string; params: string[] } {
  const keys = [...DECISION_SOURCE_TYPES];
  const placeholders = keys.map(() => "?").join(", ");
  return { sql: `${DECISION_SOURCE_MATCH_SQL} IN (${placeholders})`, params: keys };
}
