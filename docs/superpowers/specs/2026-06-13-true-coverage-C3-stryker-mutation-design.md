# True Coverage — Sub-project C3: StrykerJS mutation-testing harness — Design

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/true-coverage-C3`
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Parent spec:** [`2026-06-13-true-coverage-C-depth-design.md`](./2026-06-13-true-coverage-C-depth-design.md) §5 (C3 sketch) + §11 (runner viability, resolved here). C1 (#596) and C2 (#599) merged.

## 1. Context

Sub-project C (depth) ships as three slices. **C1** (audit-redaction boundary fix) and **C2**
(fast-check property suite + I10 surrogate fix) merged. **C3** wires the second depth dimension —
**mutation testing**: proof that the tests actually *fail* when the code breaks (assertion
strength), which line/branch coverage cannot measure.

C3 is a **dev-only, advisory** harness: never a CI gate, never in the shipped surface, not in the
preflight-gate manifest, no coverage interaction. The first run targets the security core
(`executor.ts` + `tool-output-envelope.ts`), both at 100% line+branch — so any surviving mutant is
a pure assertion-strength signal, not a coverage gap.

## 2. Scope (this PR)

**Harness + security-core baseline.** Wire StrykerJS, run it once over the security core, record the
mutation score as the starting baseline in a contributor doc, and stop there. A multi-subsystem
sweep and a numeric `break` floor are explicitly *later* decisions (parent spec §5).

## 3. Dependencies (resolved 2026-06-13 via `npm view`)

| Package | Pin | Notes |
|---|---|---|
| `@stryker-mutator/core` | `9.6.1` | current 9.x; `engines.node >= 20` (we have v24) |
| `@hughescr/stryker-bun-runner` | `1.2.2` | modified 2026-04-25; peerDep `@stryker-mutator/core ^9.0.0`; `engines.bun >= 1.3.7` (we run 1.3.14) |

Both added as **root `devDependencies`, pinned exact** (no `^`), per the dependency-safety
pre-flight (`nimbus-commands` skill). They never enter any shipped package.

**Command-runner fallback (pre-wired):** the built-in `command` runner ships inside
`@stryker-mutator/core` (no extra dep). It runs an opaque `bun test <scope>` and judges by exit
code (`coverageAnalysis: "off"`). The bun-runner is experimental/single-maintainer; if it
misbehaves on our suite, the committed config switches to `command` — we lose only perTest-coverage
*speed*, never the capability. The plan's first task smoke-tests `bunx stryker run` and decides
which runner the committed config uses.

## 4. Components / files

- **`stryker.conf.json`** (repo root) — `testRunner` = `"bun"` (the bun-runner) or `"command"` (per
  the smoke test); `coverageAnalysis: "perTest"` (bun-runner) or `"off"` (command);
  `thresholds: { high: 80, low: 60, break: null }` (**`break: null` = never fails a build**);
  default `mutate` = the two security-core files; test scope limited to their test files so runs
  stay fast (executor*/tool-output-envelope/security-invariants).
- **`scripts/mutation/run-mutation.ts`** — thin wrapper: with no args, runs the configured
  security-core scope; with `--diff`, computes changed **non-test** `packages/gateway/src/**/*.ts`
  vs `origin/main` and passes them to Stryker as `--mutate` (the per-PR git-diff scoping the parent
  spec calls for). Used by the C3 run itself, so it is not dead code.
- **Root `package.json` scripts:** `"mutation": "stryker run"` and
  `"mutation:diff": "bun scripts/mutation/run-mutation.ts --diff"`.
- **`docs/contributors/mutation-testing.md`** — how to run, the recorded **security-core mutation
  score** (starting baseline), the advisory/not-a-gate policy, the runner-fallback note, and the
  "ratchet / flip `break` to a numeric floor is a later decision" note.
- **`.gitignore`** — add Stryker's `reports/` and `.stryker-tmp/`.

No source change. No test change (unless a surviving mutant reveals a genuine assertion gap, fixed
in-slice — see §6). No CI/workflow change. No preflight-gate manifest entry (so the gate-drift test
stays green). No coverage-baseline interaction.

## 5. The run + baseline

Run the harness on the security core. Record the resulting mutation score (and any notable surviving
mutants) in `docs/contributors/mutation-testing.md` as the starting baseline. **No machine-enforced
baseline file** in C3 — advisory only. If a surviving mutant exposes a real assertion gap on these
100%-covered files, strengthen that test in-slice (the whole point of mutation testing on a
fully-covered substrate).

## 6. CI / gating

**None.** No workflow step, no preflight-gate manifest row, no coverage interaction. `bun run
mutation` / `bun run mutation:diff` are manual local dev tools. A numeric `break` floor per
subsystem is deferred until scores are stable across subsystems (parent spec §5).

## 7. Testing & verification

- **Smoke test first (plan task 1):** `bunx stryker run` on the security-core scope (Node v24
  present → the Stryker-needs-Node landmine is moot). Decides bun-runner vs command-runner.
- Definition of done: **either** runner produces a mutation report on the security core, the score
  is recorded, and `break: null` is confirmed (a deliberately broken test or injected mutant does
  not fail the run).
- Settled-tree `tsc --noEmit` (the wrapper script typechecks); Biome via `bunx biome check` on the
  new script; markdownlint the new docs from inside the worktree (`--fix`).
- Authoritative CI gate on the PR is unchanged (**Unit + Coverage**); C3 adds no gate. The
  windows-2025 cross-platform red is the chronic flake (rerun).
- Confirm the preflight-gate **drift test** still passes (C3 adds no CI gate, so the manifest is
  untouched).

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Experimental bun-runner breaks on our suite | Command-runner fallback pre-wired; DoD = either runner works; runner pinned exact + re-verify on any Bun bump |
| Mutation runs slow | Tight scope (2 files + their tests); `--diff` for per-PR future runs |
| Stryker tries to auto-install plugins / needs a package manager it can't drive | Set `packageManager` appropriately and rely on the already-installed pinned deps; no network install in the run |
| Adding deps/scripts trips an audit (SDK dep-free, preflight-gate drift) | Deps are root devDeps only (no shipped package); no CI gate added → no manifest drift; SDK surface untouched |
| Stryker temp/report dirs pollute the tree | `.gitignore` `reports/` + `.stryker-tmp/` |

## 9. Open questions

- Exact bun-runner config keys (test-file scoping option) — finalized in the plan's smoke-test task
  by reading the runner's README/installed schema.
- Whether the security-core run surfaces a real assertion gap — fixed in-slice if so.
