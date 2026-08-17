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

### Reserved blocks are built at render time, never parsed back out

The renderers already know which text is a reserved block — `renderGaps()`
*constructs* the `## Gaps` section. Rendering that to one flat string and then
recovering it by scanning for `## Gaps` throws away information we held a moment
earlier, and re-deriving it by parsing is strictly weaker than keeping it.

So the two halves are produced by two constructors, neither of which parses:

```ts
type RenderOpts = { readonly omitReserved?: boolean };
type ReservedBlock = { readonly heading: string; readonly markdown: string };

renderExpert(brief)                          // unchanged — full deterministic brief
renderExpert(brief, { omitReserved: true })  // the synthesizable body
reservedBlocksFor(brief)                     // the reserved blocks, from brief data
```

Each of the fourteen `render*` functions already computes `const gaps =
renderGaps(brief.gaps)` and concatenates it; under `omitReserved` it computes
`""` instead. `renderNegotiate` treats its `## Sources` and `## Evidence not
available from the index` blocks the same way. `reservedBlocksFor` calls the
same block builders (`renderGaps`, `renderNegotiateSources`,
`renderNegotiateEvidenceSection`) on the same brief, so the two halves cannot
disagree about content — they are the same functions on the same input.

**Why an optional parameter rather than a `{ body, reserved }` return type.**
Changing the return type of all fourteen renderers would churn seven test files
(`render.test.ts`, `render.why.test.ts`, `render.premortem.test.ts`,
`render.decisions.test.ts`, `synthesize.ownership.test.ts`, `negotiate.test.ts`,
`test/e2e/scenarios/why.e2e.test.ts`) for no behavioural gain. With an optional
parameter the default call is untouched, every existing test keeps passing
unmodified, and the deterministic brief stays byte-identical — which also means
`scripts/agent-brief-shape.snapshot.json` is unaffected.

**Why this and not a heading scan of the rendered markdown.** Brief content is
not trusted markdown. `renderGlossaryEntry` (`render.ts:327`) interpolates
`e.definition` at the start of a line, unindented, and in `snippet` mode that
definition is quoted verbatim from an indexed source — a Slack message, a Notion
page. A definition containing a line `## Gaps` would make a first-match scan
extract the wrong region, and the fail-closed check would then refuse synthesis
for that brief. The disclosure would still be safe (that is what fail-closed
buys), but a user's own indexed content could silently switch synthesis off.
Constructing the blocks at render time removes the class outright rather than
hardening a scan against it — no code-fence tracking, no injected-heading case,
nothing to harden.

A parser is still needed for the two places that genuinely receive untrusted
markdown: stripping hallucinated reserved sections out of the **model's** output,
and the Layer 2 phrase check. Both use the one shared parser extracted from
`brief-contract.ts:40` `sectionBody()`, whose rule took a review round to settle
— a section opens only at exactly `##` and ends at the next heading of the same
or higher level. Writing a second parser is what is being avoided: sibling guards
built on separate copies of the same scan share a blind spot and get fixed in
only one of them.

The `##`-exactly rule also resolves a collision for free: `glossary` renders a
`### Sources` sub-heading (`render.ts:317`) inside a term entry, which must not
be confused with `negotiate`'s reserved `## Sources` section.

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
3. `body = deterministicRender(brief, { omitReserved: true })` and
   `reserved = reservedBlocksFor(brief)`, then the assertion below. On failure,
   return `deterministic` with the new provenance variant and its own footer.
   **No model call is made.**
4. Build the prompt from `body`, not from the full deterministic render.
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
their original relative order.

**This preserves the deterministic layout; it does not change it.** An earlier
draft of this spec claimed `## Sources` sits mid-document and that synthesis
would move it. That was wrong — `renderNegotiate` (`render.ts:995-999`) emits
`sources`, `evidence`, `gaps`, `footer` as the last four elements, and every
other renderer ends `[..., gaps, footer]`. Reserved blocks are already the tail
of every deterministic brief, so appending them at the tail after synthesis
reproduces the same order.

A placeholder-token scheme (emitting `<!-- nimbus-reserved:gaps -->` into the
prompt and substituting it back) was considered to pin exact position, and
rejected. It would make the guarantee depend on a model preserving an opaque
token verbatim, with "append at the end" as the fallback when it does not — so
it buys nothing over appending directly, while adding a failure mode where a
partially-mangled token matches loosely. The layout it would protect is the
layout appending already produces.

### Fail-closed check

Reserved blocks are constructed rather than parsed, so extraction cannot silently
find nothing. What can still go wrong is a renderer that ignores `omitReserved` —
a fifteenth kind whose author missed the flag, or a new disclosure section added
to an existing renderer without routing it through the flag. The guarantee
therefore rests on an assertion, not on trust:

> Before the model is called: if `reservedBlocksFor(brief)` is non-empty, then
> `deterministicRender(brief, { omitReserved: true })` must differ from
> `deterministicRender(brief)`.

If a renderer ignores the flag the two are identical, the assertion fires, and
the reserved content is never handed to the model. If the assertion does not
hold, synthesis is not attempted and the deterministic brief is returned.

Rendering twice costs nothing worth accounting for: all fourteen `render*`
functions are synchronous, pure string builders over an already-materialised
brief object — no database access, no I/O, no async — verified by reading them,
and the second render happens only when synthesis is enabled, immediately before
a network round-trip to a language model.

**This assertion deliberately does not scan `body` for reserved headings.** That
was the earlier formulation, and it would re-import the untrusted-content problem
this design exists to remove: a glossary definition quoting a source that
contains a `## Gaps` line would trip the check and switch synthesis off for that
brief. Comparing two renders of the same brief is a structural check on our own
code with no dependence on what the content happens to say. A heading scan *is*
used in tests, over controlled fixtures, where that objection does not apply.

### Stripping a hallucinated reserved section

The model's output *is* untrusted markdown, so removing a reserved section it
emitted anyway needs the parser. It uses the shared matcher, not a purpose-built
regex.

That matters because the shared matcher is already stricter in the two ways a
fresh regex would try to cover, and looser in the one way that counts.
`normalize()` (`brief-contract.ts:13`) lowercases and collapses whitespace
before comparison, so casing and spacing tolerance come for free. And matching
is a normalized **prefix**, not a full-line equality — so `## Gaps and caveats`
is recognised as a reserved heading and stripped. An end-anchored
`^##\s+Gaps\s*$` regex would miss exactly that, leaving a model-authored
near-miss section standing next to the canonical one, which is the outcome the
strip step exists to prevent.

The parser tracks fenced code blocks (``` and `~~~`) and ignores headings inside
them. That matters here and not in the constructor: a rewrite can legitimately
carry a fenced example containing a `##` line — echoed, for instance, out of a
glossary definition quoted from a source document — and treating it as a section
boundary would strip real content out of the brief.

**Known bound, stated rather than discovered later.** Fence tracking narrows this
but does not close it. The strip step still cannot distinguish an *unfenced*
`## Gaps` the model invented from one it faithfully echoed out of quoted brief
content, so a synthesized brief may drop a fragment of such a quoted definition.
The loss is bounded to quoted body text, never a disclosure — the canonical block
is re-attached either way — and the deterministic brief is unaffected. Accepted
rather than solved: distinguishing the two would require trusting the model to
mark which headings it authored, which is the kind of cooperation this design
declines to depend on everywhere else.

**Demoted headings are deliberately not stripped.** Only `##` opens a section,
matching the rule the contract guard enforces, and for the same asymmetry: a
`### Gaps` the model nested under another section is fabrication of the general
kind, which the synthesis instructions address, whereas widening the strip to
deeper levels would start deleting the sub-structure the end-of-section rule
exists to permit.

### New provenance variant

`SynthesisProvenance` (`synthesize.ts:51`) gains one `attempted: false` case:

```ts
{ attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed" }
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
| negotiate unattributable incidents | `no indexed assignee or resolver` |
| negotiate unattributable decisions | `no indexed author` |
| glossary snippet provenance | `no LLM configured` |
| glossary manual provenance | `not derived from indexed sources` |

Anchors rather than whole sentences because requiring the full text verbatim
would reject legitimate paraphrase and discard the rewrite.

**An anchor must be a phrase that cannot occur unless the disclosure is
present.** An earlier draft used `not necessarily` for the decisions line; that
is ordinary prose, and a rewrite saying "this is not necessarily a problem"
inside `## Decisions` would satisfy the guard while dropping the disclosure —
a false negative in an honesty guard, which is the worst direction to fail. The
two anchors above are drawn from the factual clause of each sentence, which is
also the half that cannot be dropped without losing the meaning.

The anchors deliberately stop short of each sentence's tail, because that tail
is variable: `renderNegotiateDecisions` threads the subject voice through
(`render.ts:849` renders "not necessarily yours" or "not necessarily theirs"
depending on whether `--person` named someone else), so any anchor including it
would be inert for half the briefs.

Heading scoping is a second layer of specificity, not the primary one:
`contractViolations` matches each phrase only within its section, so an
`## Incidents` requirement cannot be satisfied by text under `## Decisions`. The
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
- A rewrite emitting a near-miss heading (`## Gaps and caveats`) → also stripped,
  proving the prefix matcher rather than an end-anchored equality.
- A brief with zero gap notes → no `## Gaps` heading and no empty section.
- **Untrusted content cannot break extraction:** a glossary brief whose
  `definition` contains a literal `## Gaps` line synthesizes normally, and the
  canonical Gaps block appears exactly once. This is the regression test for the
  class that render-time construction removes; it would fail under a
  scan-the-rendered-markdown splitter.
- A renderer that concatenates a reserved section into `body` instead of
  returning it in `reserved` → no model call, deterministic output,
  `reserved_extraction_failed` provenance.
- Empty model output → `empty_result`, not a document consisting only of gaps.

Layer 2:

- Per constant: a rewrite with the anchor deleted → `contract_violation` naming
  that violation; a genuine paraphrase retaining the anchor → accepted.
- **Anchors are not satisfiable by ordinary prose.** A rewrite that drops the
  decisions disclosure but contains "this is not necessarily a problem" under
  `## Decisions` must still fail. This test exists because an earlier draft chose
  `not necessarily` as that anchor, which this input would have satisfied.
- The incidents and decisions requirements are proved independent: satisfying one
  section while dropping the other must fail.

Anti-inertness, for both layers:

- Every `RESERVED_HEADINGS` entry appears in at least one renderer's real
  output. A registry entry citing a heading that never renders is a guard that
  cannot fire.
- Every disclosure constant's full text appears in at least one render output,
  for a fixture that triggers its condition.

Also:

- `scripts/agent-brief-shape.snapshot.json` is expected **not** to change. It
  records `path:type` pairs with values discarded (`scripts/agent-brief-shape.ts`),
  the default deterministic render is byte-identical under this design, and a new
  `reason` string value does not alter the signature. Run the snapshot test to
  confirm rather than regenerating it reflexively — a regenerated snapshot that
  did not need regenerating hides the shape change it exists to catch.
- New files meet the coverage floor (≥85% line, ≥80% branch). That gate is
  CI-Linux-authoritative, so it is verified via `verify:docker`, not locally.

## Invariant I31 — disclosure integrity

**Statement.** A brief that reaches a reader never says less than the
deterministic render promised. Reserved disclosure sections are constructed by
the renderer and re-attached verbatim, never passed through the model; the
interleaved disclosures are checked by anchor before the rewrite is accepted; a
rewrite that drops one is discarded in favour of the deterministic brief; and if
the reserved set cannot be verified against the registry, no rewrite is
attempted at all.

Per the triple rule, three things land in the same commit:

1. **Wiring** — `agents/_lib/synthesize.ts` `synthesize()`, the sole chokepoint
   where a brief's final markdown is produced.
2. **Docs** — a `## I31 — Disclosure integrity` section in
   `docs/SECURITY-INVARIANTS.md` naming the wiring site, the anti-patterns
   (rendering a reserved section into `body`; adding a brief kind without a
   registry entry; an anchor that ordinary prose can satisfy), and the compliance
   recipe.
3. **Test** — a row in `packages/gateway/src/security-invariants.test.ts`.

No static `D`-rule (see open question 1).

**One caretaking item this creates.** `docs/SECURITY-INVARIANTS.md:677` is a
worked example of *how to add an invariant*, and it uses `I31` as its
illustrative next-free number for a hypothetical sub-agent-scope defense. Taking
I31 makes that example wrong. It is renumbered to the next free value in the same
commit — a how-to that names a number already in use is precisely the doc drift
this file exists to prevent.

## Documentation

The narrow coverage is stated in four places, all of which move in the same
commit as the code that changes it:

- `docs/SECURITY-INVARIANTS.md` — the I29 honesty-guard paragraph loses the
  guard clause (it now belongs to I31) and keeps only the egress claim
- `CLAUDE.md` and `GEMINI.md` — the mirrored I29 bullets, which must stay
  identical, plus a new I31 bullet in each; the roster line "Invariants through
  I30 (I28 reserved)" becomes I31
- `docs/roadmap.md:918` — the A0 delivered entry
- `docs/CHANGELOG.md` — dated entry

## Open questions for review

1. **Invariant placement — resolved: `I31`, runtime enforcement test, no static
   `D`-rule.** The honesty guard was a clause inside I29, the *egress* invariant.
   It is not about egress; it is about what a brief may stop saying, and it has
   the shape an invariant wants — a single chokepoint (`synthesize()`), a
   fail-closed posture, and an enforcement test that can fail. It becomes its own
   invariant. See *Invariant I31* below for what that entails.

   A static `D`-rule confining the reserved registry and contract check to the
   synthesis chokepoint was considered and deliberately not taken: there is one
   brief-emitting path today, so the rule would guard a risk that does not exist
   yet, and this repo's `D`-rules are source scans whose blind spots have needed
   widening more than once. Add one if a second emitter ever appears.
2. **Glossary list-mode `— authored` suffix** (`render.ts:345`) — **deferred, and
   recorded as a known bound rather than dropped.** Review recommended treating
   it as a Layer 2 disclosure. It is a provenance label of the same family as the
   term-mode lines, so the argument is sound in kind. What makes it a poor fit
   for this pass is mechanical: in `list` mode the enclosing heading is
   `# Glossary` (`render.ts:360`), a level-1 heading, and every scoping mechanism
   in this design keys on a `##` section — the `##`-exactly rule that keeps
   `### Sources` from colliding with `## Sources`. Guarding a list-mode row would
   need either a document-scoped requirement (no heading at all, weakening the
   specificity Layer 2 rests on) or a parser change that nothing else in the
   design needs. Weighed against a per-row label whose loss degrades a brief far
   less than a dropped confidence ceiling, it is not worth widening the parser
   for. Revisit in PR 2 if the parser grows level-1 support for another reason.
3. **Reserved-block placement — resolved, no longer open.** The premise was
   wrong: reserved sections are already the tail of every deterministic brief
   (`render.ts:995-999`), so appending them reproduces the existing order rather
   than changing it. See *Placement of reserved blocks*.

## Non-goals

- A1 (devil's-advocate mode) and A2 (agent personas) — the remaining S1
  answer-quality items. Unblocked by A0, untouched here.
- Changing what any disclosure *says*. This work protects existing text; it does
  not rewrite, soften or extend it.
- A general refactor of `render.ts`.

## Delivery

**PR 1 — structural layer.** The `omitReserved` render option across the
fourteen `render*` functions; `reservedBlocksFor` and the reserved registry;
shared parser extraction for the strip step; strip / reassemble; the fail-closed
assertion; new provenance variant; anti-inertness tests; docs. Closes both 0.86
ceilings, every truncation count, and the `ownership` accountability disclaimer
across all fourteen kinds. Carries invariant **I31** — its
`docs/SECURITY-INVARIANTS.md` section, its `security-invariants.test.ts` row, the
mirrored `CLAUDE.md` / `GEMINI.md` bullets and roster-line bump, and the
renumbering of the worked example at `SECURITY-INVARIANTS.md:677`.

Threading `omitReserved` through every `render*` function is the largest single
piece of PR 1, but it is mechanical: each already computes its gaps block
separately and concatenates it at the end. No existing call site or test changes.

**PR 2 — phrase layer.** `brief-disclosures.ts`, derived requirements for the
seven interleaved sites, red-proved per constant, docs.

Each ships independently and each improves coverage on its own; PR 1 is not
blocked on PR 2 being right.
