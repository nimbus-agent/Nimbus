/**
 * Which indexed item types feed glossary mining.
 *
 * Email and calendar are deliberately absent. The roadmap does not list them,
 * and mining a personal inbox into a TEAM glossary is not a posture to adopt
 * silently. Keys are `service:type`, matching PROSE_HEAVY_TYPES style.
 *
 * `filesystem:git_commit` is the ONLY confirmed commit source
 * (`connectors/filesystem-v2-sync.ts`). That row stores the commit subject in
 * `title` and the SHA in `body_preview`, so mining reads it from the title —
 * which is why the scan concatenates title and body rather than reading the
 * body alone.
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

/** The bare `type` values, for the SQL `type IN (...)` filter. */
export function glossarySourceTypeList(): string[] {
  const types = new Set<string>();
  for (const key of GLOSSARY_SOURCE_TYPES) {
    const idx = key.indexOf(":");
    types.add(idx === -1 ? key : key.slice(idx + 1));
  }
  return [...types];
}
