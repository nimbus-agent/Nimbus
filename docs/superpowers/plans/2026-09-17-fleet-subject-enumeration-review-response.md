# Fleet subject enumeration plan — response to review

> Review: `2026-09-17-fleet-subject-enumeration-review.md`. Plan: `2026-09-17-fleet-subject-enumeration.md`.
> Each point checked against the code on the branch. **1 fixed, 1 fixed differently than proposed,
> 1 rejected with a code comment explaining why, 0 deferred.**

| # | Point | Disposition |
|---|---|---|
| 1 | Fall back to the whole label when a symbol label has no ` — ` separator | **Rejected, comment added.** `graph/graph-populator.ts:515` (`syncCodeSymbolGraph`) is the ONLY writer of `symbol` entities (repo-wide grep), and it always writes `"<name> — <file>"`, so a bare label cannot come from production data. If one ever did, the fallback would match the symbol's NAME against a PATH prefix and admit a symbol whose file is unknown into a path-filtered sweep. Excluding it is the honest answer; the reasoning is now a comment in the Task 5 code so the next reader does not "fix" it the same way. |
| 2 | Trim `path_prefix` and treat empty as null | **Fixed differently.** The empty case is real: `""` prefixes every path, so it silently means "no narrowing". It is now REFUSED (`path_prefix must not be empty`), the codebase's posture for a value that cannot mean what its author intended (`digest_min_delta = 0`, `retention_days = 0`). Mapping it to null instead would hide the mistake. Trimming is NOT applied: a repo-relative path may legally contain spaces, and trimming would silently change what the owner asked for. Two parser tests added (empty refused; whitespace preserved); spec § 4 rule 5 updated. |
| 3 | Ensure the `oldestInWindow` query is subject-scoped | **Fixed.** The plan said "all three" in prose; the method is now written out in full in Task 2, and a dedicated **(red-prove)** store test pins the third query — the fallback that only runs when nothing precedes the window, and so the one no other test reaches. Without it, subject `a`'s predecessor would silently be subject `b`'s brief. |

## A correction to the review's summary

The executive summary says config-named jobs stay byte-identical "in Markdown and JSON". Per spec § 8.1
as corrected at plan time, that holds for the Markdown and for each per-job `FleetJobDigest` object,
but the top-level digest JSON gains a `sweeps` key, so the whole response is additive rather than
identical. Nothing in the plan relies on the stronger reading.
