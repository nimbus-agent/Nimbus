import { sourceTypesFor } from "../sources/source-kinds.ts";

/**
 * Which indexed item types feed glossary mining: every `service:type` whose kind the glossary
 * pass reads (`sources/source-kinds.ts`, which also carries the service-qualified-key and the
 * no-email/calendar reasoning).
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
export const GLOSSARY_SOURCE_TYPES: ReadonlySet<string> = new Set(sourceTypesFor("glossary"));
