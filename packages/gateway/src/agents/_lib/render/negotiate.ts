import {
  negotiateAgentActionDisclosures,
  negotiateDecisionsDisclosure,
  negotiateIncidentsDisclosure,
  negotiateNotComputedSection,
  negotiateOwnershipDisclosures,
  negotiateSubjectVoice,
  negotiateWindowDisclosure,
} from "../brief-disclosures.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateBrief,
  NegotiateDecisions,
  NegotiateEvidence,
  NegotiateIncidents,
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
  NegotiateWriting,
} from "../negotiate-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { renderGaps, renderLatency, reserved } from "./_shared.ts";
import { escapeMarkdownLinkText, safeEvidenceHref } from "./text.ts";

/**
 * `subject.isOther` is true only when `--person <id>` named someone whose id differs
 * from the separately-resolved local user (`negotiate.ts` `resolveSubject` always
 * resolves both and compares) — `--person <your own id>` reads as a normal self brief,
 * not "someone other than you". The explicit-subject case always has a non-null
 * `personId`, so the fallback below is defensive, not reachable in practice. The
 * local-user case deliberately does not name the person: an unresolved local subject
 * already carries a `missing_user_identity` gap note.
 */
function renderNegotiateSubjectLine(subject: NegotiateSubject): string {
  if (subject.isOther) {
    const label = subject.displayName ?? subject.personId ?? "unknown person";
    return `**Subject:** ${label} — brief requested for someone other than you`;
  }
  return "**Subject:** you";
}

/**
 * The citation block under a lane's headline count.
 *
 * Returns `[]` — not a "no evidence" line — when there is nothing to cite: a lane that
 * counted zero has already said so, and an empty population needs no citation. The
 * truncation line is emitted from `total - refs.length` so a capped list can never read as
 * exhaustive, the same self-disclosure rule `statsCoverage` follows.
 *
 * A ref with no usable url renders as plain text, never as a link to nowhere.
 */
function renderNegotiateEvidence(evidence: NegotiateEvidence): string[] {
  if (evidence.refs.length === 0) return [];
  const lines = evidence.refs.map((r) => {
    const title = escapeMarkdownLinkText(r.title);
    const href = r.url === null ? null : safeEvidenceHref(r.url);
    return href === null ? `  - ${title}` : `  - [${title}](${href})`;
  });
  const remaining = evidence.total - evidence.refs.length;
  if (remaining > 0) lines.push(`  - …and ${String(remaining)} more not listed`);
  return lines;
}

/**
 * A `null` lane means "could not be computed" (failed, or never attempted for lack of a
 * resolved subject) and must never render as `0` — that distinction is the entire reason
 * `authoredPrs` is nullable rather than defaulting to an all-zero object.
 */
function renderNegotiateAuthoredPrs(a: NegotiateAuthoredPrs | null): string {
  if (a === null) {
    return negotiateNotComputedSection("PRs authored");
  }
  const mergedSuffix =
    a.mergedCoverage.covered < a.mergedCoverage.total
      ? ` (merge status known for ${String(a.mergedCoverage.covered)}/${String(a.mergedCoverage.total)})`
      : "";
  const lines = [
    "## PRs authored",
    "",
    `- ${String(a.count)} PR(s), ${String(a.merged)} merged${mergedSuffix}`,
  ];
  if (a.stats === null) {
    // Only when there was something to enrich. With zero authored PRs in the window,
    // "no enriched PR in this window" reads as a coverage failure over a real population
    // rather than what it is — an empty population, already stated by the line above.
    if (a.statsCoverage.total > 0) {
      lines.push("- stats: not available (no enriched PR in this window)");
    }
  } else {
    const coverageSuffix =
      a.statsCoverage.covered < a.statsCoverage.total
        ? ` (stats coverage ${String(a.statsCoverage.covered)}/${String(a.statsCoverage.total)})`
        : "";
    lines.push(
      `- stats: +${String(a.stats.additions)} / -${String(a.stats.deletions)} across ${String(
        a.stats.changedFiles,
      )} file(s)${coverageSuffix}`,
    );
  }
  lines.push(...renderNegotiateEvidence(a.evidence));
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateReviewedPrs(r: NegotiateReviewedPrs | null): string {
  if (r === null) {
    return negotiateNotComputedSection("PRs reviewed");
  }
  const lines = [
    "## PRs reviewed",
    "",
    `- ${String(r.count)} review(s): ${String(r.approved)} approved, ${String(
      r.changesRequested,
    )} changes requested, ${String(r.otherOrUnknown)} other/unknown`,
  ];
  lines.push(...renderNegotiateEvidence(r.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. `unattributable`
 * follows the same disclosure shape as `NegotiateDecisions.unattributable` (see
 * `renderNegotiateDecisions`'s docstring), but with TWO differences: a zero `unattributable` is
 * omitted entirely rather than stated as zero ("0 incidents attributed to nobody" reads as a
 * warning about a problem that does not exist — the counted lines above it already say what did
 * happen, so a zero here has nothing to add), and the caveat names no cause at all. This count is
 * dominated by cases the code cannot distinguish from each other — chiefly incidents that
 * auto-resolved with no human actor, which is not a data-quality problem — so, exactly like the
 * decisions caveat, it states the fact and disclaims a specific reading without asserting why.
 */
function renderNegotiateIncidents(i: NegotiateIncidents | null): string {
  if (i === null) {
    return negotiateNotComputedSection("Incidents");
  }
  const lines = [
    "## Incidents",
    "",
    `- ${String(i.resolved)} resolved, ${String(i.assigned)} assigned`,
  ];
  // Its own line, never summed into the incident counts (spec § 5.7). Suppressed
  // at zero: with no Sentry connector this lane is structurally empty, and a
  // printed "0 assigned" would read as a measurement of the person rather than
  // of the index. The gap note carries that case instead.
  if (i.errorIssuesAssigned > 0) {
    lines.push(`- ${String(i.errorIssuesAssigned)} Sentry error issue(s) assigned`);
  }
  const unattributable = negotiateIncidentsDisclosure(i);
  if (unattributable !== undefined) lines.push(unattributable.line);
  lines.push(...renderNegotiateEvidence(i.evidence));
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateTickets(t: NegotiateTickets | null): string {
  if (t === null) {
    return negotiateNotComputedSection("Tickets");
  }
  const lines = [
    "## Tickets",
    "",
    `- ${String(t.opened)} opened, ${String(t.closedByAuthoredPr)} closed by an authored PR`,
    ...negotiateAgentActionDisclosures("Tickets", t.agentActions).map((d) => d.line),
  ];
  // Cites the OPENED issues only — see `NegotiateTickets.evidence` for why the
  // closed-by-authored-PR hop is deliberately not cited here.
  lines.push(...renderNegotiateEvidence(t.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. The
 * undercount guard (Task 4, spec § 5.A0) surfaces here as an unconditional line: it is a
 * fact about the index (never an attribution to the subject), so it renders whenever it is
 * non-zero, not just when the lane otherwise has something to say.
 */
function renderNegotiateOwnership(o: NegotiateOwnership | null): string {
  if (o === null) {
    return negotiateNotComputedSection("Ownership");
  }
  const lines = ["## Ownership", ""];
  if (o.services.length === 0 && o.directories.length === 0) {
    lines.push("- no recorded ownership");
  } else {
    if (o.services.length > 0) lines.push(`- services: ${o.services.join(", ")}`);
    if (o.directories.length > 0) lines.push(`- directories: ${o.directories.join(", ")}`);
  }
  lines.push(
    o.lastPassAt === null
      ? "- ownership pass: never run (`nimbus owners --refresh`)"
      : `- ownership pass last ran ${new Date(o.lastPassAt).toISOString()}`,
  );
  const disclosures = negotiateOwnershipDisclosures(o);
  if (disclosures.truncation !== undefined) lines.push(disclosures.truncation.line);
  if (o.unmappedIdentitiesInIndex > 0) {
    lines.push(
      `- ${String(o.unmappedIdentitiesInIndex)} git identities in this index are not mapped ` +
        "to a person; ownership attributed to them is not counted here.",
    );
  }
  // Unconditional, exactly as `nimbus owners` states it in every brief (`agents/ownership.ts`):
  // this lane reads the SAME `owns` edges, which are derived from git blame. Under a heading
  // like "## Ownership — services: checkout", inside a document about someone's contribution,
  // an unlabelled ownership claim reads as formal accountability. The sentence itself lives in
  // `brief-disclosures.ts`, which is also what the synthesis contract guard requires to survive.
  lines.push(disclosures.accountability.line);
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. Same
 * disambiguation problem as `renderNegotiateOwnership`'s `unmappedIdentitiesInIndex`
 * (Task 4): `unattributable` is a fact about the INDEX — decisions mined from a source
 * (Obsidian, Teams) that records no author AT ALL, which is precisely and only what
 * `laneDecisions` queries (`i.author_id IS NULL`). It is NOT "decisions authored by someone
 * else": those are simply absent from both counts. Do not widen the query to match a looser
 * reading of this comment — that would inflate `unattributable` and make the rendered line
 * below false.
 *
 * Printed next to `authored` with no disambiguating text, a reader (or their manager) could
 * misread "N authored, M unattributable" as "N + M decisions, M just not linked to me" — the
 * undercount failure inverted into an overstatement, which is worse (spec § 8.2, Task 5
 * fix-round-1). The line must therefore read as "N decisions attributed to <subject>; M
 * decisions exist in the index with no attributable author, not counted above and not
 * necessarily <subject>'s" — matching `renderNegotiateOwnership`'s "attributed to them is not
 * counted here" phrasing. The subject is threaded in rather than hardcoded to "you" for the
 * same reason `renderNegotiateSubjectLine` takes it.
 */
function renderNegotiateDecisions(d: NegotiateDecisions | null, subject: NegotiateSubject): string {
  if (d === null) {
    return negotiateNotComputedSection("Decisions");
  }
  const voice = negotiateSubjectVoice(subject);
  const lines = [
    "## Decisions",
    "",
    `- ${String(d.authored)} decision(s) attributed to ${voice.addressed}`,
    negotiateDecisionsDisclosure(d, subject).line,
  ];
  lines.push(...renderNegotiateEvidence(d.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. `docs` and
 * `notes` each partly reflect the `[negotiate] personal_sources` gate (spec § 3.3) — see
 * `NegotiateWriting`'s docstring and `negotiate.ts`'s `PERSONAL_CAPABLE_SERVICES` for which
 * services that covers; this line never explains *why* a count reads low/zero — that
 * disclosure lives in `renderNegotiateSources`, unconditionally, so it is stated once
 * rather than repeated (and not restated here, so the two cannot drift apart).
 */
function renderNegotiateWriting(w: NegotiateWriting | null): string {
  if (w === null) {
    return negotiateNotComputedSection("Writing");
  }
  const lines = [
    "## Writing",
    "",
    `- ${String(w.docs)} doc(s), ${String(w.notes)} note(s), ${String(w.messages)} message(s) authored`,
    ...negotiateAgentActionDisclosures("Writing", w.agentActions).map((d) => d.line),
  ];
  lines.push(...renderNegotiateEvidence(w.evidence));
  return lines.join("\n");
}

/**
 * Sources the brief drew on (spec § 5.F). Rendered unconditionally, like
 * `unavailableEvidence`: when no personal source is configured, the section states so by
 * name — `personalDocsConfigKey` — so an empty personal-sources result reads as "not
 * enabled", never as "nothing found".
 */
export function renderNegotiateSources(sources: NegotiateBrief["sources"]): string {
  const ignored = renderIgnoredPersonalSources(sources.personalDocsUnrecognised);
  // Three states, not two. Telling a reader to "set `[negotiate] personal_sources`" when they
  // have already set it — and every entry was unrecognised — is the advice that wastes the
  // most time, so that case gets its own line saying what actually went wrong.
  let line: string;
  if (sources.personalDocsConfigured) {
    line = `- personal document sources: ${sources.personalDocsRecognised.join(
      ", ",
    )} — configured and included in the writing lane above${ignored}`;
  } else if (sources.personalDocsUnrecognised.length > 0) {
    line = `- personal document sources are not enabled: no entry in \`${sources.personalDocsConfigKey}\` matched a personal-capable service${ignored}`;
  } else {
    line = `- personal document sources are not enabled (set \`${sources.personalDocsConfigKey}\` in nimbus.toml to include them)`;
  }
  return ["## Sources", "", line].join("\n");
}

/**
 * The unconditional list of evidence classes this agent structurally cannot measure.
 * Extracted from `renderNegotiate`'s inline array so `reserved-sections.ts` can build the
 * identical block from the identical input — the two halves of a split brief must be the
 * same function on the same data, never two renderings that could drift.
 *
 * Takes the field rather than the whole brief, matching `renderNegotiateSources(brief.sources)`
 * beside it: a whole-brief parameter would force every caller and test to construct (or cast)
 * a full `NegotiateBrief` to exercise one list.
 */
export function renderNegotiateEvidenceSection(unavailableEvidence: readonly string[]): string {
  return [
    "## Evidence not available from the index",
    "",
    ...unavailableEvidence.map((e) => `- ${e}`),
  ].join("\n");
}

/**
 * The disclosure half of the `personalDocsConfigured` fix. An entry that matches no
 * personal-capable service widens nothing, so dropping it silently leaves a mis-typed or
 * mis-named opt-in indistinguishable from a source that was genuinely empty — and, before
 * `personalDocsConfigured` became an intersection, made an undercount render as complete
 * coverage. The entries are echoed back quoted so the reader can see the exact string their
 * `nimbus.toml` carries.
 */
function renderIgnoredPersonalSources(unrecognised: readonly string[]): string {
  if (unrecognised.length === 0) return "";
  const noun = unrecognised.length === 1 ? "entry" : "entries";
  const quoted = unrecognised.map((s) => `"${s}"`).join(", ");
  return ` (${String(unrecognised.length)} unrecognised ${noun} ignored: ${quoted})`;
}

/**
 * Task 1's version rendered only the subject, the window and generation time, the gap
 * notes, and the unconditional `unavailableEvidence` list. Task 2 added the authored/
 * reviewed PR lane sections; Task 3 adds the tickets lane; Task 4 adds ownership; Task 5
 * adds decisions; Task 6 adds writing + sources; Task 11 adds incidents, between tickets
 * and ownership — a lane whose field is `null` renders as "could not be computed", never
 * as `0`; each later lane task extends this further the same way.
 */
export function renderNegotiate(brief: NegotiateBrief, opts?: RenderOpts): string {
  const header = "# Negotiation brief";
  const subjectLine = renderNegotiateSubjectLine(brief.subject);
  // The window clause is a disclosure, not decoration. `item` has no creation timestamp, so
  // every item-backed lane filters on `modified_at` — GitHub's `updated_at`, i.e. LAST TOUCH.
  // Under a bare "_window: last 90d_" header, "40 PR(s)" is read as "40 authored this quarter"
  // when the query actually means "40 you authored at any time that were touched in this
  // window" — a systematic OVERSTATEMENT of the headline numbers, the failure direction this
  // agent exists to avoid. Re-querying on creation date is unavailable, so saying so is the fix.
  // It sits in the PREAMBLE because it qualifies every count below it; the synthesis contract
  // guard reaches it there through `preambleBody`, not through any section.
  const windowLine = negotiateWindowDisclosure(brief.query.sinceMs, brief.generatedAt).line;
  const authoredPrs = renderNegotiateAuthoredPrs(brief.authoredPrs);
  const reviewedPrs = renderNegotiateReviewedPrs(brief.reviewedPrs);
  const tickets = renderNegotiateTickets(brief.tickets);
  const incidents = renderNegotiateIncidents(brief.incidents);
  const ownership = renderNegotiateOwnership(brief.ownership);
  const decisions = renderNegotiateDecisions(brief.decisions, brief.subject);
  const writing = renderNegotiateWriting(brief.writing);
  const sources = reserved(renderNegotiateSources(brief.sources), opts);
  const evidence = reserved(renderNegotiateEvidenceSection(brief.unavailableEvidence), opts);
  const gaps = reserved(renderGaps(brief.gaps), opts);
  const footer = renderLatency(brief.latencyMs);
  return [
    header,
    "",
    subjectLine,
    windowLine,
    "",
    authoredPrs,
    "",
    reviewedPrs,
    "",
    tickets,
    "",
    incidents,
    "",
    ownership,
    "",
    decisions,
    "",
    writing,
    "",
    sources,
    "",
    evidence,
    gaps,
    footer,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
