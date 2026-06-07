# True Coverage Program — Design

**Date:** 2026-06-07
**Branch:** `dev/asafgolombek/true-coverage-program`
**Status:** Design — awaiting review
**Owner:** AsafGolombek

## 1. Goal

Raise Nimbus's test coverage to the highest *meaningful* level — "true coverage,"
not a vanity line-percentage. Line coverage is already saturated (per-file 80% floor
met everywhere; only 2 debt files at ~79%), so the headline number cannot move much
and would be gameable if it did. The real gains are in three dimensions line coverage
cannot measure:

1. **Branch (condition) coverage** — every decision path exercised, not just every line.
2. **Mutation score** — proof the tests actually *fail* when the code breaks (assertion strength).
3. **Eliminated blind spots** — the ~40 "structurally untestable" exclusions, shrunk via DI refactors.

This is a 2–3 week effort, split across multiple sessions. Each sub-project below gets
its own spec → plan → implementation cycle; this document is the umbrella plus the full
detailed design for **Sub-project A (the foundation)**, which everything else depends on.

## 2. Validated findings (evidence-grounded)

These were proven by two feasibility spikes that built and *ran* the mechanisms in temp
scratch dirs (not theorized). Full evidence in the session transcript.

- **Bun cannot emit branch coverage natively.** `bun test --coverage` (Bun 1.3.14) emits
  only `DA`/`LF`/`LH`/`FNF`/`FNH` lcov records — **zero `BRDA`/`BRF`/`BRH`**. Confirmed by
  generating real lcov on `client` and `sdk`; upstream Bun issue #7100 is open/unimplemented.
- **c8 / `NODE_V8_COVERAGE` is impossible** — Bun runs on JavaScriptCore, not V8, so there is
  no V8 coverage sink. Dead end.
- **Istanbul *source* instrumentation works under `bun test`** and is the path. The proven
  recipe: a Bun **`[test].preload` onLoad plugin** using **Babel `@babel/preset-typescript` +
  `babel-plugin-istanbul` + `retainLines:true`**. It produced correct `BRDA` lcov with line
  numbers that **exactly match the original `.ts`** (verified against real repo files).
  - Do **not** use the `Bun.Transpiler` → `istanbul-lib-instrument` shortcut: `Bun.Transpiler`
    emits no source map and renumbers lines (1–2 line skew that corrupts lcov/Sonar attribution).
  - Do **not** adopt `bun-plugin-istanbul@1.1.1` (drags in `nyc`, targets `bun build`/Playwright,
    no TS-transpile step). Hand-roll the preload.
- **Perf:** instrumentation fires **once per unique module** (~852 src files, not ~893 test
  files) → measured **+3–10s on the existing ~70s coverage job**. Negligible, and isolated to a
  separate CI job so the dev-loop `bun test` is untouched.
- **Sonar ingests TS branch coverage automatically** once the merged lcov carries `BRDA`
  (`sonar.javascript.lcov.reportPaths` already declares `coverage/lcov.info`). No Sonar config change.
- **Integration is 6 files** and the existing ratchet (`computeBaselineDiff`/`computeUpdatedBaseline`)
  is dimension-agnostic — reused verbatim for the branch axis.
- **fast-check runs natively under Bun** (4.8.0) and **already found a real bug**: a `gh`-token
  variant escaping the credential-redaction regex in `audit/format-audit-payload.ts` (I11/audit
  redaction blind spot). To be verified against the live module and fixed early.

### Solved implementation traps (load-bearing — baked into the plan)

| Trap | Fix |
|---|---|
| `bun test` ignores top-level `preload` in bunfig | Use `[test].preload` or `--preload <abs path>` |
| Per-package `cd $pkg` runs don't see root bunfig | Pass `--preload <REPO_ROOT-anchored abs path>` per package |
| Broad onLoad filter crashes Babel (`_helperCompilationTargets().default is not a function`) | Narrow runtime scope-gate: instrument first-party src only, never `node_modules`/`*.test.*`; import plugin/preset as **direct function refs**, not string names |
| `onLoad` returning `undefined` aborts the run | Always return an object (`{contents: source, loader:'ts'}` for skipped files) |
| Coverage flush | Global `afterAll` from `bun:test` — **not** `process.on('exit'|'beforeExit')` (never fire under `bun test`) |
| `.tsx` returned as `js` loader → `Unexpected <` | Return Bun's `jsx` loader for `.tsx` |
| Windows `SF:` paths use backslashes | Normalize to forward slashes (CI is Linux; matters for local Windows runs) |

## 3. Policy decisions (chosen 2026-06-07)

- **Branch floor = 80%**, matching the line floor (one unified bar). Accept a large day-1
  baseline (most files start below 80% branch); the ratchet forces monotonic improvement.
- **Full depth:** `fast-check` property tests + StrykerJS mutation testing (advisory-first,
  per-PR diff-scoped, ratcheting). Dev-only, pinned deps.
- **Security core → true 100%** line *and* branch, enforced via a per-file targets overlay,
  as a flagship.
- **Scope:** bun-tested packages (`gateway`, `cli`, `sdk`, `client`, `mcp-connectors/*`). UI
  and vscode-extension stay on their separate Vitest branch gates (already `branches=75`).

## 4. Program decomposition

| # | Sub-project | Delivers | Sessions |
|---|---|---|---|
| **A** | Branch-coverage foundation | istanbul preload + lcov reporter, dual line+branch floor gate, CI wiring, baseline reseed | 1 (this spec) |
| **B** | Close branch gaps | Subsystem-by-subsystem branch-gap closing; ratchet the floor toward 80 everywhere | 2…N |
| **C** | Depth: mutation + property-based | fast-check on pure core (+ fix redaction bug); Stryker advisory→ratcheting across security core outward | interleaved |
| **D** | Shrink exclusions | DI-refactor the ~40 exclusion shells; clear the 2 debt files; document genuinely-untestable | wk 2–3 |
| **★** | Flagship: security core → 100% | engine/HITL slice, vault pure, audit redaction, federation query-gate to 100% line+branch, pinned via targets overlay | wk 2–3 |

Each of B/C/D/★ gets its own spec when reached. Only A is fully designed here.

---

## 5. Sub-project A — Branch-coverage foundation (detailed design)

### 5.1 Architecture

A **separate instrumented coverage CI job** produces a merged `coverage/lcov.info` that
carries line **and** branch data, fed into the **existing** `audit:coverage-floor` gate
(now dual-axis) and Sonar. The fast dev-loop `bun test` and the fast PR gate stay
**uninstrumented** — zero added latency on the critical path.

```
bun test (per package, --preload istanbul-register.ts)
  └─ onLoad plugin: Babel preset-typescript + babel-plugin-istanbul (retainLines)
        instruments first-party src only → counters on globalThis.__coverage__
  └─ global afterAll: dump globalThis.__coverage__ → coverage/.nyc-tmp/<pid>.json (raw, idempotent)
        ↓  (once, after ALL per-package runs)
  merge-coverage.ts: glob .nyc-tmp/*.json → istanbul-lib-coverage merge → single coverage/lcov.info
        (SF repo-root-relative + forward-slash; DA + FN + BRDA)
        ↓
  audit:coverage-floor (dual-axis: line ≥80, branch ≥80, ratcheting baseline v2)
        ↓
  SonarCloud (auto-ingests BRDA → TS branch coverage, no config change)
```

### 5.2 New files

- **`scripts/coverage/istanbul-register.ts`** — the Bun `[test].preload` onLoad plugin.
  Registers `Bun.plugin({ name, setup })` with an onLoad `filter: /\.tsx?$/`:
  - Runtime scope-gate: instrument only paths under a first-party package `src/` (and not
    `*.test.*`/`*.spec.*`/`node_modules`); everything else returns `{contents: source, loader}`
    unchanged.
  - Transform via Babel with `presets:[[presetTypescript,{ allExtensions:true, isTSX:<from ext> }]]`,
    `plugins:[[babelPluginIstanbul, { … }]]`, `retainLines:true`, `sourceMaps:'inline'`,
    `babelrc:false`, `configFile:false`, plugin/preset passed as **imported function references**.
  - `sourceMaps:'inline'` keeps test-failure stack traces mapped back to the original `.ts`
    (columns/expression locations shift under instrumentation even with `retainLines`). The
    gate-critical *line* attribution in the lcov comes from `retainLines` (already spike-validated);
    the inline map is for stack-trace DX, checked by §5.7 gate 2.
  - Return `loader:'jsx'` for `.tsx`, else `'js'`.
- **`scripts/coverage/report-coverage.ts`** — second preload registering a global `afterAll`
  that dumps the **raw** `globalThis.__coverage__` to a unique per-process file
  `coverage/.nyc-tmp/<process.pid>.json` (overwrite-idempotent). It does **not** write lcov
  directly — see §5.2.1. Counters accumulate on the shared `globalThis` across all files in a
  single `bun test` invocation, so the last write per pid is the complete map for that package.
- **`scripts/coverage/merge-coverage.ts`** — a standalone post-step (run **once** after all
  per-package `bun test` invocations) that globs `coverage/.nyc-tmp/*.json`, merges them via
  `istanbul-lib-coverage` `createCoverageMap().merge()`, and emits the single `coverage/lcov.info`
  (`istanbul-lib-report` + `istanbul-reports` `lcovonly`), SF paths rewritten repo-root-relative +
  forward-slash normalized (the maps are keyed by absolute path).
- **(optional) `scripts/coverage/instrument-scope.ts`** — shared predicate for "is this a
  first-party src file to instrument," imported by both the plugin and tests.

### 5.2.1 Concurrency-safe aggregation (why temp-JSON + merge)

`bun test` today runs all files of one package in a **single process**, so `globalThis.__coverage__`
is shared and the spike's `onLoad` fired once per unique module. But this gate blocks CI, and Bun
is actively adding test concurrency/sharding, so the design must not depend on single-process
semantics. The robust, industry-standard pattern (how `nyc` works) is: **each process writes a raw
coverage JSON to a unique temp file, and a separate step merges them.** That stays correct whether
`afterAll` fires once or per-file, and whether Bun runs one process or many:

- The per-pid file is **overwrite-idempotent** — repeated `afterAll` fires within one process just
  rewrite the same cumulative map; no double-count, no race on a shared `lcov.info`.
- Cross-package/cross-pid merge uses istanbul's `createCoverageMap().merge()` (union by file, sum
  hits). The floor only cares *covered vs not-covered*, so a summed hit count never misclassifies.
- The per-package `cd $pkg` runs are already separate invocations (separate pids → separate temp
  files), so the merge step replaces the old `sed`-concat of per-package lcovs.

`coverage/.nyc-tmp/` lives under the existing `coverage/` output tree and is wiped at the start of
each coverage run.

### 5.2.2 Pinned dev dependencies

All dev-only (never in the shipped surface), pinned to exact versions, added per the
dependency-safety pre-flight (`nimbus-commands` skill — run it before `bun add`):

- `@babel/core`, `@babel/preset-typescript`, `babel-plugin-istanbul` — the instrumentation transform.
- `istanbul-lib-coverage`, `istanbul-lib-report`, `istanbul-reports` — map merge + lcov emit.

`istanbul-lib-instrument` is **not** used — the Babel-plugin path is the fidelity-safe one (the
`Bun.Transpiler → istanbul-lib-instrument` shortcut skews lines; see §2).

### 5.3 Modified files (the 6)

1. **`scripts/coverage-floor/lcov-parse.ts`** — extend `FileCoverage` with
   `branches`, `branchesHit`, `branchPct`. Parse `BRDA:line,block,branch,taken`: every `BRDA`
   is a branch obligation; `taken === '-' || parseInt(taken) <= 0` ⇒ not covered. Emit
   `branchPct = branches === 0 ? 100 : round(100*branchesHit/branches, 2)` at `end_of_record`.
   Line metrics stay byte-identical. Files with **zero branches are legitimate** (pure constants,
   re-exports, single-expression modules) and correctly yield `branchPct = 100`; they must never
   be flagged. Guard against *silent total branch-data loss* with a **global + canary** check, not
   a per-file one: assert the merged lcov's total `BRF > 0` **and** that a designated branch-heavy
   canary file (e.g. `engine/executor.ts`) reports `BRF ≥ <threshold>`. A per-file
   "`LF>0 && BRF===0`" rule would false-positive on every branchless file — do not use it.
2. **`scripts/coverage-floor/baseline.ts`** — bump to `version: 2`; `Baseline.files` becomes
   `Map<string, { line: number; branch: number }>`; JSON entry `{ min_line_pct, min_branch_pct }`.
   Keep a **v1→v2 read shim** mapping `{min_coverage_pct: x}` → `{line: x, branch: 0}` so old
   baselines load (branch 0 = ratchet-from-zero, never a false regression). Keep
   `computeBaselineDiff` as a **single-axis** pure fn (unchanged signature).
3. **`scripts/coverage-floor/check.ts`** — build **two** actual maps from the parsed lcov
   (line-pct, branch-pct); run `evaluateCheck`/`computeUpdatedBaseline` **per axis**; union
   violations, tag each with `dimension: 'line' | 'branch'` in the `::error` message. Introduce
   `BRANCH_FLOOR_PCT = 80` (separate constant from `FLOOR_PCT`, even though equal today — so the
   two can diverge without code change).
4. **`scripts/coverage-floor/build-lcov.sh`** — add `--preload "${REPO_ROOT}/scripts/coverage/istanbul-register.ts"`
   (+ the reporter preload) to the inner per-package `bun test`. Keep the existing `cd $pkg` +
   `sed 's|^SF:|SF:${pkg}/|'` merge.
5. **`.github/workflows/_test-suite.yml`** — add the same `--preload`(s) to the Linux
   per-package coverage loop **and** the macOS/Windows root invocation. The
   `audit:coverage-floor` step is unchanged (logic widened internally).
6. **`docs/structure-audit/coverage-baseline.json`** — regenerate (v2) from a **CI-Linux**
   merged lcov via `audit:coverage-floor:update-baseline` (download the `coverage-lcov-merged`
   artifact). Expect this to grow substantially (large day-1 branch baseline — by design).

Also: **`scripts/coverage-floor/exclusions.ts`** — unchanged; existing exemptions apply to the
branch axis uniformly. Add the 2 Worker entry-point trees (`embedding-worker.ts`,
`query-guard-worker.ts` + transitive-only-from-worker imports) to exclusions if not already
covered, since they run in a realm the preload can't reach (parity with native coverage — Bun's
native `--coverage` misses them too). **Deferred investigation (Sub-project D):** whether a Bun
`Worker` can inherit instrumentation (a worker-side bootstrap that re-registers the plugin, or a
preload-equivalent for the worker realm). If cheap, instrument the 2 workers; otherwise the
documented exclusion stands as the accepted fallback (the reviewer concurred this is solid).

### 5.4 Baseline migration (atomic)

The `version: 2` bump, the v1→v2 read shim, the updated `baseline.test.ts` cases, and the
regenerated JSON **must land in the same commit** — a half-applied migration fails every PR.

### 5.5 Per-OS / Linux-authoritative handling

`audit:coverage-floor` is Linux-authoritative. Platform-gated files take exactly one branch
per OS, so a single CI-Linux runner's branch pct on multi-OS files tops out well below 100% —
*more* pronounced than line coverage. The baseline is seeded from **CI-Linux lcov only**; local
Windows/macOS branch pct will differ by tens of percent and must never reseed. Existing
platform exclusions already exempt these files.

The line baseline likely needs a **one-time reseed** too: Istanbul's line counting may differ
slightly from Bun-native on a handful of files (multi-statement/type-only lines), so the 2
existing line debt entries could shift. Reseed both axes together from the first CI-Linux
instrumented run.

### 5.6 Testing

- Unit tests for `lcov-parse.ts` BRDA parsing (fixture with mixed taken/`-`/0 → expected
  branchPct), reusing the existing test's BRDA fixture (update its title + add branch assertions).
- Unit tests for `baseline.ts` v2 parse/serialize + the v1→v2 read shim.
- Unit tests for `check.ts` dual-axis violation union + dimension tagging.
- A small fixture-level test that the istanbul preload, run over a known multi-branch sample,
  yields the expected `BRDA` (guards the instrumentation recipe against Bun/Babel upgrades).

### 5.7 Rollout & verification gates (before locking the baseline)

These are explicit go/no-go checks, run on **CI-Linux**, not the Windows dev box:

1. **Aggregation correctness** (§5.2.1) — confirm `globalThis.__coverage__` accumulates across all
   files in an invocation, each per-pid JSON dump is the complete map, and `merge-coverage.ts`
   unions across packages/pids without overwrite or covered/not-covered misclassification. Verify
   the `afterAll` may fire per-file yet stays correct (overwrite-idempotent), and a suite failure
   still leaves a usable partial dump without crashing.
2. **Source-map fidelity on real gateway files** — spot-check `BRDA` line attribution against
   original `.ts` for a handful of non-trivial files (multi-line expressions, ternaries).
3. **Perf** — measure the instrumented job wall-clock on CI-Linux vs the ~70s baseline; confirm
   within the +3–10s expectation.
4. **`mock.module` interaction** — the combined `bun test packages/cli/src` run has known
   Linux-only `mock.module` contamination; re-validate under instrumentation on CI-Linux.

### 5.8 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Babel ESM-interop crash (broad filter) | Narrow runtime scope-gate + direct function refs (mandatory) |
| Wrong preload key → silent 0% instrumentation (false green) | Use `[test].preload`/`--preload`; global+canary `BRF>0` assert (§5.3) |
| Concurrent/multi-process coverage loss or race | Per-pid temp-JSON dump + istanbul merge (§5.2.1); no shared-file writes |
| Worker blind spot | Exempt the 2 worker trees; parity with native coverage; document; defer instrument probe to Sub-project D |
| Branch baseline huge on day 1 | Expected (aggressive policy); ratchet grinds it down over sub-project B |
| Per-OS branch skew | Seed baseline from CI-Linux only; platform files already exempt |
| Istanbul vs Bun line-count drift | Reseed both axes together from first CI-Linux instrumented run |

---

## 6. Sub-project B — Close branch gaps (sketch)

Subsystem-by-subsystem, raise branch coverage and ratchet the baseline up toward 80
everywhere. Naturally parallelizable (independent files) and splittable across sessions.
Prioritize by risk: engine/HITL, vault, federation, connectors' pure mappers first. Each
session: pick a subsystem, add tests for uncovered branches (error paths, guards,
short-circuits), run `audit:coverage-floor:update-baseline` against CI-Linux lcov, commit.
Specced in detail when reached.

## 7. Sub-project C — Depth: mutation + property-based (sketch)

- **Property-based (fast-check, dev-only):** Week 1. Tests for the pure core — `format-audit-payload`
  redaction (**fix the discovered `gh`-token word-boundary gap** after verifying on the live
  module), `tool-output-envelope` escaping, `timing-safe-compare` oracle, vault/connector key
  parsers. Runs natively under `bun test`.
- **Mutation (StrykerJS, dev-only, pinned):** advisory-first (`thresholds.break: null`),
  `mutate` scoped per-PR via `git diff`, on **at-or-above-floor files only**. Runner:
  `@hughescr/stryker-bun-runner` (matches Bun 1.3.14 / Stryker 9.6.1; experimental — pin it).
  Order: security core → engine/HITL → vault pure → query-gate → connector mappers. Record a
  per-subsystem mutation-score baseline that ratchets up; flip `break` to a numeric floor per
  subsystem once stable. Specced in detail when reached.

## 8. Sub-project D — Shrink exclusions (sketch)

Walk the ~40 `exclusions.ts` entries; for each I/O shell where logic can be extracted behind an
injection seam (à la #505 `imap-client`), refactor + test + drop the exclusion. Clear the 2 debt
files (`gmail/history.ts`, `gmail-sync.ts`) over 80%. Document the genuinely-untestable (FFI,
boot orchestrators, workers) with rationale. Specced in detail when reached.

## 9. Flagship — Security core → 100% line + branch (sketch)

Targets: the HITL-decision slice of `engine/executor.ts` (I2–I4), `engine/tool-output-envelope.ts`
(I11), `audit/format-audit-payload.ts`, `util/timing-safe-compare.ts` (I10), `federation/query-gate.ts`
(I17). Drive each to 100% line **and** branch.

**Enforcement mechanism (new):** a per-file **targets overlay** — a small list (e.g. in the
baseline or a sibling `coverage-targets.json`) of files with a *required* pct above the global
floor (here, 100 for both axes). `check.ts` consults the overlay: a targeted file below its
target is a violation regardless of the global floor; reaching 100 is enforced as a non-regression
ceiling. Designed in detail with the flagship spec.

> Note: `timing-safe-compare` — mutation testing can verify functional equality but **cannot**
> verify the constant-time property; that guarantee stays a manual/review invariant.

## 10. Sequencing across sessions

- **Session 1:** Sub-project A (foundation) — land the branch gate, reseed baseline on CI-Linux.
- **Sessions 2–N:** Sub-project B grind (one/few subsystems each), interleaved with Sub-project C
  (fast-check wins first, then Stryker pilot on the security core).
- **Weeks 2–3:** Sub-project D (exclusion-shrink) + the Flagship 100% security core, as branch
  coverage on those files approaches 100 anyway.

## 11. Open questions / verification gates

- Confirm the §5.7 rollout gates on CI-Linux **before** committing the reseeded baseline.
- Decide the exact home for the security-core **targets overlay** (extend `baseline.ts` v2 vs a
  separate `coverage-targets.json`) — resolved in the flagship spec.
- Confirm `@hughescr/stryker-bun-runner` still tracks current Bun/Stryker at the time Sub-project C
  starts (it's experimental) — fall back to the `command` runner on a tiny scope if it has bit-rotted.

## 12. Review dispositions (2026-06-07)

Addressing [the design review](./2026-06-07-true-coverage-program-design-review.md):

1. **Concurrency & `__coverage__` aggregation — FIXED.** The reviewer's premise (Bun forks a
   process per test file) isn't true of Bun's current single-process model — but the suggested
   pattern is the right robust design regardless. Adopted per-pid raw-JSON dump + a dedicated
   `merge-coverage.ts` (§5.1 diagram, §5.2, §5.2.1, §5.7 gate 1, §5.8). Removes all dependence on
   `afterAll`/process-count semantics and future-proofs against Bun test sharding.
2. **Stack-trace / source-map fidelity — FIXED (light).** Added `sourceMaps:'inline'` to the Babel
   config (§5.2) for accurate stack traces. The gate-critical *line* attribution already comes from
   `retainLines` (spike-validated); the inline map is a DX improvement, checked by §5.7 gate 2.
3. **Pinned Babel/istanbul deps — FIXED.** Explicit dev-only, exact-pinned dependency list added
   (§5.2.2) with the dependency-safety pre-flight reference.
4. **Worker instrumentation — DEFERRED (with rationale).** Kept as a documented exclusion (parity
   with native coverage, which also misses workers); the reviewer agreed this is a solid fallback.
   Added a deferred probe in Sub-project D to test whether a worker can inherit the preload (§5.3).
5. **Sanity-check false positives — FIXED.** Replaced the per-file "`LF>0 && BRF===0`" idea with a
   global-total + canary-file `BRF>0` check; branchless files legitimately report `branchPct=100`
   and are never flagged (§5.3, §5.8). Good catch.
