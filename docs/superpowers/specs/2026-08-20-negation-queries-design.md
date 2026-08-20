# First-class negation queries (W6-B.1) — design

**Date:** 2026-08-20
**Status:** Design approved, not yet implemented.
**Relationship to other work:** sub-project **B.1** of W6-B, the last open Wave 6 row. Built on the
PR changed-file index (**V55**, shipped 2026-08-20 as #1258). **B.2 — exposing these predicates to
`nimbus ask`** is a separate spec built on this one; see § 8.

---

## 1. What this is

Three negation predicates, one per example the roadmap row names, each on the command whose row
shape it already matches:

```text
nimbus query --service github --type pr         --not-touching 'tests/**'
nimbus query --service github --type deployment --no-downstream-incident
nimbus people list --not-reviewed --since 7d
```

**`--service` is required on the first two, and that is existing behaviour, not a choice this spec
makes.** `runQuery` throws `Missing --service (or use --sql for guarded SELECT)` when it is absent
(`packages/cli/src/commands/query.ts:44-46`), and `params.services` is a single-element array.
Cross-service negation ("PRs in ANY service that don't touch tests") would mean relaxing that
requirement for every `query` invocation, which is a change to an existing surface and out of scope
here — recorded as a follow-up rather than smuggled in.

**Note the `list` on the third line — it is required, not stylistic.** `runPeople`
(`packages/cli/src/commands/people.ts:152`) dispatches on `args[0]` as a SUBCOMMAND, so
`nimbus people --not-reviewed` resolves `sub` to `"--not-reviewed"` and exits with "Unknown people
subcommand". `nimbus query` is flag-first and `nimbus people` is subcommand-first; the two surfaces
genuinely differ and this spec follows each as it is rather than reshaping one to match the other.

Plus `--explain`, which shows the SQL that ran.

There is no predicate language. The roadmap's own 2026-08-16 correction records that "the
structured index already handles negation natively" is true only of raw SQL, and that shipping
`--negate` means **inventing** a grammar. This spec does not invent one: three named flags, no
parser, no precedence rules, no expression syntax.

---

## 2. Why a negation is not just a filter with a NOT in it

This is the constraint the design is shaped around, inherited from the PR changed-file work and
now general.

For a positive query — *"PRs that touch `src/auth/`"* — a missing row costs a result. The answer is
short and a gap note describes the shortfall.

For a negation — *"PRs that **don't** touch `src/auth/`"* — a missing row **produces** a result. A
PR whose file list was never fetched satisfies "no row with that path" exactly as well as a PR that
genuinely never touched it. The two are identical at the SQL level.

So an unpopulated substrate does not make a negation incomplete. It makes it **wrong**, and wrong
in the direction that looks like a finding: the emptier the index, the MORE rows come back.

Everything below follows: every predicate proves its substrate before answering, and anything not
positively verified is excluded or the query refuses.

---

## 3. Decisions taken (recorded so they are not relitigated)

**D1 — three named flags, not a grammar.** A grammar is a parser, a precedence design, an
error-message surface and an injection boundary, and every future predicate would inherit the
substrate problem with no per-predicate place to state it. Three flags each carry their own
honesty story in the one place a reader looks.

**D2 — each predicate lives on the command whose row shape it already matches.** Two of the three
return items and one returns people; `nimbus people` already exists with its own output contract
(`people.list` / `people.search` / `people.items`). Putting all three on `nimbus query` would need
either a `--subject` flag — a grammar in its first stage — or a second result shape inside a
command that returns `IndexedItem[]`. The cost of D2 is that "negation" is not one page in the
docs; that is a documentation job, not an architecture one.

**D3 — a dedicated `nimbus without` command was rejected.** It would duplicate `--service`,
`--since` and `--limit` from two commands, and would split "list PRs" across two places based only
on whether a filter is negative — a seam users trip over repeatedly.

**D4 — empty substrate REFUSES; partial substrate excludes per row.** With zero substrate every
row is unverifiable, so the result set is 100% artifact and a refusal is the honest output. Partial
data still yields a verified subset, which is worth returning with the shortfall named.

**D5 — no query-time window for `--no-downstream-incident`.** See § 4.2. Offering one would imply
a control that does not exist.

---

## 4. The three predicates

All three are the same shape: an anti-join guarded by a substrate check. They differ in what the
substrate is and in whether partial coverage is even representable.

### 4.1 `nimbus query --type pr --not-touching <glob>`

PRs with no indexed changed-file path matching the glob.

Promotes `selectPrsNotTouching` (`prfiles/pr-changed-file-store.ts`, shipped in V55) to a flag. Its
semantics are already specified and red-proved there:

- inner-joins `pr_files_state`, so a PR with no coverage row cannot appear;
- excludes `truncated = 1`, because holding 300 of 4,000 paths cannot verify a negative;
- matches with `GLOB`, never `LIKE` — `LIKE` is case-insensitive and treats `_` as a wildcard, both
  wrong for paths, and both measured.

**This is the only predicate with per-row coverage.** Its gap line reports the two exclusion
reasons SEPARATELY — never fetched, versus fetched incompletely — because they mean different
things to a reader deciding whether to trust the answer.

### 4.2 `nimbus query --type deployment --no-downstream-incident`

Deployments with no outgoing `correlates_with` edge.

**No `--within` flag, and the docs must say why.** `graph/graph-populator.ts` applies a FIXED
`CORRELATION_WINDOW_MS` (currently two hours) at WRITE time, and the edge is always directed
deployment → incident. `graph_relation.created_at` is the write timestamp, not the event time, so a
query-time window cannot be reconstructed even in principle. A `--within 24h` flag would advertise
a control that does not exist and silently mean something else.

The output names the window instead — and **derives it from `CORRELATION_WINDOW_MS` rather than
restating "2h"**. Sub-project A shipped a defect where a constant and its prose drifted; the fix
was deriving one from the other, and the same applies to a number that appears in every result.

### 4.3 `nimbus people list --not-reviewed --since <window>`

People with no outgoing `reviewed` edge newer than the cutoff.

This is the one predicate whose window is genuine: `--since` filters the edges themselves, so it
means what a reader expects. The `reviewed` edge is written by `graph/graph-populator.ts:350` from
PR review activity.

**Lands on the `list` subcommand**, per the note in § 1: `runPeople` dispatches `args[0]` as a
subcommand, so the flags hang off `runPeopleList` and the parameters go on `people.list`.

`--since` is parsed with the EXISTING `parseSinceDurationToMs`
(`packages/cli/src/lib/parse-since.ts:1`), which `nimbus query` already uses. `nimbus people` does
not currently parse durations at all, so this is a reuse, not a second implementation — two
duration parsers that disagree about `7d` would be a silent correctness bug across two commands.

### 4.4 Substrate checks

| Predicate | Empty-substrate probe | Partial handling |
| --- | --- | --- |
| `--not-touching` | any `pr_files_state` row | per-PR: uncovered or truncated → excluded, counted separately |
| `--no-downstream-incident` | any `correlates_with` edge | none — global fact, all-or-nothing |
| `--not-reviewed` | any `reviewed` edge | none — global fact, all-or-nothing |

Two of the three probes are exactly what `agents/_lib/gap-notes.ts`'s `detectMissingRelationEmit`
already does; it is used by `why` and `expert` today and is reused rather than reimplemented.

**The asymmetry is load-bearing and must not be smoothed over.** Only the file predicate has
per-row coverage. For the other two there is no partial state to report, which makes the refusal
the ENTIRE safety mechanism for them rather than a backstop behind per-row exclusion.

### 4.5 Subject-type scoping is mandatory

`--not-touching` requires `--type pr`; `--no-downstream-incident` requires `--type deployment`. A
conflicting `--type` is an error, never a silent re-scope.

Without this, `--not-touching 'tests/**'` across an unscoped index returns every issue, message and
commit — all of which trivially satisfy "does not touch tests/" because they cannot touch anything.
That is a flood of confident false positives emitted by the feature built to prevent them.

---

## 5. `--explain`

**The exclusion accounting is part of the answer, not debug output.** Every negation query always
prints the gap line naming what was excluded and why. Without it a short result set reads as a
finding.

`--explain` adds three things on top: the SQL, its bound parameters, and the substrate probe with
its result. The probe matters because it is the only way to see WHY a query refused, or to confirm
that a non-empty answer rested on real data rather than an empty table.

**It needs an IPC field, not a new method.** The SQL is built gateway-side by `buildItemListSql`,
so `index.queryItems` and the people-side equivalent gain an optional `explain` request flag and an
`explain` block in the response. Adding a field to an existing method leaves `ALLOWED_METHODS` at
**105** and requires no Tauri allowlist change.

**Output contract:**

- Human mode: results, then the gap line, then the explain block under a clear header.
- `--json`: `explain` is a FIELD IN THE DOCUMENT, never loose text. Emitting it alongside the JSON
  would produce an unparseable document — the obvious way to get this wrong.

**`--explain` works on any `query` / `people` invocation, not only negation ones.** The SQL is
already built on every call, so gating it behind the negation flags would be an artificial
conditional, and a flag that works only sometimes is worse than one that always works.

**No redaction obligation.** Bound parameters here are globs, person ids and timestamps; no
Vault-stored value reaches the query builder. Stated explicitly so nobody later assumes otherwise
and adds a redaction pass that implies these values were sensitive.

---

## 6. Refusal contract

When a substrate probe finds nothing:

- **exit code `1`**, set via `process.exitCode = 1` — the convention `runPeople` already uses for
  an unknown subcommand (`people.ts:181`), so this is the existing error path, not a new one;
- human mode: the message and remediation to **stderr**, in the shape `detectMissingRelationEmit`
  already produces;
- `--json` mode: a structured refusal document to **stdout**, so a pipeline can parse it, with
  exit `1` unchanged:

```json
{
  "status": "refused",
  "reason": "missing_substrate",
  "message": "no `reviewed` edges are indexed",
  "remediation": "nimbus index regraph"
}
```

The stream split is deliberate. A refusal is not a result, so it must not land on stdout where a
human's `--json`-less invocation might pipe it into something expecting rows; but under `--json`
the refusal IS the document the caller asked for, and putting it on stderr would leave stdout
empty and indistinguishable from a successful zero-row answer.

The last point is the one worth insisting on. A script asking "which deploys were clean?" must be
able to distinguish **refused** from **none matched** — those are opposite answers, and a non-zero
exit alone does not separate a refusal from a crash.

---

## 7. Testing

- **Every substrate check red-proved by deleting the check** and confirming the test goes red.
  Observing green proves nothing about a guard.
- **A refusal test asserts the REFUSAL** — exit status and structured payload — never merely that
  no rows came back. "Empty result" passes identically when the feature is absent entirely; that is
  the vacuous shape this codebase keeps producing.
- **The type-scoping guard gets its own test**: `--not-touching` without `--type pr` errors rather
  than returning a flood.
- **`--explain --json` is asserted by PARSING the output**, not by string-matching it.
- **The correlation-window claim is pinned to the constant**, so changing `CORRELATION_WINDOW_MS`
  cannot leave the printed text stale.
- Coverage-exclusion behaviour inherits V55's tests, which are already red-proved.
- Coverage floor: every touched file ≥85% line AND ≥80% branch.

---

## 8. Scope boundary — what B.1 does NOT do

**No exposure to `nimbus ask`.** That is **B.2**, and it is a genuinely different problem: tool
specs, which surface (`INDEX_TOOL_SPECS` in `packages/cli/src/mcp/adapter.ts` serves external MCP
clients, while `nimbus ask` runs the gateway engine — "support in ask" could mean either), prompt
wiring, and the failure mode where the model picks the wrong predicate and the answer still reads
as authoritative. Specifying it in a paragraph here would underspecify it.

B.1 is the precondition either way: B.2 has nothing to expose until the predicates and their
fail-closed semantics exist.

**No grammar, no `--negate`, no composition.** Two predicates cannot be combined in one query;
each flag stands alone. If composition is wanted later it is a new design, not an extension of
three independent flags.

**No new schema.** All three read tables and edges that already exist.

---

## 9. Open questions carried into the plan

**Both original open questions are now CLOSED**, answered against the tree during design review and
folded into § 4.3 and § 6:

1. **Exit code and error path** — `process.exitCode = 1`, the convention `people.ts:181` already
   uses; human message to stderr, `--json` refusal document to stdout. See § 6.
2. **`nimbus people` and `--since`** — it parses no durations today, so `--since` reuses
   `parseSinceDurationToMs` from `packages/cli/src/lib/parse-since.ts:1`, and the predicate
   parameters go on `people.list` / `runPeopleList`. See § 4.3.

**The last open item is now closed too.** `index.queryItems` returns
`{ items, meta: { limit, total } }` (`ipc/diagnostics-rpc.ts:355`), so `explain` and the gap
accounting sit BESIDE `items` as sibling keys — `{ items, meta, gaps?, explain? }` — rather than
nested inside `meta`, which holds only counts today. The `explain` block itself keeps the reviewed
shape: `{ sql, params, substrate: { probeSql, passed, rowCount } }`.

**A second syntax defect, found while writing the plan and fixed above.** The first two examples
originally omitted `--service`, which `runQuery` requires. That is the same class of error as the
`nimbus people` subcommand defect this spec's review caught — a command example that cannot run —
and it went unnoticed through the first review because I checked the interesting claims and not
the obvious one. Both are now corrected, and the plan's first task re-runs every example in this
spec against the real argument parsers before anything else is built.

**Verified against the tree while writing and reviewing this spec:** `correlates_with` is always
directed deployment → incident (`graph-populator.ts:898,913`); `CORRELATION_WINDOW_MS` is
`2 * 60 * 60 * 1000` (`:702`); `reviewed` is written at `:350`; `graph_relation` carries
`created_at` as a WRITE timestamp (`index/graph-v7-sql.ts`); `detectMissingRelationEmit` exists at
`agents/_lib/gap-notes.ts:58`; `runPeople` dispatches `args[0]` as a subcommand
(`packages/cli/src/commands/people.ts:152`) with `list` / `search` / `get` / `items` / `link`;
`parseSinceDurationToMs` exists at `packages/cli/src/lib/parse-since.ts:1`;
`ALLOWED_METHODS.len()` asserts **105** at `packages/ui/src-tauri/src/gateway_bridge.rs:594`.

**Verified against the tree while writing this spec:** `correlates_with` is always directed
deployment → incident (`graph-populator.ts:898,913`); `CORRELATION_WINDOW_MS` is
`2 * 60 * 60 * 1000` (`:702`); `reviewed` is written at `:350`; `graph_relation` carries
`created_at` as a WRITE timestamp (`index/graph-v7-sql.ts`); `detectMissingRelationEmit` exists at
`agents/_lib/gap-notes.ts:58`; `nimbus people` exists with `people.list` / `people.search` /
`people.items`.
