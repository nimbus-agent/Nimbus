# Monorepo Cleanup Pass — Punch List

**Date:** 2026-05-28
**Drives:** Passes 2–5 of the cleanup branch.

Every commit in passes 2–5 cites the row(s) it resolves by section + line range.

## Sections

1. [Load-bearing comments](punchlist/01-load-bearing-comments.md) — jscpd-blind grep across the tree (277 hits)
2. [Duplication clusters (jscpd)](punchlist/02-duplication-clusters.md) — 493 clones at 4.96% duplication
2b. [Shape duplication (manual)](punchlist/02b-shape-dupes.md) — 161 candidate files across four shape groups
3. [SRP offenders (>500 LOC)](punchlist/03-srp-offenders.md) — 58 files
4. [Open/closed violations](punchlist/04-oc-violations.md) — 61 clusters

## Status convention per row

`[OPEN]` — not yet addressed
`[DOCS]` — migrated to a markdown doc in pass 2
`[DELETE-ONLY]` — captured here; will be stripped in pass 3 with no migration
`[EXTRACTED]` — extracted to a helper in pass 4
`[REFACTORED]` — split/refactored in pass 5
`[N/A]` — false positive; survey heuristic flagged something not worth touching
