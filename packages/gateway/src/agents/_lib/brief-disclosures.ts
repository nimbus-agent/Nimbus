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
   *
   * PLURAL, and ALL are required (F27). It was a single `anchor`, on the design assumption of
   * one sentence per entry — two entries broke it. A `line` carrying two independent
   * disclosures with one anchor drawn from the first sentence let a rewrite keep sentence 1,
   * drop sentence 2 and ship: observed live on `negotiate`, where the dropped sentence was the
   * one saying `## Decisions` and `## Ownership` are NOT filtered by the window printed above
   * them. `disclosure-anchor-coverage.test.ts` fails when a sentence is added without an anchor.
   */
  readonly anchors: readonly string[];
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
  return { scope: section(heading), line: NOT_COMPUTED_LINE, anchors: [NOT_COMPUTED_ANCHOR] };
}

// ---------------------------------------------------------------------------
// shared — window labelling
// ---------------------------------------------------------------------------

/**
 * `90d` / `4h` / `30m` — a window DURATION, at the coarsest unit that does not LOSE the
 * caller's precision.
 *
 * `Math.round(durationMs / 86_400_000)` alone rendered every sub-day window as "last 0d":
 * `--since 1h` is a valid request (`parseDurationToMs` accepts `ms|s|m|h|d|w`, and the IPC
 * bound is an upper one only), and "0d" states a window the lanes did not query. That is the
 * same class of misstatement the window clause exists to prevent — the clause is a
 * disclosure, so it cannot itself be wrong about the window.
 *
 * Rounding WITHIN a unit is fine (90d, 36h); collapsing to zero is not, hence the unit step
 * down rather than a wider `toFixed`. A zero window renders `0ms`, which is accurate: it
 * selects nothing.
 *
 * Shared rather than `negotiate`-specific, and named for the general case: `renderChangelog`
 * shipped its own `Math.round(... / 86_400_000)` and reproduced the exact defect this function
 * was written to fix, one section above the unconditional "Counts and entries below cover only
 * this window" disclosure.
 *
 * Takes a DURATION, never bounds — a caller holding absolute bounds subtracts first.
 */
export function windowLabel(durationMs: number): string {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (durationMs >= DAY) return `${String(Math.round(durationMs / DAY))}d`;
  if (durationMs >= HOUR) return `${String(Math.round(durationMs / HOUR))}h`;
  if (durationMs >= MINUTE) return `${String(Math.round(durationMs / MINUTE))}m`;
  return `${String(durationMs)}ms`;
}

// ---------------------------------------------------------------------------
// negotiate — interleaved
// ---------------------------------------------------------------------------

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
      `_window: last ${windowLabel(sinceMs)} — items authored by the subject that ` +
      "were ACTIVE in this window; the index records last-modified, not created. Two lanes " +
      "sit outside it: decisions windows on its recorded decision date, and ownership is not " +
      `windowed at all (it is an all-time snapshot) · generated ${new Date(
        generatedAt,
      ).toISOString()}_`,
    // TWO sentences, TWO anchors (F27). The second was observed being dropped by an accepted
    // synthesis while the first survived, and it is the one that says `## Decisions` and
    // `## Ownership` are not filtered by the window printed directly above them.
    anchors: ["last-modified, not created", "Two lanes sit outside it"],
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
          anchors: ["list truncated at the display limit"],
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
      // Sentence 2 carries the substantive facts — no CODEOWNERS, no on-call rotation,
      // reviewer data not factored in — and was unanchored. Same shape as the window entry.
      anchors: ["authorship-derived", "no CODEOWNERS and no on-call rotation"],
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
    anchors: ["no indexed assignee or resolver"],
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
    anchors: ["no indexed author"],
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
      anchors: ["no LLM configured"],
    };
  }
  if (source === "manual") {
    return {
      scope: section(term),
      line: "- _Authored in `nimbus.toml`; not derived from indexed sources._",
      anchors: ["not derived from indexed sources"],
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
    anchors: ["authorship needs a line"],
  };
}

// ---------------------------------------------------------------------------
// changelog
// ---------------------------------------------------------------------------

/**
 * `nimbus changelog`'s interleaved disclosures — all three in the PREAMBLE, because each
 * qualifies every category section below it and no section scope could reach them all.
 *
 * Anchors are drawn from each sentence's FACTUAL clause and stop short of its variable tail
 * (the leading count), and every independent sentence in a `line` carries its own anchor —
 * `disclosure-anchor-coverage.test.ts` pins that for the two-sentence entry below.
 *
 * **Length is calibrated, not incidental.** Every anchor here is 2–7 words, matching this
 * module's existing ones, because `synthesize.ts`'s instructions ask the model to REWRITE this
 * prose. A near-verbatim 12-word clause would make ordinary paraphrase a `contract_violation`,
 * so changelog synthesis would fail closed on every run and the feature would ship inert — a
 * defect that merely happens to be a safe one. Each anchor is instead the shortest fragment that
 * cannot survive the disclosure's removal.
 *
 * **All three are scoped to the preamble, so no anchor may be satisfiable by a SIBLING's line.**
 * If disclosure 2's anchors also occurred in disclosure 1's text, a rewrite could drop 2 entirely
 * and still pass. `disclosure-anchor-coverage.test.ts` checks that cross-satisfaction directly.
 *
 * The first entry is UNCONDITIONAL: it states what the numbers MEAN, and a reader who is told
 * nothing reads a windowed, event-timed count as an all-time one.
 */
export function changelogDisclosures(b: {
  readonly indexTimedCount: number;
  readonly truncatedCount: number;
}): readonly Disclosure[] {
  const out: Disclosure[] = [];
  out.push({
    scope: { kind: "preamble" },
    line:
      "Counts and entries below cover only this window, and each entry is placed by when it " +
      "happened rather than when the index last touched it.",
    // Sentence 1: the window bound. Sentence 2: the time BASIS — its factual core is that the
    // placement is not the index's last touch, which is the half a paraphrase cannot drop
    // without losing the meaning. Deliberately NOT the full "when it happened rather than when
    // the index last touched" clause: 12 near-verbatim words is a rewrite ban, not an anchor.
    anchors: ["cover only this window", "the index last touched"],
  });
  if (b.indexTimedCount > 0) {
    out.push({
      scope: { kind: "preamble" },
      line:
        `${String(b.indexTimedCount)} entr(y/ies) are timed from the index's last-touch column ` +
        "rather than an event field — deployments and incident resolutions, on the same basis " +
        "`nimbus metrics dora` uses. A resolved incident whose row has not been re-synced still " +
        "reads as unresolved, so resolutions under-report by sync lag.",
      // NOT `"same basis"`, which this sentence's earlier draft used: that is ordinary English a
      // rewrite could produce with the disclosure gone, and it rested entirely on the second
      // anchor to stay honest. `"rather than an event field"` is the contrast being disclosed —
      // it cannot occur unless the sentence is still making its point — and it does not appear
      // in the sibling disclosure's line, so dropping this one cannot be masked by keeping that.
      anchors: ["rather than an event field", "under-report by sync lag"],
    });
  }
  if (b.truncatedCount > 0) {
    out.push({
      scope: { kind: "preamble" },
      line: `${String(b.truncatedCount)} further entr(y/ies) were truncated at the display limit.`,
      anchors: ["truncated at the display limit"],
    });
  }
  return out;
}
