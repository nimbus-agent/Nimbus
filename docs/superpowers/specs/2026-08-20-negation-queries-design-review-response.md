# Design Review Response: negation queries (W6-B.1)

Response to [`2026-08-20-negation-queries-design-review.md`](./2026-08-20-negation-queries-design-review.md).
Every item checked against the tree on 2026-08-20 before being accepted or declined.

**Outcome:** 4 accepted, 1 accepted-in-part. The headline finding is correct and it invalidated the
CLI syntax on the spec's own first page — the third example as written could not have run.

| # | Item | Outcome | Spec change |
| --- | --- | --- | --- |
| Q2 | `nimbus people` needs a subcommand | **Accepted — the spec was wrong** | § 1, § 4.3 |
| Q2.2 | Also route a leading `--` to `list` | **Declined, with reasoning** | none |
| Q1 | Exit code + refusal streams | **Accepted, sharpened** | § 6 |
| A | Reuse `parseSinceDurationToMs` | **Accepted** | § 4.3 |
| B | `explain` payload shape | **Accepted as the working shape** | § 9 |
| C | Type-scoping validation | **Already specified** | § 4.5, unchanged |

---

## Q2 — `nimbus people --not-reviewed` could not have run. Correct, and it was on page one

Verified: `runPeople` (`packages/cli/src/commands/people.ts:152`) reads `args[0]` as a subcommand
and falls through to `Unknown people subcommand` for anything not in
`list` / `search` / `get` / `items` / `link` (`:179`). So `nimbus people --not-reviewed` resolves
`sub` to the literal string `"--not-reviewed"` and exits 1 without ever reaching a predicate.

That syntax was in the spec's opening example block and in § 4.3. It is now
`nimbus people list --not-reviewed --since 7d`, with a note explaining that the `list` is required
rather than stylistic — `nimbus query` is flag-first and `nimbus people` is subcommand-first, and
the spec follows each surface as it is instead of reshaping one to match the other.

Worth stating plainly: I verified relation directions, a window constant, an emitter line number
and the Tauri method count while writing this spec, and did not verify that its very first command
example parses. The checks I ran were the interesting ones; the one I skipped was the obvious one.

## Q2.2 — routing a leading `--` to `list`: declined

The proposal's second half was: if `args[0]` starts with `--`, default to `list`, preserving the
shorter `nimbus people --not-reviewed`.

Declined. Today `nimbus people --lst` (a typo) produces `Unknown people subcommand: --lst`. Under
the proposal it would route into `list`, where an unrecognised flag is either ignored or produces a
less specific error — so the change trades a precise diagnostic for a cosmetic saving of one word.
It also alters dispatch for EVERY existing `people` invocation, not just the new predicate, which
is a disproportionate blast radius for syntax sugar.

`--help` and `-h` are already special-cased above the dispatch (`:153`), so the ergonomic case that
actually matters is handled.

## Q1 — exit code and refusal streams: accepted, and sharpened

Accepted as proposed: exit code `1`, human-readable remediation to stderr, structured refusal
document to stdout under `--json`. Verified the convention rather than assuming it —
`process.exitCode = 1` is what `people.ts:181` already does for its own error path, so this is the
existing path rather than a new one.

The spec now also records WHY the streams split, because the asymmetry looks arbitrary otherwise:
a refusal is not a result, so it must not reach stdout where a non-`--json` caller might pipe it
into something expecting rows — but under `--json` the refusal IS the document the caller asked
for, and putting it on stderr would leave stdout empty and indistinguishable from a successful
zero-row answer. Those are opposite answers, which is the distinction § 6 exists to protect.

## A — reuse `parseSinceDurationToMs`: accepted

Verified it exists at `packages/cli/src/lib/parse-since.ts:1` and that `nimbus people` parses no
durations today.

Recorded in § 4.3 with the reason, not just the instruction: two duration parsers that disagree
about `7d` would be a silent correctness bug spanning two commands, and the second one would look
correct in isolation.

## B — `explain` payload shape: accepted as the working shape

`{ sql, params, substrate: { probeSql, passed, rowCount } }` is a good shape — `probeSql` in
particular is the part that makes a refusal auditable rather than merely stated.

Recorded in § 9 as the shape the plan implements, with one instruction attached: check
`index.queryItems`'s existing response envelope first and match a house shape if one exists. This
spec should not invent a response convention where the method already has one.

## C — type-scoping validation: already specified

Already § 4.5, including the reasoning the review states: without it, `--not-touching 'tests/**'`
across an unscoped index returns every issue, message and commit, all of which trivially satisfy
"does not touch tests/" because they cannot touch anything — a flood of confident false positives
from the feature built to prevent them. No change needed; recorded here so the agreement is
explicit rather than looking like an omission.
