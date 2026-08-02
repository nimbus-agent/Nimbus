/**
 * Positive read-only tool allowlist for recipe replay (Phase 6 Slice 8c, spec §8.1).
 *
 * A tool is read-only iff its trailing `_`-segment is a recognized READ verb. The set is the
 * spec's four (`list`/`get`/`query`/`search`) plus a curated read surface grounded in a scan of
 * `packages/mcp-connectors/*` tool ids (e.g. `slack_channel_history`, `dataprofile_preview`,
 * `*_read`/`*_fetch`/`*_download`). This is intentionally a POSITIVE allowlist — a write tool
 * absent from `HITL_REQUIRED_BACKING` (a real risk the design review flagged) is STILL classified
 * non-read here, because classification never consults the HITL set. Anything unrecognized is
 * skipped (`skipped-non-read`), which is fail-safe: a missed read tool costs replay coverage, never
 * safety. Broadening the set is a safe, additive follow-up.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  // spec §8.1 core
  "list",
  "get",
  "query",
  "search",
  // curated read surface (read-only verbs observed in connector tool ids)
  "read",
  "fetch",
  "download",
  "describe",
  // "preview" — DELIBERATELY ABSENT. It reads as a read verb and is not one: `iac_pulumi_preview`
  // runs `pulumi preview --cwd <caller-supplied workingDirectory>`, and `pulumi preview` EVALUATES
  // the stack program in that directory. Admitting the verb let an untrusted share file reach local
  // code execution through a list named "read-only". It was also the ONLY real connector tool id
  // ending in `_preview` (the `dataprofile_preview` this list once cited is a name the dataprofile
  // no-row-data contract test asserts must THROW), so removing it costs zero replay coverage.
  // The lesson generalizes: this list classifies by NAME, so a verb earns a place only when every
  // tool that can carry it is known to be a read.
  "history",
  "export",
  "view",
  "show",
  "info", // slack_user_info, teams_user_info
  "metadata", // gdrive_file_metadata
]);

/** Classify a tool id as read-only by its trailing `_`-segment verb. Pure; fail-safe on bad input. */
export function isReadOnlyToolId(toolId: string): boolean {
  if (typeof toolId !== "string") return false;
  const idx = toolId.lastIndexOf("_");
  if (idx <= 0 || idx === toolId.length - 1) return false; // no prefix, or trailing "_"
  return READ_VERBS.has(toolId.slice(idx + 1));
}
