import { standupDisclosures, windowLabel } from "../brief-disclosures.ts";
import type { StandupBrief } from "../standup-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief, isoMinuteUtc, plural } from "./_shared.ts";
import { renderEntrySection } from "./entries.ts";
import { stripLineStructureChars } from "./text.ts";

/**
 * Who the standup is about, as it appears inside an inline-code span in the PREAMBLE.
 *
 * Hardened for `changelogScopeLabel`'s reason and then some: unlike `--service`, which is
 * owner-supplied and length-capped by the RPC validator, a display name is CONNECTOR-supplied —
 * it is whatever a Slack profile or Jira account claimed — so a newline in it would end the
 * preamble line and let the remainder render as a `## ` heading of its own, inside the exact
 * region the I31 disclosures live in. The person ID falls back the same way, since
 * `[user] mePersonId` reaches here verbatim (`self-person.ts` short-circuits on it without
 * validation) and the RPC validator caps its length but rejects no control character.
 */
function standupWhoLabel(identity: StandupBrief["identity"]): string {
  const raw = identity.displayName ?? identity.personId;
  return stripLineStructureChars(raw).replaceAll("`", "");
}

/**
 * How the identity was decided, spelled out for the reader rather than left as a bare id.
 *
 * `source` changes how much an empty section is worth trusting, so it belongs on the page and
 * not only in `findings`: `git` matched a configured email against an indexed person, `override`
 * was taken from `nimbus.toml` and never checked against the index at all, and `os` is a
 * heuristic that can land on a colleague whose GitHub login equals this machine's username.
 * `unresolved` is unreachable — `emitStandupBrief` refuses before building a brief — but is
 * rendered rather than omitted, because a `TIME_BASIS`-style total map is what keeps a future
 * fourth source from silently rendering as nothing.
 */
const STANDUP_SOURCE_LABEL: Readonly<Record<StandupBrief["identity"]["source"], string>> =
  Object.freeze({
    override: "pinned by `[user] mePersonId`",
    git: "matched from `git config user.email`",
    os: "guessed from your OS username",
    unresolved: "unresolved",
  });

export function renderStandup(brief: StandupBrief, opts?: RenderOpts): string {
  const header = "# Standup";
  // The disclosures sit in the PREAMBLE — above the first `##` — because each qualifies every
  // section below it. `preambleBody` (`markdown-sections.ts`) stops at the first LEVEL-2
  // heading, which is why this brief's title is `#` and not `##`: under a level-2 title the
  // preamble would be empty and `contractViolations` could never reach these sentences.
  const preamble = [
    "",
    // `windowLabel`, never `Math.round(span / 86_400_000)`: the DEFAULT window here is `24h` and
    // `--since 6h` is an ordinary use, both of which a day-only label renders as "last 0d" or
    // "last 1d" — a window the lanes did not query, printed one line above the unconditional
    // "Counts and entries below cover only this window" disclosure. `renderChangelog` shipped
    // exactly that defect; on this brief it would be the common case rather than the edge one.
    `_window: last ${windowLabel(brief.query.nowMs - brief.query.sinceMs)} (${isoMinuteUtc(brief.query.sinceMs)} → ${isoMinuteUtc(brief.query.nowMs)})_`,
    `_for: \`${standupWhoLabel(brief.identity)}\` (${STANDUP_SOURCE_LABEL[brief.identity.source]})_`,
    ...standupDisclosures(brief).map((d) => d.line),
  ].join("\n");
  const sections = [
    renderEntrySection("Pull requests active", brief.prsActive, isoMinuteUtc),
    renderEntrySection("Pull requests merged", brief.prsMerged, isoMinuteUtc),
    renderEntrySection("Reviews given", brief.reviews, isoMinuteUtc),
    renderEntrySection("Tickets opened", brief.ticketsOpened, isoMinuteUtc),
    renderEntrySection("Incidents responded to", brief.incidents, isoMinuteUtc),
    renderStandupSlackSection(brief),
  ].join("\n");
  return assembleBrief(header, [preamble, sections], brief, opts);
}

/**
 * Slack activity, headed by its THREAD count rather than only its message count.
 *
 * "Slack threads participated in" is the unit the roadmap names and the one a standup reader
 * wants: eleven replies in one thread is one conversation, not eleven items of work. Both
 * numbers are printed because neither alone is the answer — the thread count is the shape of the
 * day and the message count is the volume — and printing the thread count while listing messages
 * without saying which is which would leave the reader unable to reconcile a "3 threads" heading
 * with eleven bullets beneath it.
 *
 * Reuses {@link renderEntrySection}'s empty-case wording via that function rather than
 * hand-rolling this one: an empty Slack section must read `_None in this window._` exactly like
 * every other lane, since the alternative is a section that looks omitted rather than empty.
 */
function renderStandupSlackSection(brief: StandupBrief): string {
  const section = renderEntrySection("Slack activity", brief.messages, isoMinuteUtc);
  if (brief.counts.messages === 0) return section;
  const n = brief.counts.messages;
  const t = brief.threadCount;
  const messages = `${String(n)} ${plural(n, "message")}`;
  const threads = `${String(t)} ${plural(t, "thread")}`;
  const summary = `_${messages} across ${threads}._`;
  // Inserted after the heading's blank line rather than appended, so the summary is read before
  // the bullets it counts. `renderEntrySection` returns `["", "## …", "", body]` joined, so
  // splicing at index 3 puts this exactly where the body starts.
  const parts = section.split("\n");
  return [...parts.slice(0, 3), summary, "", ...parts.slice(3)].join("\n");
}
