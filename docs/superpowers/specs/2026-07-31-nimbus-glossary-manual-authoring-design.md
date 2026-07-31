# `nimbus glossary` — manual term authoring

> **Status:** approved 2026-07-31. Third slice of the glossary. Follow-up to
> [`2026-07-30-nimbus-glossary-design.md`](./2026-07-30-nimbus-glossary-design.md) (shipped as
> PR #981, released in `v1.13.0`) and
> [`2026-07-31-nimbus-glossary-llm-wiring-design.md`](./2026-07-31-nimbus-glossary-llm-wiring-design.md)
> (shipped as PR #987, with the `--refresh` hang closed by #989). Slice of **Spine S1 (Local
> Brain)**.
>
> This document does not restate the base design — read §5, §6 and §12 of the original first. It
> implements the seam §12's last bullet names, and **corrects two claims in that bullet** (§13
> below lists every statement that becomes false on landing).

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

### 3.1 The repair, specified

`stripComment` is the highest-blast-radius edit in the slice, so the algorithm is pinned here
rather than left to implementation taste.

**A single left-to-right character scan**, not a regex. Track one boolean, `inString`, toggled by an
unescaped `"`. A `#` seen while `inString === false` ends the line; a `#` seen inside a string is
content. A backslash inside a string consumes the next character unconditionally, so `\"` does not
close the string.

A scan is preferred over the regex form `/"([^"\\]|\\.)*"|(#.*)/g` for two reasons: it is directly
readable against the rule above, and it needs no argument about backtracking. (That particular
regex is in fact safe — its two alternatives are disjoint on their first character, so there is no
ambiguity to backtrack through — but "safe after analysis" is a worse property than "trivially
linear" for a primitive on every config read path.)

**The scan runs twice, and this is load-bearing.** Escape-aware scanning is right for
`"he said \"hi\""` but wrong for `path = "C:\dev\"` — there the trailing backslash escapes the
closing quote, so the scan ends inside a string and the line looks malformed. That form is not
strictly valid TOML (which needs `"C:\\dev\\"`), but this parser has always accepted it, and
`[[filesystem.roots]]` — a Windows directory surface, see §3.2 — is exactly where it appears.
Silently dropping a filesystem root silently drops a whole indexed tree.

So: scan once treating `\` as an escape; if that ends inside a string, scan again treating `\` as a
literal character. Both forms survive. Found while making the implementation concrete, 2026-07-31;
a single-pass scanner passes every glossary test and regresses Windows path configs.

**Unterminated quote.** A line whose string never closes **under both scans** —
`key = "unterminated # comment` — is malformed, and the entry is **skipped**, not silently
truncated. Today it yields the value `"unterminated` (leading quote attached), which is the same
silent-corruption class as the `#` bug. Skipping is the fail-closed choice: no definition beats a
mangled one.

**Escape convention.** `stripComment` and `parseString` must agree on what a backslash does, or a
line can strip as though `\"` were an escape and then unquote as though it were not. Both treat
backslash as escaping exactly the next character inside a double-quoted string.

**Single-quoted strings are not supported and stay unsupported.** `parseString` unquotes only
double-quoted values, so a TOML literal string `x = 'a # b'` is already returned with its quotes
attached. The scanner therefore tracks double quotes only, and a `#` inside a single-quoted value
still truncates. Making the scanner single-quote aware without making `parseString` unquote them
would be worse than either — the comment would survive while the quotes did too.

### 3.2 A second copy of both defects

`config/filesystem-toml.ts` carries its **own private `stripComment` and `parseString`**, textually
identical to the shared ones and carrying both bugs. `[[filesystem.roots]]` is a path surface, and a
directory named `#inbox` or `C:\notes\#archive` is entirely ordinary — so the truncation bug is
arguably more reachable there than in the glossary.

Repairing only `toml-primitives.ts` would leave a known-identical bug live in a sibling file that
was edited in the same breath. So `filesystem-toml.ts` **drops its private copies and imports the
shared primitives**. Both helpers are textually identical to the shared versions today, so this is a
deduplication that inherits the fix rather than a second repair, and it removes the drift source
that produced two copies in the first place. It gets its own test — a root path containing `#` must
survive.

### 3.3 What is deliberately NOT fixed: escape decoding

`parseString` gains `\"` → `"` and nothing else. It does **not** learn `\n`, `\t`, `\r` or `\\`.

This is not conservatism, it is a correctness requirement. The shared `parseString` feeds
path-valued config keys — `llamacpp_server_path`, `piper_path`, `piper_model`, `whisper_path`,
`whisper_model`, `wake_word_whisper_model`, `classifier_model` — and on Windows those are ordinary
backslash paths. A full TOML escape decoder would read `C:\tools\new\table.onnx` as `C:` + TAB +
`ools` + NEWLINE + `ew` + TAB + `able.onnx`, silently breaking every Windows install that points at
a local Piper or llama.cpp binary. `\"` is safe to decode because no plausible path contains it.

The cost is that an authored definition cannot embed a newline (§4.2 already limits it to one
line). The correct fix for that is a real TOML parser, not a partial escape decoder bolted to a
primitive that path values also flow through.

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
  other section. **Two *different* raw keys that normalize to the same `term_key`** — `CDR` and
  `Cdr` on separate lines — are also last-wins, but unlike a literal duplicate this is almost
  certainly a mistake rather than an intentional override, so it warns.

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

**The two upserts have deliberately opposite `display_term` policies, and that must stay visible.**
The pre-pass upsert sets `display_term = excluded.display_term` **unconditionally** — an author who
changes `CDR` to `CDRs` in config is explicitly restyling the term, and the same normalized key must
pick that up. The mining upsert does the opposite (§6.2). Written as one rule: *the authored surface
form wins over a mined one, and the most recent authored form wins over an older authored one.*

These are two different SQL statements in two different modules with contradictory-looking clauses,
which is exactly the shape a later cleanup collapses into one shared helper. Both carry a comment
pointing at the other, and the §10 fixtures pin both directions.

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
- **`--refresh` reports skipped config entries.** A config entry rejected by §4.1 — empty
  definition, unresolvable alias, normalized-key collision — is otherwise invisible: the user edits
  `nimbus.toml`, sees a successful pass, and finds their term missing with no explanation. The
  pre-pass already returns `skipped`; it is carried on `GlossaryPassSummary` alongside the existing
  counters and rendered by `renderPassOutcome`, which is already the home for exactly this kind of
  post-pass warning (it prints the no-model-answered warning and the vetoed-terms list today). Each
  skipped entry is named with its reason, capped like `VETOED_TERMS_REPORTED` — a notification, not
  an audit trail.

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
  an escaped quote, a value that is only `#`, a value with no `#` at all, and an unterminated quote
  (which must skip, per §3.1, not truncate).
- **A Windows-style path value survives** — `piper_path = "C:\tools\new\table.onnx"` round-trips
  byte-identical. This is the regression guard for §3.3: it fails the moment someone "completes"
  `parseString` into a full escape decoder.
- **`[[filesystem.roots]]` inherits the repair** — a root path containing `#` survives §3.2's
  deduplication.
- **`display_term` is pinned in both directions**, since the two upserts hold opposite policies
  (§6.1, §6.2): a mined sighting must not overwrite an authored surface form, *and* an edited
  authored surface form must overwrite the stored one. A test for either alone passes against the
  wrong implementation of the other.
- **Skipped config entries reach `--refresh` output** for each §4.1 rejection reason, asserted on
  the rendered lines rather than on the counter alone — a count proves the entry was rejected, not
  that the user was told why.
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

## 12. Known limits and deliberate deferrals

Stated here rather than discovered later.

- **Definitions are single-line** (§4.2), and §3.3 forecloses the obvious workaround: no `\n`
  decoding, because the same primitive carries Windows paths.
- **A single-quoted config value still truncates at `#`** (§3.1). TOML literal strings were never
  supported by this parser.
- **Entries must sit under the flat `[glossary.terms]` / `[glossary.synonyms]` headers.** A dotted
  key under the parent table — `[glossary]` with `terms.CDR = "…"` — is valid TOML that this
  line-based parser cannot see. It is **reported** as a skipped entry rather than silently ignored,
  but it is not read. Full TOML compliance would mean replacing the parser, not extending it.
- **Statistics for an authored term refresh on the sweep's schedule, not every pass.** The pre-pass
  skips a term whose authored content is unchanged, so it does not recompute `doc_freq` /
  `top_sources` on every connector sync — the same reasoning as
  `stats_recheck_cooldown_ms`. A newly-indexed mention therefore reaches an authored term's
  statistics within the sweep's round-robin window rather than immediately.
- **An alias cannot shadow a mined term of the same name** (§4.1) — exact match beats synonym, by
  design, and the collision is with the index rather than the config so it cannot be caught at
  parse time.
- **Aliases resolve only to authored terms** (§4) — aliasing a mined term would pull a mined row
  into §5's desired-state reconciliation, which is a separate decision.
- **Removal leaves an inert tombstone.** A demoted authored term with no mined evidence sits
  `pending` at `doc_freq = 0` forever: below the floor, never selected, never projected, never
  suggested. `--rebuild` clears it (`clearGlossary` truncates unconditionally), and the volume is
  one row per add-then-remove cycle, so storage is not the concern.

  A **purge** was considered and rejected, because no predicate can express it. The obvious one —
  `status='pending' AND doc_freq=0 AND definition_source IS NULL` — also matches every *mined* term
  the §5.5 sweep demoted after its evidence vanished entirely: `demoteTerm` nulls
  `definition_source` for both populations, so after demotion nothing distinguishes them. A purge
  written that way would silently change §5.5's documented "sits pending below the floor" behaviour
  as a side effect. Distinguishing them would need a column recording that a row was once authored,
  which is real schema surface for no user-visible gain.

  The tombstone's one real symptom is **pre-existing and worth recording**: `buildGaps` reports
  `counts.pending` as "candidate term(s) still awaiting consolidation" with the remediation "later
  passes will consolidate them", which is false for any below-floor row. Sweep-demoted mined terms
  already inflate that count today; this slice adds authored removals to the same population, so it
  makes an existing over-count marginally worse rather than introducing it. Fixing it means teaching
  `countByStatus` the `min_doc_freq` floor, which changes mined reporting too and belongs in its own
  change.
- **Skipped config entries surface only on the pass that skipped them** (§8). A user who edits
  `nimbus.toml` and waits for the debounced sync — rather than running `--refresh` — never sees the
  warning. Surfacing it persistently would mean recording pass diagnostics in
  `glossary_pass_state` so `agents/glossary.ts` could raise a `GapNote` from stored state, since the
  agent does not read config. That is a new capability rather than a wiring change, and the person
  editing config is overwhelmingly the person who runs `--refresh` to test the edit. Deferred, with
  the seam named: a `last_pass_skipped` column and a gap note, if real use shows the warning is
  being missed.

## 13. Claims that become false on landing

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

## 14. Delivery

One PR. The parser repair (§3) and the migration (§9) are the two pieces with blast radius beyond
the glossary, and both are load-bearing for the feature, so splitting them into a precursor PR
would ship a repair with no consumer and no test that exercises it in anger.

Before pushing: `bun run preflight:fast`, the gateway and CLI glossary suites, the full config suite
(§3's blast radius), and the Docker coverage floor — new source files land under
`packages/gateway/src`.

## 15. Acceptance

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
