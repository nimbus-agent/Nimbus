import { hardenedTitleLink } from "./text.ts";

/**
 * The fields an entry renderer reads, and nothing else.
 *
 * Structural rather than `ChangelogRow`, so `renderStandup` shares these two functions instead
 * of copying them. That sharing is the point: the hardening below is security-relevant and was
 * WRONG once already — the changelog PR shipped `--format slack|plain` with links unconverted
 * because the escaping here and the CLI's link regex disagreed about an escaped bracket, a seam
 * no per-file review saw. A second brief with its own copy is a second place for that to happen,
 * and the two row types differ only in a field neither function reads (`timeSource` /
 * `timeBasis`).
 */
export type RenderableEntry = {
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
};

/**
 * One entry, its title linked by {@link hardenedTitleLink}.
 *
 * `stamp` is injected because the right precision is a property of the WINDOW, not of the
 * renderer: a changelog over 7d wants the date, and a standup over 24h wants the time — every
 * entry in it would otherwise read `2026-09-12`, collapsing the ordering information the reader
 * came for into one indistinguishable value.
 */
function renderBriefEntry(r: RenderableEntry, stamp: (ms: number) => string): string {
  return `- ${hardenedTitleLink(r.title, r.url)} — ${stamp(r.atMs)}`;
}

/**
 * A category section, rendered whether or not it has entries.
 *
 * The empty case prints its heading and `_None in this window._` rather than being omitted:
 * a missing heading and an empty one say different things — "this changelog does not cover
 * deployments" versus "no deployment happened in this window" — and the reader cannot tell
 * them apart from an absence. The whole point of these briefs is that silence is never evidence.
 */
export function renderEntrySection(
  heading: string,
  rows: readonly RenderableEntry[],
  stamp: (ms: number) => string,
): string {
  const body =
    rows.length === 0
      ? "_None in this window._"
      : rows.map((r) => renderBriefEntry(r, stamp)).join("\n");
  return ["", `## ${heading}`, "", body].join("\n");
}
