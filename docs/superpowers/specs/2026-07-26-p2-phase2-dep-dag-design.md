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
| `npmLatest(pkg)` | `GET https://registry.npmjs.org/<pkg>` | **New network dependency** — Phase 1 was `gh`-only; 5s timeout |
| `selectTaggedRelease(releases, pattern)` | `gh api repos/<repo>/releases` | pure; skips drafts + prereleases |
| `resolvedFromBunLock(text, pkg)` | `gh api .../contents/<lockfile>` | pure; resolutions section only |
| `matchesBumpPr(prs, pkg)` | `gh pr list --json title,headRefName` | pure; mirrors the winget rule |

`npmLatest` fetches the **full** registry document, not `/<pkg>/latest`. The
`/latest` endpoint omits `time`, and the grace rule needs the publish
timestamp; the full doc carries both `dist-tags.latest` and `time[<version>]`
in one request (~48 KB, verified 2026-07-26). It returns
`{ version, publishedAt } | null` — `null` on any transport or shape failure,
which the evaluator maps to `indeterminate`.

**Timeout is mandatory.** The request carries
`AbortSignal.timeout(5000)`, and any non-200 status, timeout, or malformed body
resolves to `null` → `indeterminate` with a message naming the cause. The
registry is the one dependency in this gate that is neither GitHub nor local,
so an unbounded `fetch` would let a slow registry hang the sweep job — and the
gate is runnable locally, where a hang is worse than a red.

`hasOpenBumpPr` does **not** rely on GitHub's search-query semantics. It lists
open PRs with `gh pr list --repo <repo> --state open --json title,headRefName
--limit 100` and matches in memory, case-insensitively, against both the title
and the branch name, accepting either the full package name
(`@nimbus-dev/sdk`) or its short name (`sdk`). Dependabot, Renovate and humans
all title bump PRs differently ("Bump @nimbus-dev/sdk from 1.5.0 to 1.6.0",
"chore(deps): upgrade sdk"), and `--search` would make the gate's behaviour
depend on an opaque relevance ranker. Matching locally also makes the predicate
a **pure function** over `{title, headRefName}[]`, so every naming variant is
table-testable without network.

### `resolvedFromBunLock` — parse the resolutions section, scoped to our own workspaces

A `bun.lock` (Bun v1.2+, JSON) has **two** sections that both mention a package,
and only one of them carries a resolved version:

```text
workspaces: { "packages/cli": { name, dependencies: { "@nimbus-dev/sdk": "^1.5.0" } } }
                                                       └─ a RANGE, never parse this
"@nimbus-dev/sdk":                    ["@nimbus-dev/sdk@1.6.0", "", {}, "sha512-…"]
"nimbus-mcp-github/@nimbus-dev/sdk":  ["@nimbus-dev/sdk@1.4.0", …]
"@nimbus-dev/client/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.3.0", …]
 └─ resolution keys; the version lives in element [0] as "<name>@<version>"
```

The reader parses **only** the resolution entries — element `[0]` of each array
value — never the workspace `dependencies` maps. A range and a resolution are
both `"@nimbus-dev/sdk"`-keyed, so a scan that is not section-aware will happily
return `^1.5.0` and compare a caret string as a version.

**Which resolution entries count.** Not all of them. A resolution key is a
dependency *path*: an unprefixed key is the hoisted copy, and `<prefix>/<pkg>`
is the copy `<prefix>` resolved. Some prefixes are the repo's **own
workspaces** (`nimbus-mcp-github/…`), and some are **third-party packages that
happen to bundle the same dep** (`@nimbus-dev/client/@nimbus-dev/sdk`).

Only the first kind is this edge's business. In this monorepo today the hoisted
`@nimbus-dev/sdk` is `1.6.0` while the copy nested under the external
`@nimbus-dev/client` is `1.3.0` — reporting `1.3.0` as "Nimbus's resolved sdk"
would be wrong, since no Nimbus code resolves it. Conversely the ~100
connector workspaces really did sit at `1.4.0` under a hoisted `1.5.0` earlier
on 2026-07-26, and that *is* this edge's business.

So the rule is: **the minimum over the hoisted entry plus every entry whose
prefix is one of the consumer's own workspace names.** Workspace names are
derivable from the same file — `Object.values(lock.workspaces).map(w => w.name)`
— so no extra fetch is needed. The oldest version *our* code resolves is the
honest "caught up" signal; the hoisted entry alone would call the tree current
while most of it lagged.

## Failure model

Unchanged from Phase 1, and fail-closed in the same direction:

- npm registry unreachable / non-JSON → `indeterminate` (never `stale`).
- Lockfile read 404 → `absent` → `stale` (the file should exist).
- Any other lockfile/release read failure → `indeterminate` via
  `classifyReadFailure`.
- Package present in the manifest but absent from a consumer's lockfile →
  `indeterminate`, not `ok`: a consumer that no longer depends on the package is
  a manifest error, not a passing edge. **This case must not share a message
  with a failed read.** When the lockfile fetched and parsed cleanly and simply
  contains no entry for the package, the detail reads
  `manifest error: <repo> does not depend on <pkg> — remove this consumer from
  release-train.json`, so the operator edits the manifest instead of chasing a
  network or parse fault. A read failure keeps the transient wording.

  The **verdict** stays `indeterminate` rather than becoming a hard failure,
  deliberately: a fifth verdict would ripple through `decideExit` and the strict
  rule for one configuration mistake. The trade-off is real and worth naming —
  unlike a transient, this condition never self-heals, so it warns forever if
  nobody reads warnings. That is mitigated by the wording above and by the
  strict rule (a run with no `ok` edges is red anyway); if a stale manifest
  entry is ever observed surviving more than a sweep or two, promote it to a
  hard failure rather than leaving a permanent warning.
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
- `resolvedFromBunLock` — hoisted entry only; **own-workspace entry lower than
  hoisted → minimum wins**; **a lower version nested under a third-party
  prefix is IGNORED** (the live `@nimbus-dev/client/@nimbus-dev/sdk@1.3.0`
  case); a range in the `workspaces` section is never mistaken for a resolution
  (`"^1.5.0"` must not parse as a version); package absent → `null`.
- `matchesBumpPr` — full-name title match, short-name title match, branch-name
  match, case-insensitive, and a non-match (an unrelated open PR must not count
  as an in-flight bump).
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
