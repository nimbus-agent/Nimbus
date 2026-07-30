/**
 * Which indexed item types feed glossary mining.
 *
 * Email and calendar are deliberately absent. The roadmap does not list them,
 * and mining a personal inbox into a TEAM glossary is not a posture to adopt
 * silently. Keys are `service:type`, matching PROSE_HEAVY_TYPES style.
 *
 * `filesystem:git_commit` is the ONLY commit source that exists today
 * (`connectors/filesystem-v2-sync.ts`). That row stores the commit subject in
 * `title` and the SHA in `body_preview`, so mining reads it from the title —
 * which is why the scan concatenates title and body rather than reading the
 * body alone. `github:commit` and `gitlab:commit` are listed because the
 * roadmap names commit messages as a glossary source, but no connector writes
 * `item.type = 'commit'` today: the GitHub sync emits `pr`/`issue` and the
 * GitLab sync `pr`/`issue`/`ci_run` (verified 2026-07-31). Under the
 * service-qualified filter below they match nothing until such a connector
 * lands, which is the safe direction for a dead allowlist row.
 *
 * No generic markdown item type exists, so ADRs are mined only when their
 * repository is indexed as an Obsidian vault (`obsidian:obsidian_note`).
 * Recorded in the spec's Known Limits rather than silently under-delivered.
 */
export const GLOSSARY_SOURCE_TYPES: ReadonlySet<string> = new Set([
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
  "github:commit",
  "gitlab:commit",
  "filesystem:git_commit",
]);

/**
 * SQL predicate matching an `item` row against the allowlist, service half
 * included. The table MUST be aliased `i`.
 *
 * Filtering on the bare `type` half alone would silently widen the scope:
 * `message`, `page`, `issue` and `commit` are generic type names shared across
 * services, so `type IN (...)` also admits every out-of-scope source that
 * happens to reuse one — `wiz:issue` (cloud-security posture findings) today,
 * and any user-installed extension emitting `message` tomorrow. That is the
 * "mining a personal inbox is not a posture to adopt silently" rule leaking in
 * through the back door, and because `service_spread` is a geometric multiplier
 * in `scoreTerm`, an unintended service also inflates the score of every term
 * it mentions.
 */
const GLOSSARY_SOURCE_MATCH_SQL = "(i.service || ':' || i.type)";

/** The `service:type` keys plus the SQL that compares a row against them. */
export function glossarySourceFilter(): { sql: string; params: string[] } {
  const keys = [...GLOSSARY_SOURCE_TYPES];
  const placeholders = keys.map(() => "?").join(", ");
  return { sql: `${GLOSSARY_SOURCE_MATCH_SQL} IN (${placeholders})`, params: keys };
}
