# Brief honesty contract — design

**Date:** 2026-08-17
**Slot:** Spine S1 (Local Brain), follow-up to agent brief synthesis (A0, #1234)
**Status:** design, awaiting review

---

## Problem

#1234 turned LLM synthesis on by default (`[agents] synthesis = "local"`), so a
model now rewrites every built-in brief before the reader sees it. The honesty
guard that was supposed to stop a rewrite from dropping a disclosure covers one
of fourteen brief kinds.

`agents/_lib/brief-contract.ts:75` `requiredPhrases()` returns a non-empty set
only for `negotiate`, and only for its `null` lanes. The other thirteen kinds
are listed explicitly and return `[]`. Every disclosure they carry is droppable
by a rewrite today, silently — the brief still renders, it just says less than
it promised.

This is written down as a known bound in four places (`docs/SECURITY-INVARIANTS.md`
I29, the mirrored I29 bullets in `CLAUDE.md` and `GEMINI.md`, and
`docs/roadmap.md:918`). It was correct to ship A0 with the bound stated rather
than hidden. This spec closes it.

## What a survey of the tree found

Every disclosure was located and classified against the source, not against the
roadmap's description of the source. The classification that matters is not
*which agent* carries a disclosure but *whether the disclosure is a whole
section or interleaved with prose the model should rewrite*.

### Whole sections

All fourteen renderers end with `renderGaps(brief.gaps)` (`_lib/render.ts:39`),
which emits a single `## Gaps` section, or nothing when there are no gap notes.
Most disclosures ride this channel:

| Disclosure | Site |
| --- | --- |
| `decisions` 0.86 confidence ceiling | `agents/decisions.ts:148` (unconditional) |
| `decisions` `body_complete = 0` truncation count | `agents/decisions.ts:131` (conditional) |
| `premortem` 0.86 theme-confidence ceiling | `agents/premortem.ts:451` (unconditional) |
| `premortem` cohort truncation count | `agents/premortem.ts:801` (conditional) |
| `ownership` "authorship-derived, not accountability" | `agents/ownership.ts:173` (unconditional) |
| `ownership` partial root coverage | `agents/ownership.ts:146` |
| `ownership` files excluded by `ignore_globs` | `agents/ownership.ts:136` |
| `ownership` unresolved git identities | `agents/ownership.ts:165` |
| `glossary` / `why` / `expert` / `catchup` / `premortem` coverage gaps | `gaps.push(...)` across those agents |

Two further whole-section disclosures belong to `negotiate` only:

- `## Sources` (`_lib/render.ts:882`) — whether `[negotiate] personal_sources`
  is configured, so an empty writing lane reads as "not enabled" and never as
  "nothing found".
- `## Evidence not available from the index` (`_lib/render.ts:968`) — the
  unconditional list of evidence classes this agent structurally cannot measure.

### Interleaved lines

These sit inside sections whose surrounding prose the model *should* rewrite,
so they cannot be held back from it:

| Disclosure | Site | Condition |
| --- | --- | --- |
| `negotiate` null-lane sentinel, ×7 lanes | `render.ts:662,690,716,743,764,841,865` | lane is `null` |
| `negotiate` authorship-derived ownership | `render.ts:791` | `ownership !== null` |
| `negotiate` window is last-modified, not created | `render.ts:955` | unconditional |
| `negotiate` unattributable incidents | `render.ts:730` | `incidents.unattributable > 0` |
| `negotiate` unattributable decisions | `render.ts:848` | `decisions !== null` |
| `glossary` definition quoted, no LLM configured | `render.ts:303` | `mode === "term"`, source `snippet` |
| `glossary` definition authored in `nimbus.toml` | `render.ts:306` | `mode === "term"`, source `manual` |

Of these, only the seven null-lane sentinels are guarded today.

### Correction to an earlier reading

The standalone `ownership` agent's accountability disclaimer was initially
taken for inline prose. It is a gap note (`agents/ownership.ts:173`). More of
the disclosure surface than expected sits behind one render function, which is
what makes a structural fix worth building.

## Approach

Two layers, each doing what it is good at.

**Layer 1 — reserved sections.** A section that is *entirely* disclosure has no
reason to pass through the model at all. Hold it out of the prompt, then
re-attach it verbatim. The disclosure survives by construction, with no check
involved and nothing to keep in sync: a gap note added to any agent next year is
protected the day it is written.

**Layer 2 — derived required phrases.** For the interleaved lines, a phrase
check is the only available mechanism. What changes is where the phrase comes
from: today `NEGOTIATE_LANES` hardcodes strings that also exist in `render.ts`,
two copies free to drift. The disclosure text becomes a named constant that the
renderer and the contract both read, so the guard cannot require a phrase that
is not rendered and editing the sentence updates both sides at once.

### Rejected alternatives

- **Phrase-guard everything.** Requiring a gap note's full sentence to survive
  verbatim would reject nearly every legitimate paraphrase, discarding the whole
  rewrite. Synthesis would go effectively dead on precisely the briefs that carry
  disclosures. Choosing a distinctive fragment per note instead is hand-listing
  wearing a derivation costume, and it drifts.
- **Extend the per-kind hand-list.** Cheapest, matches the existing code shape,
  and reproduces exactly the drift that created this gap.
- **Move every interleaved disclosure into a gap note** so it inherits Layer 1.
  Fewer mechanisms, but it relocates load-bearing sentences away from the numbers
  they qualify — the `unattributable` lines exist *next to* the counts they
  disambiguate, and a reader who has to scroll to a Gaps section to learn that a
  count excludes something is worse served.

## Components

### `splitReserved` and the shared heading parser

`brief-contract.ts:40` `sectionBody()` already parses `##` sections with a rule
that took a review round to settle: a section opens only at exactly `##`, and
ends at the next heading of the same or higher level. The splitter needs that
same parse. It is extracted into one shared module and consumed by both the
splitter and the phrase guard.

Writing a second parser is specifically what is being avoided here — sibling
guards built on separate copies of the same scan share the blind spot and get
fixed in only one of them.

The `##`-exactly rule also resolves a real collision for free: `glossary`
renders a `### Sources` sub-heading (`render.ts:317`) inside a term entry, which
must not be confused with `negotiate`'s reserved `## Sources` section.

### The reserved registry

Keyed by brief kind and exhaustive over the fourteen kinds, so a fifteenth kind
is a compile error rather than a silent empty set — the shape `requiredPhrases`
already uses.

- every kind: `## Gaps`
- `negotiate`, additionally: `## Sources`, `## Evidence not available from the index`

Per-kind rather than global so a future kind that legitimately wants a `##
Sources` section of its own is not silently gagged.

### Changes to `synthesize()`

`_lib/synthesize.ts:177`. New order:

1. `deterministic = deterministicRender(brief)` — unchanged.
2. If `opts.runner === undefined`, return the deterministic path — unchanged.
3. `split = splitReserved(deterministic, reservedFor(brief.kind))`. On failure
   (below), return the deterministic render with the new provenance variant and
   its own footer. **No model call is made.**
4. Build the prompt from `split.body`, not from the full deterministic render.
   `SYNTHESIS_INSTRUCTIONS` (`synthesize.ts:278`) gains a rule: do not emit a
   Gaps / Sources / Evidence-not-available section; they are appended for you.
5. Run the attempt; existing `!ok` handling unchanged.
6. **Empty-result check stays on the raw `attempt.markdown`**, before
   reassembly. After reassembly a model that returned `""` would yield a
   non-empty document consisting only of the reserved blocks, and would sail
   through a check applied later. The existing comment at `synthesize.ts:245`
   already explains why this check must precede the contract check; it now also
   has to precede reassembly.
7. Reassemble: strip any reserved heading the model emitted anyway, then append
   the reserved blocks verbatim, in their original relative order.
8. `contractViolations(brief, reassembled)` — run on the artifact the reader
   actually receives, not on an intermediate.
9. Return `withProvenanceFooter(reassembled, ...)`.

The brief JSON handed to the model still carries `gaps`. The model should know
what the limits are so its prose does not contradict them; it simply does not
get to render them.

### Placement of reserved blocks

Appended at the end of the model's markdown, before the provenance footer, in
their original relative order. In the deterministic render `## Sources` sits
mid-document; after synthesis it moves to the end. This is a deliberate and, I
would argue, better outcome: disclosures land in the same place on every brief
regardless of whether it was synthesized.

### Fail-closed check

A partition-by-heading-scan cannot throw, but it can silently find nothing —
which would hand the gaps to the model unguarded while looking healthy. The
guarantee therefore rests on an assertion, not on trust:

> After a successful split, `split.body` must contain no reserved heading for
> this kind, and every reserved heading present in `deterministic` must have
> produced exactly one block.

If that does not hold, synthesis is not attempted and the deterministic brief is
returned.

### New provenance variant

`SynthesisProvenance` (`synthesize.ts:51`) gains one `attempted: false` case:

```ts
{ attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_split_failed" }
```

with its own footer, following the existing rule in that file that each path
gets a distinct footer — `synthesize.ts:108` records that conflating them was a
real defect caught in review. Proposed text:

> _Rendered deterministically — the brief's reserved disclosure sections could
> not be isolated, so no rewrite was attempted._

This is a `briefReady` wire addition. It is worth the addition: a silent
regression here is the exact failure this work exists to prevent, so it must be
visible without a debug build.

### Disclosure constants (Layer 2)

The seven interleaved sentences move from string literals inside `render.ts`
into named exported constants in a new `_lib/brief-disclosures.ts`, consumed by
the render sites and referenced by `requiredPhrases`. Each constant carries the
full rendered text plus a short **anchor** — the fragment the guard matches:

| Constant | Anchor |
| --- | --- |
| negotiate null lane (existing) | `could not be computed` |
| negotiate ownership disclaimer | `authorship-derived` |
| negotiate window clause | `last-modified, not created` |
| negotiate unattributable incidents | `not necessarily inactivity` |
| negotiate unattributable decisions | `not necessarily` |
| glossary snippet provenance | `no LLM configured` |
| glossary manual provenance | `not derived from indexed sources` |

Anchors rather than whole sentences because requiring the full text verbatim
would reject legitimate paraphrase and discard the rewrite.

Short anchors are safe because `contractViolations` scopes each match to a
section heading — `not necessarily` under `## Incidents` and under `##
Decisions` are two independent requirements, not one ambiguous string. The
glossary entry heading is the term itself (`render.ts:322` renders `## <term>`),
which the existing `{ heading, phrase }` shape already accommodates since
`heading` is a computed string.

`brief-disclosures.ts` is a targeted extraction confined to lines this work
already touches, not a refactor of the 938-line `render.ts`.

## Testing

**Every guard test is red-proved by reverting the mechanism and confirming the
test fails.** A green suite proves nothing about a guard; a vacuous test in a PR
about vacuous disclosures would be a poor joke.

Layer 1:

- A rewrite omitting `## Gaps` → the final output carries it verbatim.
- A rewrite that *invents* a Gaps section → the fabricated one is stripped and
  the canonical one appears exactly once.
- A brief with zero gap notes → no `## Gaps` heading and no empty section.
- A split that leaves a reserved heading in `body` → no model call, deterministic
  output, `reserved_split_failed` provenance.
- Empty model output → `empty_result`, not a document consisting only of gaps.

Layer 2:

- Per constant: a rewrite with the anchor deleted → `contract_violation` naming
  that violation; a genuine paraphrase retaining the anchor → accepted.
- The two `not necessarily` requirements are proved independent: dropping it
  from `## Incidents` while retaining it under `## Decisions` must fail.

Anti-inertness, for both layers:

- Every `RESERVED_HEADINGS` entry appears in at least one renderer's real
  output. A registry entry citing a heading that never renders is a guard that
  cannot fire.
- Every disclosure constant's full text appears in at least one render output,
  for a fixture that triggers its condition.

Also:

- `scripts/agent-brief-shape.snapshot.json` regenerates (it moved in #1234).
- New files meet the coverage floor (≥85% line, ≥80% branch). That gate is
  CI-Linux-authoritative, so it is verified via `verify:docker`, not locally.

## Documentation

The narrow coverage is stated in four places, all of which move in the same
commit as the code that changes it:

- `docs/SECURITY-INVARIANTS.md` — the I29 honesty-guard paragraph
- `CLAUDE.md` and `GEMINI.md` — the mirrored I29 bullets, which must stay identical
- `docs/roadmap.md:918` — the A0 delivered entry
- `docs/CHANGELOG.md` — dated entry

## Open questions for review

1. **Invariant placement.** The honesty guard currently lives as a clause inside
   I29, the *egress* invariant. It is not about egress — it is about what a brief
   may stop saying. It may deserve its own invariant number. Flagged rather than
   claimed unilaterally; resolving it changes which docs move and whether a new
   enforcement test row is added to `security-invariants.test.ts`.
2. **Glossary list-mode `— authored` suffix** (`render.ts:345`). Excluded here as
   a label rather than a limit claim, unlike the term-mode provenance lines.
   Worth a second opinion.
3. **Reserved-block placement at the end.** Argued above as an improvement.
   If any surface depends on `## Sources` preceding `## Evidence not available
   from the index` in document order, that ordering is preserved among the
   reserved blocks themselves, but their position relative to analytic sections
   changes.

## Non-goals

- A1 (devil's-advocate mode) and A2 (agent personas) — the remaining S1
  answer-quality items. Unblocked by A0, untouched here.
- Changing what any disclosure *says*. This work protects existing text; it does
  not rewrite, soften or extend it.
- A general refactor of `render.ts`.

## Delivery

**PR 1 — structural layer.** Shared heading parser extraction, reserved
registry, splice / strip / reassemble, fail-closed round-trip check, new
provenance variant, anti-inertness tests, docs. Closes both 0.86 ceilings, every
truncation count, and the `ownership` accountability disclaimer across all
fourteen kinds.

**PR 2 — phrase layer.** `brief-disclosures.ts`, derived requirements for the
seven interleaved sites, red-proved per constant, docs.

Each ships independently and each improves coverage on its own; PR 1 is not
blocked on PR 2 being right.
