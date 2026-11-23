import { changelogDisclosures, windowLabel } from "../brief-disclosures.ts";
import type { ChangelogBrief } from "../changelog-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief, isoDay } from "./_shared.ts";
import { renderEntrySection } from "./entries.ts";
import { stripLineStructureChars } from "./text.ts";

/**
 * The `--service` the owner asked for, as it appears inside an inline-code span in the PREAMBLE.
 *
 * Interpolating it raw was the odd one out on this brief: the entry title and href beside it are
 * both hardened. The value is owner-supplied and bounded (`ipc/agents-rpc/params-common.ts` trims it and caps
 * it at `MAX_SERVICE_LEN`), and `agents.changelog` is not on the Tauri allowlist, so the only
 * reachable case is an owner injecting into their own brief. But that validator rejects no
 * CONTROL character: a newline would end the preamble line and let the remainder render as a
 * `## ` heading of its own — inside the exact region the I31 disclosures live in, where a
 * fabricated section is the failure this brief's whole disclosure design exists to prevent.
 * Backticks go for the reason one level down: either of them closes the code span early.
 *
 * Dropped rather than substituted: a replacement character would be a second thing the reader
 * has to interpret, and nothing legitimate reaches here carrying one.
 *
 * Shares {@link stripLineStructureChars} with the entry title rather than repeating its class:
 * the backtick is the ONLY difference, and it matters here alone because this value sits inside
 * an inline-code span that a backtick would close early.
 */
function changelogScopeLabel(service: string): string {
  return stripLineStructureChars(service).replaceAll("`", "");
}

export function renderChangelog(brief: ChangelogBrief, opts?: RenderOpts): string {
  const header = "# Changelog";
  const scope =
    brief.query.service === null
      ? "_scope: all services_"
      : `_scope: service \`${changelogScopeLabel(brief.query.service)}\`_`;
  // The disclosures sit in the PREAMBLE — above the first `##` — because each one qualifies
  // every category section below it. `preambleBody` (`markdown-sections.ts`) stops at the first
  // LEVEL-2 heading, which is why this brief's title is `#` and not `##`: under a level-2 title
  // the preamble would be empty and `contractViolations` could never reach these sentences.
  const preamble = [
    "",
    // `windowLabel`, not `Math.round(span / 86_400_000)`: `--since 6h` is a documented example
    // in `cli-reference.md`, and a day-only label renders it as "last 0d" — a window the lanes
    // did not query, stated one line above the unconditional "Counts and entries below cover
    // only this window" disclosure. The dates keep the absolute bounds visible either way.
    `_window: last ${windowLabel(brief.query.nowMs - brief.query.sinceMs)} (${isoDay(brief.query.sinceMs)} → ${isoDay(brief.query.nowMs)})_`,
    scope,
    ...changelogDisclosures(brief).map((d) => d.line),
  ].join("\n");
  const sections = [
    renderEntrySection("Merged Pull Requests", brief.mergedPrs, isoDay),
    renderEntrySection("Deployments", brief.deployments, isoDay),
    renderEntrySection("Incidents Opened", brief.incidentsOpened, isoDay),
    renderEntrySection("Incidents Resolved", brief.incidentsResolved, isoDay),
  ].join("\n");
  return assembleBrief(header, [preamble, sections], brief, opts);
}
