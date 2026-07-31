# `nimbus glossary` — manual term authoring

> **Status:** approved 2026-07-31. Third slice of the glossary. Follow-up to
> [`2026-07-30-nimbus-glossary-design.md`](./2026-07-30-nimbus-glossary-design.md) (shipped as
> PR #981, released in `v1.13.0`) and
> [`2026-07-31-nimbus-glossary-llm-wiring-design.md`](./2026-07-31-nimbus-glossary-llm-wiring-design.md)
> (shipped as PR #987, with the `--refresh` hang closed by #989). Slice of **Spine S1 (Local
> Brain)**.
>
> This document does not restate the base design — read §5, §6 and §12 of the original first. It
> implements the seam §12's last bullet names, and **corrects two claims in that bullet** (§9 below
> lists every statement that becomes false on landing).

## 1. Why now

The base spec deferred manual authoring with an unusually candid note: "the first thing a team does
with a wrong definition is want to fix it." PR #987 made that sharper rather than softer.

Before #987, an unattended definition was a verbatim snippet drawn from the team's own sources. A
bad one was *irrelevant* — visibly a quote that did not answer the question. After #987, unattended
definitions are model-written. A bad one is now wrong in a confident, fluent, plausible-sounding
way, and there is still no way to correct it. `--rebuild` re-derives from the same sources with the
same model; it does not let anyone author.

So the glossary can now be authoritatively wrong, and the only available response is to turn the
feature off.

## 2. What §12 already settled, and what it did not

Settled, and carried forward unchanged:

- A `[glossary.terms]` block in `nimbus.toml`, read by the extraction pass as a pre-pass that
  upserts rows with `definition_source='manual'`.
- On `term_key` collision, **manual wins** over a mined definition.
- Manual rows are exempt from **veto** — a human assertion outranks a doc-frequency floor.

Left open, and decided here:

| Question | Decision | §  |
| --- | --- | --- |
| Config-removal semantics — desired state or seed? | **Desired state**, demote rather than delete, gated on config being definitively read | §5 |
| `--rebuild` interaction | Truncate everything; the pre-pass restores authored rows **in the same transaction** | §6.3 |
| Are manual terms near-miss eligible? | Yes, and preferentially — they head the pool | §7 |
| What do `doc_freq` / `score` mean without mined evidence? | Both are **measured honestly**; ranking policy moves to the read site | §7 |
| Exempt from the reconciliation sweep — exempt from *what*? | Exempt from **demotion and veto only**; statistics are still swept | §6.2 |

## 3. The constraint discovered before anything else: the parser

`nimbus.toml` is not parsed by a TOML library. `config/toml-primitives.ts` is a hand-rolled
line parser, and two of its primitives are wrong in ways that only matter once a config value
carries **prose** — which is exactly what a definition is.

Measured by probe against the shipped primitives, not inferred:

| Input line | Parsed value |
| --- | --- |
| `CDR = "A change data record."` | `A change data record.` ✅ |
| `"change data record" = "The expanded phrase."` | key `change data record` ✅ |
| `sprint = "Tracks the # of open PRs each week."` | **`"Tracks the`** ❌ |
| `quote = "The team calls it the \"waist\"."` | **`The team calls it the \"waist\".`** ❌ |

Two independent defects:

1. **`stripComment` truncates at the first `#` anywhere**, including inside a double-quoted string.
   The remainder of the definition is discarded, and because the closing quote went with it,
   `parseString` no longer recognises the value as quoted and returns it with its **leading quote
   still attached**.
2. **`parseString`'s unescape targets the wrong sequence.** It replaces `\\"` (backslash backslash
   quote) where TOML escapes a quote as `\"`, so an escaped quote keeps its backslashes.

Both fail **silently and open**. Nothing throws, nothing warns: a corrupted definition is written
with `definition_source='manual'` and projected into the searchable index as the authoritative,
human-authored entry. That is strictly worse than a wrong LLM definition, because it carries a
human's authority and the user has no reason to re-read a line they typed correctly.

A `#` in a definition is not exotic — "tracks the # of open PRs", "the #general channel", "issue
\#432" are ordinary glossary prose. So the fix lands **with this slice**, not after it.

**Blast radius, stated rather than minimised.** `stripComment` is shared by `forEachSectionEntry`
and two other section loops, so it is on the read path of roughly twenty config sections. The
change is nonetheless a strict repair rather than a behaviour swap: a `#` outside quotes still
starts a comment, and every value that does not contain a quoted `#` parses identically. It also
fixes a live bug elsewhere — a `[share.http_sink]` URL carrying a `#` fragment is truncated today.
Before changing it, grep the config suites for any test that pins the truncating behaviour; if one
exists it encodes a bug and is corrected with justification, not worked around.

## 4. Configuration surface

Two flat blocks. Both are read by the existing exact-header iterator, so no new parser machinery
is required beyond the repairs in §3.

```toml
[glossary.terms]
CDR = "Our append-only audit row. Tracks the # of writes."
"node.js" = "Pinned to the Bun-compatible LTS line."

[glossary.synonyms]
"change data record" = "CDR"
"change-data record" = "CDR"
```

**Why flat rather than a per-term subsection.** The obvious alternative —
`[glossary.terms.CDR]` with `definition` and `also_known_as` keys — groups a term's attributes
together and extends more naturally. It was rejected because it moves the term into a **table
header**, and a plausible term breaks there: `[glossary.terms.node.js]` is ambiguous between a term
named `node.js` and a nested table, and punctuated terms fare worse. The same term is unambiguous
as a quoted flat key, which the current `splitKeyValue` + `parseString` pair already handles
correctly. Given §3, adding a *second* silent-failure surface to the same slice is the wrong trade.

**Why synonyms are in scope at all.** A mined term gets synonyms from two places: the model's
`alsoKnownAs`, and the deterministic acronym↔expansion detection in `near-miss.ts`. An authored
term gets neither, because there is no model call. Without `[glossary.synonyms]`, an authored `CDR`
is reachable only by its exact key — so the person who encounters "change data record" and does not
yet know the acronym finds nothing. That is the precise backwardness §6 of the base spec exists to
prevent, reintroduced in the authoring path.

Aliases resolve only to **authored** terms in this slice. Pointing an alias at a mined term is a
real capability and a deliberate omission: it would write to a row this slice does not otherwise
own, which puts a mined row inside the desired-state reconciliation of §5. Named here as deferred
rather than half-built.

### 4.1 Parsing rules

- Both keys and values go through `parseString`, so quoting is optional for simple keys and
  required for keys containing spaces, dots or punctuation.
- Term keys normalize through `normalizeTerm` — the same function `agents/glossary.ts` uses to
  resolve a query — so an authored `CDR` is found by `nimbus glossary cdr`.
- `display_term` is the surface form **as written in config**, not the normalized key.
- Skipped, with a warning naming the line's key: an empty definition; a key that normalizes to the
  empty string; an alias whose target is not an authored term; an alias whose own normalized form
  collides with an authored term key, since a term cannot be its own alias and the definition must
  win.
- A duplicate key takes the last occurrence, matching the existing parser's behaviour for every
  other section.

**One resolution subtlety, stated rather than discovered later.** If an alias normalizes to the key
of an existing *mined* term, `resolveTerm` still returns the mined term: it tries `getTerm` (exact)
before `findBySynonym`, and that order is deliberate in the base design. So an alias cannot shadow
a mined term of the same name — the alias is simply never reached for that query. This is the right
precedence (an exact match beats an indirect one) but it means an author who expects an alias to
redirect an existing term gets no effect and no warning, because the collision is with the *index*,
not with the config. Detectable only at pass time, so it is reported in the pass's skipped count
rather than at parse time.

### 4.2 Known limit: definitions are single-line

The parser is line-based. A value cannot span lines, and there is no `"""` block-string support to
add without replacing the parser wholesale. A definition is therefore one line, however long.

This fails more loudly than §3's defects but not loudly enough to ignore: a continuation line is
parsed as its own entry, fails `splitKeyValue` for want of an `=`, and is dropped. The result is a
truncated definition rather than a corrupted one, and no diagnostic. The validation in §4.1 cannot
catch it, because the truncated first line is itself a well-formed value. Stated as a limit.

### 4.3 The `loaded` flag, and why it is the load-bearing detail

`loadTomlSection` catches **every** error — missing file, unreadable file, parse throw — and
returns `structuredClone(fallback)`. Under seed semantics that is harmless. Under the desired-state
semantics of §5 it is catastrophic: "the config parsed to zero authored terms" and "the config
could not be read" arrive as the same value, and the second one would be interpreted as *the user
deleted every term*.

So the terms loader does **not** go through `loadTomlSection`. It returns:

```ts
type ManualTerm = { termKey: string; displayTerm: string; definition: string };

type GlossaryManualConfig =
  | { loaded: false }
  /** `synonyms` maps a normalized alias to the `termKey` it resolves to. */
  | { loaded: true; terms: ManualTerm[]; synonyms: Map<string, string> };
```

`loaded: false` on any read or parse failure. **The removal half of the pre-pass runs only when
`loaded === true`.** The upsert half is a no-op in that state anyway, since there is nothing to
upsert. A machine whose config briefly cannot be read keeps its authored glossary intact and
retries on the next pass.

### 4.4 Config is re-read per pass

`assemble.ts:445` loads `[glossary]` once, at assembly, and the refresher closure captures it — so
a `[glossary]` edit needs a gateway restart today. That is tolerable for `debounce_ms`; it is not
tolerable for the content a user is actively authoring.

The manual config is therefore re-read **on every pass**, which makes `nimbus glossary --refresh`
the apply-my-edits command. The cost is one file read per pass against a file already read at boot.
This requires threading `configDir` into `GlossaryPassOptions`; the numeric `[glossary]` knobs keep
their existing assemble-time load, since re-reading those mid-flight would change a running pass's
own budget.

## 5. Config-removal semantics

**Config is desired state for the `definition_source='manual'` subspace, and only for that
subspace.** A key present in `[glossary.terms]` is upserted; a manual row whose key is no longer
present is **demoted**, not deleted.

Demotion reuses the exact transaction `glossary-reconcile.ts` already runs for a below-floor term:
`unprojectTerm` then `demoteTerm`, which sets `status='pending'` and clears `definition` and
`definition_source`.

The value of demote-over-delete is that the **existing** `selectPendingBatch` filter discriminates
the two interesting cases with no new branch:

```sql
WHERE status = 'pending' AND doc_freq >= :min_doc_freq AND (backoff…)
```

- **The term had real mined evidence.** It clears the floor, re-enters the ordinary consolidation
  queue, and comes back with a mined definition. Removing an override means *reverting to what the
  sources say* — which is what a user deleting an override almost always wants.
- **The term was pure invention** (`doc_freq` below the floor, typically 0). It never clears the
  filter, is never selected, is never projected, and is never offered as a near miss. Effectively
  gone, with an inert tombstone row.

Hard deletion was considered and rejected for a specific reason: `discoverPhase` only scans items
past the watermark, so a deleted term whose evidence predates the watermark would **not** be
re-discovered. Removing an override would silently mean losing the term until `--rebuild` — the
opposite of the first case above. That the pending filter's own comment already cites the
below-floor demotion as its reason for existing is the tell that demotion is the shape this table
was built for.

Seed semantics (config only ever adds) was rejected on asymmetry: editing a definition in config
would apply while deleting one would not, so half of the block would be live state and half
write-once. It also needs a separate removal command regardless, which forfeits the reason for
choosing config in the first place.

## 6. The pipeline

### 6.1 The pre-pass — `glossary/glossary-manual.ts`

A new module, called first inside `runGlossaryPass`, before `discoverPhase`.

```ts
export function applyManualTerms(
  db: Database,
  cfg: GlossaryManualConfig,
  opts: { nowMs: number },
): { added: number; updated: number; removed: number; skipped: number };
```

Per authored term: `computeTermStats` (measured, but **exempt from `min_doc_freq`** — a human may
define a term the sources never mention), then one transaction writing `status='consolidated'`,
`definition_source='manual'`, the definition, the display term, synonyms from `[glossary.synonyms]`,
`near_misses` via `findNearMisses`, and `consolidated_at` / `stats_verified_at`, followed by
`projectTerm`. The single-transaction shape mirrors `consolidatePhase` for the same reason: a crash
between the row write and the projection would strand a `consolidated` row with no searchable item,
and no later sweep repairs that.

Authored rows are written **straight to `consolidated`**. There is nothing to consolidate — the
human already supplied the definition — so they never enter the pending queue, never consume a slot
of `max_new_terms_per_pass`, and never cost a model call. This is what makes §6.3 work.

Removal, per §5, and only when `cfg.loaded === true`.

### 6.2 Two interactions with the existing pass

**Veto and snippet-upgrade exemption is automatic, and deliberately not guarded.**
`selectPendingBatch` filters `status='pending'`; `selectSnippetUpgradeBatch` filters
`definition_source='snippet'`. A manual row is `consolidated` + `manual`, so neither query can
select it, and no code path can therefore veto it. This is asserted by test rather than enforced by
a redundant guard — a guard would imply the queries could reach these rows and obscure the real
reason they cannot.

**The reconciliation sweep is a different story, and §12 is corrected here.** `selectStaleForRecheck`
filters `status='consolidated'`, which *does* include manual rows. §12 says manual rows are "exempt
from the reconciliation sweep". Taken literally that means their `top_sources` freeze permanently:
an authored term keeps citing threads the user deleted months ago, and `nimbus glossary CDR` offers
dead links — the precise failure §5.5 was built to prevent.

So the exemption is narrowed to what it was actually for. In `reconcilePass`, a manual row:

- **is** re-measured and re-projected — `doc_freq`, `service_spread`, `top_sources`,
  `first_seen_at` / `last_seen_at` all self-heal;
- is **never** demoted, whatever its `doc_freq`;
- is **never** vetoed (unreachable anyway, per above).

One `if`. The definition is sacrosanct; only its evidence moves.

**One clobber that must be fixed.** With the pre-pass running first, `upsertCandidate`'s
`ON CONFLICT` refreshes a manual row's statistics when the term is also mined — which is wanted —
but it also writes `display_term = excluded.display_term`, silently replacing the human's chosen
surface form with whichever form mining happened to see. Guarded in the upsert:

```sql
display_term = CASE WHEN definition_source = 'manual'
                    THEN display_term ELSE excluded.display_term END
```

This is easy to miss because every obvious test still passes: the definition survives, the status
survives, the statistics update correctly, and only the casing or spacing of the displayed term
changes. It gets a dedicated test (§10).

### 6.3 `--rebuild`

`rebuildGlossary` currently unprojects every key, calls `clearGlossary`, then runs a pass. Authored
rows would be truncated with everything else and re-read from config on the same pass.

`clearGlossary` keeps meaning *truncate everything* — no special case, and the two tables never
fall out of step. Correctness comes from the pre-pass being unconditional and model-free, and the
window is closed rather than merely made short:

```ts
db.transaction(() => {
  for (const key of listAllKeys(db)) unprojectTerm(db, key);
  clearGlossary(db);
  applyManualTerms(db, cfg, { nowMs });
})();
// then discoverPhase / consolidatePhase as today
```

The state in which an authored term is absent is **never committed**, so it is unobservable to any
reader — not a bounded gap, no gap. The alternative, exempting manual rows from truncation, was
rejected because it makes `clearGlossary` grow a special case every future caller must know about,
and leaves `glossary_pass_state` zeroed while some rows survive.

**The preview is currently wrong about this and must be corrected.** `renderRebuildPreview` prints
"N consolidated terms and M pending candidates would be deleted", drawing its sample from
`agents.glossary` list mode. After §7's ordering change that sample is **headed by the user's own
authored terms** — named as about to be deleted when they are restored within the same call. See
§8.

## 7. Statistics, score and ordering

Authored rows carry **honestly measured** statistics. This is forced rather than chosen: `doc_freq`
is the discriminator in §5's removal path, so a manual row pinned at `doc_freq = 0` would leave even
a well-evidenced term inert on removal.

`score` keeps its single meaning — *strength of mined evidence* — so an authored-but-unattested term
legitimately scores 0. What changes is where ranking policy lives:

```sql
SELECT * FROM glossary_term WHERE status = 'consolidated'
ORDER BY (definition_source = 'manual') DESC, score DESC LIMIT ?
```

One change to `listConsolidated` fixes three things at once, because all three read through it:
list mode in `agents/glossary.ts`, the near-miss pool in that same file, and the near-miss pool in
`glossary-extract.ts`. Authored terms head the list, and — answering §12's open question directly —
they are near-miss **eligible and reachable**, never falling out of the 500-term pool the way a
zero-scored row otherwise would first.

The alternative, giving manual rows a synthetic high score, was rejected because `score` would then
mean two different things depending on the row, and `reconcilePass` recomputes score from statistics
and would silently clobber it.

## 8. Read path and CLI

- `DefinitionSource` widens to `"llm" | "snippet" | "manual"` in `glossary/glossary-types.ts`, and
  the **duplicated literal union** in `agents/_lib/glossary-types.ts:20` widens with it. Both sites
  are required; the second is not derived from the first.
- `agents/_lib/render.ts:295` gains a `manual` branch. The existing snippet branch says the
  definition was quoted verbatim for want of a model; the manual branch states it was authored in
  `nimbus.toml`, so an authored definition is never mistaken for either a quote or a synthesis.
- List mode renders `- **term** — N mention(s)`, which reads oddly at `N = 0`. An authored term with
  no mined evidence is labelled as authored there too.
- `countByStatus` gains `manual` (a **subset** of `total`, not a fourth disjoint bucket — `total`
  counts `consolidated`, which now includes authored rows). It flows to the brief's `stats` through
  the existing `{ ...counts }` spread.
- `renderRebuildPreview` is corrected per §6.3: mined deletions and authored terms are reported
  separately, and the sample filters on `definitionSource`, which `GlossaryEntry` already carries —
  so no new IPC surface is needed for it.

**No new CLI subcommand, and no new IPC method.** The authoring loop is: edit `nimbus.toml`, run
`nimbus glossary --refresh`. Adding `nimbus glossary define` was considered and rejected — it would
make the DB a second authoring surface competing with the file that is meant to be the source of
truth, and would need a TOML *writer*, which this repo does not have.

## 9. Schema — V46

`glossary_term.definition_source` carries `CHECK(definition_source IN ('llm','snippet'))`. SQLite
cannot alter a CHECK in place, and V45 **shipped in `v1.13.0`**, so editing `glossary-v45-sql.ts`
is no longer available — the previous slice did exactly that while V45 was unreleased. This needs a
real V46 that rebuilds the table.

New file `index/glossary-manual-v46-sql.ts`, registered as
`simpleStep(45, 46, "glossary_term.definition_source allows 'manual'", …)` in
`INDEXED_SCHEMA_STEPS`. `applySchemaStep` already wraps the step in a transaction, and the step
shape accepts a SQL array (the V3 step is the precedent).

```sql
CREATE TABLE glossary_term_v46 ( … definition_source TEXT
  CHECK(definition_source IN ('llm','snippet','manual')) … );
INSERT INTO glossary_term_v46 (term_key, display_term, …)
  SELECT term_key, display_term, … FROM glossary_term;
DROP TABLE glossary_term;
ALTER TABLE glossary_term_v46 RENAME TO glossary_term;
-- then the four CREATE INDEX statements, verbatim from V45
```

Notes that matter:

- Columns are **named explicitly** rather than `SELECT *`. The orders match today, but a positional
  copy would silently misalign if V45's column list were ever reordered.
- `DROP TABLE` drops the table's indexes with it, which is why all four are recreated after the
  rename rather than before.
- No foreign key references `glossary_term` in either direction, so the rebuild has no cascade.
- A fresh database runs V45 and then immediately rebuilds it in V46. Slightly wasteful on an empty
  table, and correct — the alternative is editing a released migration.

**The cheap alternative, and why it is rejected.** `ALTER TABLE … ADD COLUMN is_manual INTEGER`
needs no rebuild, and the existing CHECK tolerates `definition_source IS NULL`. But one concept
would then live in two columns that can disagree, and every read site — `toEntry`, the projection
metadata, the renderer, `countSnippetSourced` — would have to know the pairing. §12 named widening
the CHECK, and the honest rebuild is worth its cost once.

## 10. Testing

Coverage gates are unchanged. The plan below is organised by the **specific false-green shapes**
this feature's history has already produced, since a generic "add tests" list has repeatedly not
been enough here.

- **Removal** asserts the row's status *and* the absence of its projected item — never a count.
  (Counted assertions on an ordered collection have already produced one false green.)
- **Collision gets two fixtures, not one.** One where only the definition differs between the mined
  and authored value, one where only the display term does. A single fixture cannot separate two
  ANDed predicates, and the `display_term` clobber of §6.2 is invisible to a fixture where both
  differ together.
- **The `loaded` fail-safe** forces an unreadable config and asserts **nothing was deleted**.
  Red-proved by making the loader report `loaded: true` on failure and confirming the test fails on
  the deletion assertion — not by throwing, and not by hanging.
- **Rebuild atomicity** is asserted from outside the transaction, so an outer transaction cannot
  mask the window.
- **Sweep exemption** seeds a manual row whose `doc_freq` is genuinely below the floor and asserts
  it survives with refreshed statistics. Red-proved by deleting the `if` and confirming a demotion.
- **Veto unreachability** asserts that a manual row is returned by neither `selectPendingBatch` nor
  `selectSnippetUpgradeBatch`, against a fixture where it would otherwise qualify on every other
  predicate.
- **`stripComment`** gets a table-driven test: `#` inside quotes, `#` outside quotes, `#` in a key,
  an escaped quote, a value that is only `#`, and a value with no `#` at all.
- **V46** gets `runner-v46.test.ts` on the `runner-v45.test.ts` precedent, asserting that a row with
  `definition_source='manual'` is rejected before the migration and accepted after, and that
  pre-existing rows and all four indexes survive the rebuild.

Every new test is red-proved: break the code, confirm the failure lands on the intended assertion
for the intended reason, restore, confirm green. A mutation that reddens everything proves nothing,
and neither does one that makes a test hang instead of assert.

## 11. Security invariants

**None.** No new HITL action type, no egress, no HTTP route, no Tauri-exposed method, no Vault key.
The feature reads a local config file and writes local rows, which is the same posture `[glossary]`
already has. Stated explicitly so a later audit does not read the absence as an omission.

Worth noting for completeness: authored text goes into the index but never into a model prompt.
Consolidation is skipped entirely for manual rows, so `wrapToolOutput` / I11 is not on this path.

## 12. Claims that become false on landing

Corrected in the same commit as the code, per the triple rule:

- **Base spec §12, last bullet** — "No manual authoring or correction — deferred, with the seam
  named" becomes shipped. Within that bullet, two statements are corrected rather than merely
  marked done:
  - "manual rows are exempt from the reconciliation sweep" → exempt from **demotion and veto**;
    statistics are still swept (§6.2).
  - "Everything else is additive: no invariant and no read path changes" → the read path **does**
    change: `listConsolidated` gains manual-first ordering, and both `DefinitionSource` unions
    widen (§7, §8).
- **Base spec §12, near-miss bullet** — "Near-miss suggestions consider only the top 500
  consolidated terms" gains the qualifier that authored terms now sort ahead of mined ones and
  therefore cannot be the tail that is dropped.
- **`renderRebuildPreview`'s output text** — currently claims authored terms would be deleted
  (§6.3).
- `docs/architecture.md` schema table (V45 → V46), `CLAUDE.md` and `GEMINI.md` status lines (schema
  V45 → V46), `docs/CHANGELOG.md`, `docs/roadmap.md`, and `docs/cli-reference.md`
  (`[glossary.terms]` / `[glossary.synonyms]` and the edit-then-`--refresh` loop).

Grep targets before claiming this list is complete: `definition_source`, `'llm','snippet'`, `V45`,
`listConsolidated`, `definitionSource`, and §12's bullet text. Read the surrounding prose, not only
the matched line — three of the ten false doc claims corrected in this feature's history were found
only by reading around the grep hit.

## 13. Delivery

One PR. The parser repair (§3) and the migration (§9) are the two pieces with blast radius beyond
the glossary, and both are load-bearing for the feature, so splitting them into a precursor PR
would ship a repair with no consumer and no test that exercises it in anger.

Before pushing: `bun run preflight:fast`, the gateway and CLI glossary suites, the full config suite
(§3's blast radius), and the Docker coverage floor — new source files land under
`packages/gateway/src`.

## 14. Acceptance

- [ ] A term defined in `[glossary.terms]` is returned by `nimbus glossary <term>` after
      `--refresh`, labelled as authored, with no model call made for it.
- [ ] A definition containing `#` and an escaped quote round-trips intact.
- [ ] An alias in `[glossary.synonyms]` resolves to its authored term, and appears in the projected
      body so `nimbus ask` retrieves the term by either surface form.
- [ ] Deleting a term from config demotes it: one with mined evidence re-consolidates from sources;
      one without disappears from the glossary and from near-miss suggestions.
- [ ] An unreadable `nimbus.toml` deletes nothing.
- [ ] An authored definition survives a `--rebuild`, and the rebuild preview does not claim it will
      be deleted.
- [ ] An authored term is never vetoed and never demoted by the reconciliation sweep, while its
      `top_sources` still self-heal when a cited source is deleted.
- [ ] A mined sighting of an authored term refreshes its statistics without changing its definition
      or its display form.
