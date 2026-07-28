# P4b tuning design review — response

Response to [`2026-07-27-p4b-ci-tuning-design-review.md`](./2026-07-27-p4b-ci-tuning-design-review.md).

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | No automation stops a Linux-only gate gaining platform code | **Fixed** — but by inverting the proposed mechanism, which would not have worked |
| 2 | Direct pushes to `main` bypass PR validation before E2E burns | **Deferred on measured data**, and the suggested alternative does not exist |
| 3 | Regenerate the baseline inside the PR to avoid warning noise | **Concern valid, proposed timing is a no-op** — corrected with the real trigger |

---

## 1. PAL-regression automation — fixed

The finding is right, and it names the same failure mode the measurement slice
had to guard: an assumption that decays **silently**. If a Linux-only gate's
code later gains `process.platform` branching, coverage on Windows and macOS
quietly stops watching it, no check fails, and the loss is invisible until
someone re-derives the classification by hand.

### The proposed mechanism does not survive contact with the code

The suggestion is to scan the 18 Linux-only gates' directories for platform
branching. Two problems:

- **The scripts name test paths, not source paths.** `test:coverage:db` runs
  `packages/gateway/test/unit/db`; the source it actually covers
  (`packages/gateway/src/db`) is never named. Coverage is measured over files
  *loaded at runtime*, including transitive imports, which no directory scan can
  enumerate statically.
- **Tests legitimately branch on platform.** Cross-platform tests routinely
  check `process.platform`. Scanning the named directories would flag them,
  producing exactly the false-positive noise that trains people to ignore a gate.

### What ships instead: confinement, not scanning

Inverted to match the D10–D22 pattern this repo already uses for tool ids and
dispatch sites — enumerate the population, confine it to an allowlist:

1. Enumerate every source file that branches on platform (`process.platform`,
   `os.platform()`) or imports an OS-named module (`win32`/`darwin`/`linux`).
2. Require each to appear in a checked-in allowlist entry that declares **which
   coverage gate covers it**.
3. Cross-check that the declared gate carries `pal: true` in the
   `_test-suite.yml` matrix.
4. Require every matrix entry to carry an **explicit** `pal` field, so a newly
   added gate cannot inherit a silent default.

A new platform-branching file then fails the audit until its author either
refactors it behind the PAL or promotes its gate to `pal: true` — which is
precisely the choice the finding asks to force. No inference, no false
positives.

---

## 2. E2E guard against a TypeScript failure — deferred on data

### The premise is checkable, so it was checked

Of the last 40 commits on `main`, **2 arrived without a PR** — `a91d73ec` and
`7176dd49`, both `ci(cla)` *workflow* commits. Neither touched TypeScript. The
scenario the finding protects against has no observed instance in that window.

The residual risk is narrower than the finding states, but real: two
independently-green PRs merging into a semantic conflict. That is exactly what
CI-on-`main` exists to catch, and it announces itself loudly when it happens.

### The suggested alternative does not exist

> *Configure the workflow to automatically cancel downstream E2E runs if any
> parallel `ci-ts` job fails, or verify that GitHub Action's default behavior
> handles cancellation in this layout cleanly.*

There is nothing to verify. GitHub Actions cannot cancel a job that has no
`needs` relationship to the failing one; `fail-fast` operates **within** a
matrix, not across independent jobs. Removing the edge removes the cancellation
relationship by definition — the two cannot both be had.

### The primary suggestion is not free either

No standalone fast typecheck job exists to depend on. `Static` (execMedian
**4.57 min**) lives *inside* `_test-suite.yml`, and `needs:` on a
reusable-workflow caller is all-or-nothing — the same constraint that motivates
Change B in the first place. Adopting the finding therefore means:

- a **new job duplicating typecheck** on every push, and
- ~3 min of DAG depth added back to E2E (~2 min → ~5 min).

The one cheap standalone candidate was checked and rejected on the facts:
`CI — Structure audit / structure` costs only **0.83 min**, but runs
`audit:boundaries`, `audit:invariants` and `audit:release-please` — it does not
typecheck, so it does not guard what this finding is about.

**Deferred with a trigger:** adopt if a `main` E2E run is ever observed burning
on a TypeScript compile failure. That event is self-reporting, so the deferral
carries no detection cost.

---

## 3. Baseline regeneration — the concern is real, the timing is a no-op

The finding assumes the 36 abandoned coverage keys start warning as soon as the
change lands. They do not, because of how the sampling window works.

`MAX_RUNS_PER_WORKFLOW` is **12**. Immediately after the PR merges, the window
still contains pre-change runs that carry the macOS and Windows coverage jobs,
so those keys keep receiving observations. Therefore:

- **No `stale-baseline-entry` warnings appear at merge time.** The noise is
  delayed, not immediate.
- **Running `--update-baseline` inside the PR is a no-op.**
  `computeUpdatedBaseline` drops only keys *absent from the window*, and they
  are present. It would rewrite `generated_at` and change nothing else.

Manually deleting the 36 keys in the PR is not better: `evaluate` would then see
observations for keys with no baseline entry and report `new-key` for each while
the pre-change runs remain in the window — trading one warning for another.

**What ships instead:** the plan carries an explicit regeneration step whose
trigger is stated in terms of the window rather than the merge —
*regenerate once roughly 12 post-change push runs have accumulated, when the
abandoned keys have aged out of the sampling window.* Until then the gate stays
green and silent, which is the outcome the finding wants.

---

## Net changes to the design

- **New Change C** — `scripts/structure-audit/check-coverage-gate-pal.ts`: the
  platform-branching allowlist, the declared-gate cross-check, and the
  explicit-`pal`-field requirement. Wired into `audit:*` alongside the other
  static checks.
- **Change A** — every matrix entry carries an explicit `pal` field
  (`true`/`false`), not just the PAL ones. (This response said "six" when
  written; the later plan review found a seventh, `Doctor` — see
  [the plan review response](../plans/2026-07-28-p4b-ci-tuning-review-response.md).)
- **Verification** — the baseline regeneration step gains its window-based
  trigger.
- **Unchanged** — Change B ships as designed; the deferral in finding 2 is
  recorded in the design's Risks table with its trigger.
