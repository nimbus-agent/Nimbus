# P2 Phase 2 — dependency-DAG edges

**Status:** design approved 2026-07-26, not yet implemented.
**Sub-program:** [P2 Release Train](../../infrastructure-roadmap.md) — Phase 1
(channel staleness) shipped 2026-07-26 (#836).
**Phase 1 design:** [`2026-07-24-p2-release-train-design.md`](./2026-07-24-p2-release-train-design.md).

## Problem

Phase 1 answers *"did the release reach its distribution channels?"* for the
gateway. It says nothing about the other propagation graph the org runs: the
npm packages `@nimbus-dev/sdk` and `@nimbus-dev/client`, and the repos that
consume them.

That graph is measurably stale right now (verified live, 2026-07-26):

| Edge | npm `@latest` | consumer resolves | |
| --- | --- | --- | --- |
| `sdk` → `nimbus-client` | 1.6.0 | 1.6.0 | current |
| `sdk` → `nimbus-vscode` | 1.6.0 | 1.5.2 | behind |
| `client` → `nimbus-vscode` | 0.12.1 | 0.11.0 | behind |
| `client` → **Nimbus (CLI)** | 0.12.1 | **0.5.0** | 7 minors behind |

Nothing detected this. The client advanced 0.5 → 0.12 across the narrow-waist
work and its consumers were never bumped. Confirmed as **drift, not a
deliberate pin** (owner, 2026-07-26).

A second, invisible failure mode sits upstream of that: a package can be
**tagged and released on GitHub but never published to npm**. Every consumer
edge then reads green, because npm `@latest` is stale in the same way the
consumers are. This is the npm analogue of the release phantom Phase 1 catches,
and the same class of defect that kept `v0.27.0` unreleased for two days.

## Goal

Extend `audit:release-staleness` so the same gate also fails when:

1. an upstream package is tagged but not published to npm past the grace
   window (**publish phantom**), or
2. a consumer's **actually-resolved** dependency lags npm `@latest` past the
   grace window with no open bump PR (**consumer staleness**).

Non-goal: fixing either. P2 detects; remediation stays manual.

## Architecture

**The engine does not change.** `evaluateTrain`, `decideExit`, `compareSemver`,
`stripV`, `ageHours`, `classifyReadFailure` and the `EdgeResult` vocabulary
(`ok` / `stale` / `phantom` / `indeterminate`) are reused verbatim. Phase 2 adds
a sibling reader + evaluator that emits `EdgeResult[]` into the **same**
`decideExit`, so exit semantics, the strict rule, and the annotation format are
identical by construction.

```text
.github/release-train.json
  trains[]    → Phase 1 readers → evaluateTrain   ─┐
  packages[]  → Phase 2 readers → evaluatePackage ─┴→ decideExit → exit 0|1
```

### Manifest — a new top-level `packages[]`

The Phase 1 sketch proposed adding `dep` entries to `trains[]`. **This design
deviates:** a dep edge's source is an npm dist-tag and its downstreams are
repo+lockfile pairs, so sharing `trains[]` would make nearly every field
optional-and-conditional and push the validation into runtime branching. A
separate key in the same file keeps both shapes total, and `graceHours` stays
shared.

```json
{
  "graceHours": 6,
  "trains": [ /* unchanged, Phase 1 */ ],
  "packages": [
    {
      "name": "sdk",
      "npm": "@nimbus-dev/sdk",
      "repo": "nimbus-agent/nimbus-sdk",
      "tagPattern": "^sdk-v(\\d+\\.\\d+\\.\\d+)$",
      "consumers": [
        { "repo": "nimbus-agent/nimbus-client", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/nimbus-vscode", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/Nimbus", "lockfile": "bun.lock" }
      ]
    },
    {
      "name": "client",
      "npm": "@nimbus-dev/client",
      "repo": "nimbus-agent/nimbus-client",
      "tagPattern": "^client-v(\\d+\\.\\d+\\.\\d+)$",
      "consumers": [
        { "repo": "nimbus-agent/nimbus-vscode", "lockfile": "bun.lock" },
        { "repo": "nimbus-agent/Nimbus", "lockfile": "bun.lock" }
      ]
    }
  ]
}
```

`tagPattern` is **required per package**, not inferred. Upstream tags are
component-prefixed (`sdk-v1.6.0`, `client-v0.12.1`), and Phase 1's
`selectPublished` deliberately filters to `^v\d+\.\d+\.\d+$` — it *skips*
component tags by design. Phase 2 therefore needs its own selector; reusing
Phase 1's would silently match nothing.

## Edges

### `<name>:publish` — tagged but not on npm

- **source:** the highest non-draft, non-prerelease release whose tag matches
  `tagPattern`, on the package's own repo.
- **compare:** that version vs npm `@latest`.
- **verdict:** tag ahead of npm and the *release* older than `graceHours` →
  `phantom`. Equal or npm ahead → `ok`. Within grace → `ok` (publish window).

Gating on the release's age (not "now") mirrors Phase 1's rule that a normal
publish window must never be red.

### `<name>:<consumer-repo>` — consumer lags npm

- **source:** npm `@latest`.
- **downstream:** the version the consumer's **lockfile resolves**, not the
  `package.json` range.
- **verdict:** resolved ≥ npm → `ok`. Resolved < npm **and the npm version was
  published more than `graceHours` ago** → `stale`, **unless** an open PR in
  that repo references the package (an in-flight bump, incl. Dependabot) → `ok`.

Grace is measured from the **npm version's own publish timestamp**, mirroring
Phase 1's rule that a channel is only judged once the release it should carry is
past grace. A package published ten minutes ago must not red every consumer.

**Why the lockfile.** A range can be wrong in both directions. `^1.2.0` *permits*
a newer `1.3.0`, so comparing the range would false-flag a repo that already
resolves to `1.3.0`. Conversely — and this is the live case — **caret on a `0.x`
version pins the minor**: `^0.5.0` cannot resolve past `0.5.x`, so the range is
itself the blocker. The lockfile is the only reading that is honest in both
directions, because it is the code that actually ships.

Note the practical consequence for whoever fixes a red edge: for a `0.x`
package the remedy is a `package.json` bump, not `bun install`. The edge detail
string should say which by comparing the declared range against npm, so the
message is actionable rather than merely true.

## Readers

All reads are public and unauthenticated except GitHub reads, which reuse the
existing `runGh` path.

| Reader | Source | Notes |
| --- | --- | --- |
| `npmLatest(pkg)` | `GET https://registry.npmjs.org/<pkg>` | **New network dependency** — Phase 1 was `gh`-only |
| `selectTaggedRelease(releases, pattern)` | `gh api repos/<repo>/releases` | pure; skips drafts + prereleases |
| `resolvedFromBunLock(text, pkg)` | `gh api .../contents/<lockfile>` | pure |
| `hasOpenBumpPr(repo, pkg)` | `gh pr list --state open --search` | mirrors the winget rule |

`npmLatest` fetches the **full** registry document, not `/<pkg>/latest`. The
`/latest` endpoint omits `time`, and the grace rule needs the publish
timestamp; the full doc carries both `dist-tags.latest` and `time[<version>]`
in one request (~48 KB, verified 2026-07-26). It returns
`{ version, publishedAt } | null` — `null` on any transport or shape failure,
which the evaluator maps to `indeterminate`.

### `resolvedFromBunLock` returns the **minimum**, not the hoisted version

A `bun.lock` can carry the same package at several versions — a hoisted entry
plus per-workspace overrides. This is not hypothetical: on 2026-07-26 this
monorepo held `@nimbus-dev/sdk` hoisted at `1.5.0` while ~100 connector
workspaces pinned `1.4.0` beneath it.

The reader therefore collects every resolved version for the package and returns
the **lowest**. The oldest version that actually ships is the honest "caught up"
signal; reporting the hoisted version would call that tree current when most of
it was two minors behind.

## Failure model

Unchanged from Phase 1, and fail-closed in the same direction:

- npm registry unreachable / non-JSON → `indeterminate` (never `stale`).
- Lockfile read 404 → `absent` → `stale` (the file should exist).
- Any other lockfile/release read failure → `indeterminate` via
  `classifyReadFailure`.
- Package present in the manifest but absent from a consumer's lockfile →
  `indeterminate`, not `ok`: a consumer that no longer depends on the package is
  a manifest error, not a passing edge.
- Unparseable version on either side → `indeterminate` (`compareSemver`
  returns `null`; it never throws).
- Under `--strict`, a run where nothing was evaluable is **red** — a Phase-2
  outage must not read as "all clear".

## Expected outcome on arrival

**RED**, deliberately, matching the Phase 1 precedent (which shipped red and
caught a genuine phantom on its first run):

- `client:Nimbus` — resolved 0.5.0 < 0.12.1 → `stale`
- `client:nimbus-vscode` — resolved 0.11.0 < 0.12.1 → `stale`
- `sdk:nimbus-vscode` — resolved 1.5.2 < 1.6.0 → `stale`
- `sdk:nimbus-client` — 1.6.0 → `ok`
- `sdk:publish`, `client:publish` — tags match npm → `ok`

Remediation (bumping three consumer edges) is **separate work**, tracked but not
in this slice. Shipping the gate red is the red-before evidence; the green-after
comes when those bumps land.

## Testing

Table-driven unit tests over the pure functions, matching Phase 1's file layout
(`check-release-staleness.test.ts`):

- `parseNpmLatest` — valid doc (`dist-tags.latest` + `time`), missing
  `dist-tags`, missing `time` entry, malformed JSON.
- `selectTaggedRelease` — component-prefixed match, drafts/prereleases skipped,
  non-matching tags ignored, highest wins, empty → `null`.
- `resolvedFromBunLock` — single entry; **multiple entries → minimum**; nested
  workspace entries; package absent → `null`.
- `evaluatePackage` — every verdict: publish phantom, publish within grace,
  consumer stale, consumer current, consumer stale-but-PR-open, each
  indeterminate path.
- The committed `.github/release-train.json` parses and declares both packages.

No new coverage-gate wiring: `scripts/` is covered by the existing
`bun test scripts/structure-audit/` run.

## Out of scope

- **Fixing** any red edge — no auto-bump, no PR generation.
- **Non-`bun.lock` formats.** All four repos commit `bun.lock` (verified
  2026-07-26). A future npm/pnpm consumer needs a new reader.
- **An "intentionally pinned" escape hatch.** Every current edge should be
  current; adding an optional `pinned` field later is a one-line manifest
  change, so YAGNI until a real pin exists.
- **Transitive depth.** Only the declared direct edges are checked, not the full
  transitive closure.
- **Registry-side integrity** (provenance, signatures) — already owned by
  `secret-health.yml`'s npm provenance probes.

## Open questions

None. The Phase 1 spec's two deferred questions are both resolved here:

1. **Source for a dep edge** → npm `@latest`, *plus* a separate `:publish` edge
   comparing the upstream git tag to npm. This keeps "consumers are behind" and
   "we never published" as distinct, separately actionable verdicts rather than
   conflating them into one.
2. **Lockfile format per consumer** → all four repos commit `bun.lock`
   (`nimbus-sdk`, `nimbus-client`, `nimbus-vscode`, `Nimbus`; verified live
   2026-07-26), so one reader covers the graph.
