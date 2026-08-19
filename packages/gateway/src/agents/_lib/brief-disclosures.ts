import type { GlossaryEntry } from "./glossary-types.ts";
import type {
  NegotiateDecisions,
  NegotiateIncidents,
  NegotiateOwnership,
  NegotiateSubject,
} from "./negotiate-types.ts";

/**
 * The disclosure sentences that sit INTERLEAVED with the numbers they qualify, and the
 * anchors `brief-contract.ts` requires to survive a synthesis rewrite (invariant **I31**).
 *
 * Why this module exists: I31 PR 1 made whole-section disclosures (`## Gaps` and
 * `negotiate`'s two reserved sections) safe BY CONSTRUCTION — they are held out of the
 * model prompt and re-attached verbatim, so no check is involved. That mechanism is
 * unavailable to a sentence living inside prose the model is meant to rewrite, and the
 * fallback — an anchor-phrase check — was two independent copies of the same string: a
 * literal in `render.ts` and a matching literal in `brief-contract.ts`. Editing one and not
 * the other yields a guard requiring a phrase nothing renders (which rejects every
 * synthesis) or a rendered disclosure nothing guards (the gap this closes). Both sides now
 * read the SAME constant, so the two can no longer drift.
 *
 * The presence PREDICATE lives here too, not just the text: `negotiateOwnershipDisclosures`
 * decides whether a truncation clause applies, and the renderer only asks whether it got
 * one. A predicate re-derived at the guard would be a third copy free to drift from the
 * render condition — the same defect one level down.
 */

/** Where in a brief a disclosure must survive. */
export type DisclosureScope =
  /**
   * A level-2 section, matched by normalized PREFIX exactly as `sectionBody` defines it —
   * `render.ts` emits headings like `## Ownership — services: checkout`, and exact equality
   * would report a perfectly good section missing and reject the rewrite.
   */
  | { readonly kind: "section"; readonly heading: string }
  /**
   * Everything above the first level-2 heading. `renderNegotiate` puts the window clause
   * there, so no section-scoped requirement can reach it.
   */
  | { readonly kind: "preamble" };

/** One disclosure: the line a renderer emits, and the fragment that must survive a rewrite. */
export type Disclosure = {
  readonly scope: DisclosureScope;
  /** The exact text the renderer emits. */
  readonly line: string;
  /**
   * The fragment `contractViolations` requires, normalized-compared inside `scope`.
   *
   * An anchor MUST be a phrase that cannot occur unless the disclosure is present. An
   * earlier draft of this work used `not necessarily` for the decisions line; that is
   * ordinary prose, and a rewrite saying "this is not necessarily a problem" under
   * `## Decisions` would satisfy the guard with the disclosure gone — a false negative in
   * an honesty guard, the worst direction to fail. Every anchor below is drawn from the
   * FACTUAL clause of its sentence, which is also the half that cannot be dropped without
   * losing the meaning.
   *
   * Anchors also stop short of each sentence's tail, because the tail is variable: the
   * decisions line ends "not necessarily yours"/"…theirs" depending on `--person`, so an
   * anchor including it would be inert for half of all briefs.
   */
  readonly anchor: string;
};

function section(heading: string): DisclosureScope {
  return { kind: "section", heading };
}

// ---------------------------------------------------------------------------
// negotiate — null lanes
// ---------------------------------------------------------------------------

/**
 * A `null` lane means "could not be computed" (it failed, or never ran for lack of a
 * resolved subject) and must never render as `0`.
 */
const NOT_COMPUTED_LINE = "_could not be computed_";
const NOT_COMPUTED_ANCHOR = "could not be computed";

/** The whole section a null lane renders, so the disclaimer has ONE definition. */
export function negotiateNotComputedSection(heading: string): string {
  return [`## ${heading}`, "", NOT_COMPUTED_LINE].join("\n");
}

export function negotiateNotComputedDisclosure(heading: string): Disclosure {
  return { scope: section(heading), line: NOT_COMPUTED_LINE, anchor: NOT_COMPUTED_ANCHOR };
}

// ---------------------------------------------------------------------------
// negotiate — interleaved
// ---------------------------------------------------------------------------

/** `90d` / `4h` / `30m`, the window as the brief states it. */
export function negotiateWindowLabel(sinceMs: number): string {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (sinceMs >= DAY) return `${String(Math.round(sinceMs / DAY))}d`;
  if (sinceMs >= HOUR) return `${String(Math.round(sinceMs / HOUR))}h`;
  if (sinceMs >= MINUTE) return `${String(Math.round(sinceMs / MINUTE))}m`;
  return `${String(sinceMs)}ms`;
}

/**
 * The window clause, which qualifies EVERY headline count in the brief.
 *
 * `item` has no creation timestamp, so every item-backed lane filters on `modified_at` —
 * GitHub's `updated_at`, i.e. last touch. Under a bare "_window: last 90d_" header,
 * "40 PR(s)" reads as "40 authored this quarter" when the query means "40 you authored at
 * any time that were TOUCHED in this window" — a systematic overstatement of the headline
 * numbers, the failure direction this agent exists to avoid.
 *
 * Takes the raw `sinceMs`/`generatedAt` rather than pre-formatted strings so the guard can
 * build the same disclosure from the brief alone, without reaching into the renderer.
 */
export function negotiateWindowDisclosure(sinceMs: number, generatedAt: number): Disclosure {
  return {
    scope: { kind: "preamble" },
    line:
      `_window: last ${negotiateWindowLabel(sinceMs)} — items authored by the subject that ` +
      "were ACTIVE in this window; the index records last-modified, not created. Two lanes " +
      "sit outside it: decisions windows on its recorded decision date, and ownership is not " +
      `windowed at all (it is an all-time snapshot) · generated ${new Date(
        generatedAt,
      ).toISOString()}_`,
    anchor: "last-modified, not created",
  };
}

/**
 * Ownership's disclosures. The accountability disclaimer is UNCONDITIONAL — `nimbus owners`
 * states it in every brief and this lane reads the same git-blame-derived `owns` edges, so
 * under a heading like "## Ownership — services: checkout", inside a document about
 * someone's contribution, an unlabelled ownership claim reads as formal accountability.
 *
 * Returned as a named pair rather than one list so the renderer keeps its existing line
 * order (truncation, then the unmapped-identities count, then the disclaimer) without
 * re-deriving either condition.
 */
export function negotiateOwnershipDisclosures(o: NegotiateOwnership): {
  readonly truncation: Disclosure | undefined;
  readonly accountability: Disclosure;
} {
  return {
    truncation: o.truncated
      ? {
          scope: section("Ownership"),
          line: "- list truncated at the display limit — more owned paths exist",
          anchor: "list truncated at the display limit",
        }
      : undefined,
    accountability: {
      scope: section("Ownership"),
      // Do NOT shorten this to "there is no reviewer data in the index" — this same brief
      // renders a measured "PRs reviewed" section, so that claim would contradict it.
      // `nimbus owners` (`agents/ownership.ts`) is deliberately narrower for the same
      // reason; match it.
      line:
        "- this is authorship-derived ownership — who wrote the lines, not who is formally " +
        "accountable. There is no CODEOWNERS and no on-call rotation in the index, and " +
        "reviewer data (`reviewed` edges from GitHub PR reviews) is not factored into this " +
        "ranking.",
      anchor: "authorship-derived",
    },
  };
}

/**
 * Incidents with no person edge at all — a fact about the INDEX, not about this person.
 *
 * Suppressed at zero: the counted lines above already say what did happen, so "0 incidents
 * attributed to nobody" reads as a warning about a problem that does not exist. The clause
 * names no cause, because this count is dominated by populations the code cannot tell apart
 * (chiefly auto-resolved incidents with no human actor).
 */
export function negotiateIncidentsDisclosure(i: NegotiateIncidents): Disclosure | undefined {
  if (i.unattributable <= 0) return undefined;
  return {
    scope: section("Incidents"),
    line:
      `- ${String(i.unattributable)} in-window incident(s) have no indexed assignee or ` +
      "resolver and are not counted above — not necessarily inactivity",
    anchor: "no indexed assignee or resolver",
  };
}

/**
 * Decisions whose source item records no author at all (`obsidian-sync.ts` / `teams-sync.ts`
 * set no `authorId`) — counted rather than dropped, so a small `authored` count cannot be
 * read as "they decided nothing". Unconditional, including at zero, unlike the incidents
 * clause above: this line disambiguates the denominator the number beside it is drawn from.
 */
export function negotiateDecisionsDisclosure(
  d: NegotiateDecisions,
  subject: NegotiateSubject,
): Disclosure {
  const voice = negotiateSubjectVoice(subject);
  return {
    scope: section("Decisions"),
    line:
      `- ${String(d.unattributable)} decision(s) in this index have no indexed author and are ` +
      `not counted above — they are not necessarily ${voice.possessive}`,
    anchor: "no indexed author",
  };
}

/**
 * Second person for the operator's own brief, the subject's name for anyone else's.
 *
 * Lives here rather than in `render.ts` because the decisions disclosure EMBEDS the
 * possessive: splitting the sentence from the voice that completes it is exactly the
 * two-copies-free-to-drift shape this module exists to remove.
 */
export function negotiateSubjectVoice(subject: NegotiateSubject): {
  addressed: string;
  possessive: string;
} {
  if (!subject.isOther) return { addressed: "you", possessive: "yours" };
  return {
    addressed: subject.displayName ?? subject.personId ?? "the subject",
    possessive: "theirs",
  };
}

// ---------------------------------------------------------------------------
// glossary
// ---------------------------------------------------------------------------

/**
 * Labels a definition that was not synthesized by an LLM, so the reader can weigh it.
 * An `llm` (or absent) source has no provenance caveat to keep, and requires nothing.
 *
 * The heading is the TERM — `render.ts` renders `## <term>` — which the section scope
 * accommodates unchanged, since it carries a computed string rather than a fixed one.
 * Only `term` mode reaches this: `list` mode renders one line per entry under no heading
 * of its own and emits no provenance sentence, so requiring one there would reject every
 * list-mode synthesis for a disclosure the renderer never wrote.
 */
export function glossaryProvenanceDisclosure(
  term: string,
  source: GlossaryEntry["definitionSource"],
): Disclosure | undefined {
  if (source === "snippet") {
    return {
      scope: section(term),
      line: "- _Definition quoted verbatim from a source; no LLM configured._",
      anchor: "no LLM configured",
    };
  }
  if (source === "manual") {
    return {
      scope: section(term),
      line: "- _Authored in `nimbus.toml`; not derived from indexed sources._",
      anchor: "not derived from indexed sources",
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// why — change arm
// ---------------------------------------------------------------------------

/**
 * The change-arm caveat `renderWhySubjectLine` (`render.ts`) prints under a resolved
 * `changeSubject`: two of the six lanes — authorship and downstream — cannot answer a
 * pull-request URL, because both are file/line lanes by nature and a `prUrl` question never
 * had one. Lives in the preamble, not a section: `renderWhy` puts it directly under the
 * subject line, above the first `##` lane heading.
 *
 * Anchored on "authorship needs a line" rather than the whole sentence, for the same reason
 * every anchor in this module is a factual fragment: it is the half that cannot be dropped
 * without losing the meaning, and it stops short of the sentence's tail (the `nimbus impact
 * <url>` pointer), which is incidental phrasing a rewrite is free to restate.
 */
export function whyChangeSubjectDisclosure(): Disclosure {
  return {
    scope: { kind: "preamble" },
    line:
      "_Asked about a change: authorship needs a line (`nimbus why <file>:<line>`), " +
      "and downstream impact is `nimbus impact <url>`._",
    anchor: "authorship needs a line",
  };
}
