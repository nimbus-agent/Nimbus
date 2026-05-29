# Cleanup Pass 2 — SonarCloud Findings + Deferred Pass-5 SOLID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the SonarCloud quality gate for `asafgolombek_Nimbus` to a clean state — 0 bugs (reliability A), all 18 security hotspots reviewed, the 54 over-complexity functions reduced below the 15-cognitive-complexity threshold, the ~320 mechanical code smells swept, and the residual duplication extracted — while completing the deferred Pass-5 SOLID work the original monorepo-cleanup pass (PR #456) only documented.

**Architecture:** Five workstreams on a single branch (`dev/asafgolombek/cleanup-pass-2`) in `.worktrees/dev/asafgolombek/cleanup-pass-2`. WS-A (bugs) and WS-B (hotspots) are small, high-signal, and land first. WS-C (cognitive complexity) is the meaty refactor and **is** the deferred Pass-5 SRP work — it is executed under the existing test suite (characterization test first where coverage is thin, then extract helpers keeping tests green). WS-D (mechanical smells) is mostly rule-by-rule Biome/codemod sweeps. WS-E (duplication) extends the Pass-4 `_lib`/`shared` helper pattern. Every commit cites the SonarCloud rule id(s) it resolves.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, Biome (lint+format), Bun's test runner, the SonarCloud API (`https://sonarcloud.io/api/...`, project `asafgolombek_Nimbus`, org `asafgolombek`) for before/after metric snapshots.

**Source snapshot (SonarCloud, 2026-05-29):** bugs 3 · vulnerabilities 0 · security_hotspots 18 · code_smells 386 (BLOCKER 3 / CRITICAL 63 / MAJOR 73 / MINOR 247) · duplicated_lines_density 1.4% (80 blocks / 53 files) · sqale_index 2268 min · coverage 91.9% · ncloc 88,127.

---

## Pre-flight conventions (read once)

- All commands run from the worktree root **using PowerShell** (Bash mangles `C:\` paths). Do **not** prefix with `cd`.
- After cloning the worktree, run `bun install` once before any typecheck/test.
- **This is a refactor pass — behavior must not change.** Every task keeps the existing test suite green. Where a function being refactored has thin coverage, **write a characterization test first** (asserts current observable behavior), confirm it passes, then refactor; the test is the safety net.
- **Match the post-Pass-3 house style:** the monorepo-cleanup pass stripped comments tree-wide. New helper files should be comment-light — preserve only tooling pragmas (`@ts-*`, `biome-ignore`), `cross-platform-ok` markers, and JSDoc on `@nimbus-dev/sdk` / `@nimbus-dev/client` published surfaces. Migrate any genuinely load-bearing rationale to `docs/internals/` (the Pass-2 destinations), not inline.
- **Do not regress security invariants I1–I16, the HITL `HITL_REQUIRED` frozen set / `ToolExecutor.gate()`, vault key names, license fields, the audit-chain BLAKE3 format, the Tauri `ALLOWED_METHODS` array, or the OpenAPI surface.** Run `bun run audit:invariants` after any change under `engine/`, `db/`, `connectors/lazy-mesh/`, `ipc/http*`, or `vault/`. Refer to the `nimbus-security-invariants` skill before touching a wiring site.
- **SonarCloud re-evaluates in CI**, not locally. The acceptance signal per workstream is the metric delta on the next analysis (the `sonar-scanner` CI step is `continue-on-error: true`; check the dashboard). Locally, the gate per task is: existing tests green + `bun run typecheck` + `bun run lint`. Capture the metric API snapshot (Task 0.2) before and after.
- Commit after each task. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- The pre-push hook runs `preflight:fast`; if it surfaces the pre-existing `nimbus-vscode` typecheck on a fresh install, build `@nimbus-dev/client` first (`bun run --filter '@nimbus-dev/client' build`) — that resolves it — or push with `NIMBUS_SKIP_PREPUSH=1`.
- **Memories to re-read:** `bun-mock-module-model-ts-leak` (prefer DI over `mock.module` when splitting modules), `pr-cross-platform-combined-test-flakes` + coverage-floor is CI-Linux-authoritative, `bun-test-exit-code-leak`, `ci-cross-platform-matrix-rulesets-trap`.

---

## Phase 0.0 — CI typecheck speed-up + de-flake (land first)

**Why first:** every push during this pass re-runs the per-OS cross-platform matrix. Its gateway entry runs the **whole-workspace** `bun run typecheck`, which includes `@nimbus/docs` (Astro). On the slow macOS runner, Astro's `astro sync` content-type generation trips an internal 60 s Vite-transport timeout and **flakes the whole check** (observed on PR #458 — a re-run passed; not a code bug). The Astro docs site has **no host-specific TypeScript surface**, so typechecking it once per OS is both wasted runner-minutes and the flake source. Landing this first makes the rest of the pass's CI fast and reliable. Because `pull_request` runs the workflow file from the PR's own head, this speed-up takes effect on **this** PR's CI too.

### Task 0.0: Scope `@nimbus/docs` out of the per-OS typecheck + add a retry

**Files:**
- Modify: `package.json` (root — add a filtered typecheck script)
- Modify: `.github/workflows/ci.yml` (the cross-platform matrix `Typecheck (catches host-specific TS quirks)` step, ~line 238)
- Modify: `scripts/lib/preflight-gates.ts` (register the new gate so the drift test passes — see Step 4)

- [ ] **Step 1: Confirm docs typecheck still runs once on Ubuntu**

Read `.github/workflows/_test-suite.yml` — the static-checks job runs `bun run typecheck` (full workspace, incl. `@nimbus/docs`) on Ubuntu (`PR quality — TS/Bun (ubuntu-24.04)`). Confirm that job is unconditional on PRs. This is the single authoritative docs typecheck; the per-OS matrix entry is the redundant one. **If docs typecheck is *only* in the per-OS matrix and nowhere else, STOP** — excluding it would drop coverage; instead just add the retry (Step 3) and skip the filter.

- [ ] **Step 2: Add a filtered root script**

In root `package.json`, next to `"typecheck": "bun run --filter '*' typecheck"`, add:

```json
"typecheck:no-docs": "bun run --filter '*' --filter '!@nimbus/docs' typecheck",
```

- [ ] **Step 3: Rewire the matrix typecheck step (filtered + retry-once)**

In `.github/workflows/ci.yml`, the step at ~238:

```yaml
      - name: Typecheck (catches host-specific TS quirks)
        if: matrix.pkg == 'gateway'
        run: bun run typecheck
```

becomes (keep the `name:` and `if:` **exactly** — the job/check names are ruleset-required, see below):

```yaml
      - name: Typecheck (catches host-specific TS quirks)
        if: matrix.pkg == 'gateway'
        shell: bash
        # @nimbus/docs is excluded here: it has no host-specific TS surface and
        # its astro-sync content-type generation flakes a 60s Vite timeout on slow
        # macOS runners. Full workspace typecheck (incl. docs) still runs once on
        # Ubuntu in _test-suite.yml. Retry-once mirrors the unit-tests step below.
        run: |
          set +e
          for attempt in 1 2; do
            bun run typecheck:no-docs
            code=$?
            if [ "$code" -eq 0 ]; then exit 0; fi
            if [ "$attempt" -eq 2 ]; then echo "Both attempts failed (exit $code)"; exit "$code"; fi
            echo "Attempt $attempt failed (exit $code), retrying in 5 s..."
            sleep 5
          done
```

> **⚠️ Do NOT touch the job name, the `matrix`, or the check names.** `main`'s ruleset requires the 4 expanded cross-platform check names by exact string (memory `ci-cross-platform-matrix-rulesets-trap`). Changing only the `run:` body of an existing step is safe; renaming the job or matrix entry would deadlock the merge gate.

- [ ] **Step 4: Register the new gate command (preflight drift test)**

`scripts/preflight.test.ts` parses every workflow `run:` block and **fails** if a `bun run`/`bunx` invocation is in neither `PREFLIGHT_GATES` nor `CI_ONLY_GATES` (`scripts/lib/preflight-gates.ts`). Adding `bun run typecheck:no-docs` to `ci.yml` triggers this. Add it to `PREFLIGHT_GATES` next to the existing `typecheck` gate (same tier), or — if `typecheck:no-docs` is considered a pure CI-runtime optimization with no separate local value — to `CI_ONLY_GATES` with a comment. Then run `bun test scripts/preflight.test.ts` and confirm it passes.

- [ ] **Step 5: Verify locally**

Run: `bun run typecheck:no-docs` (expect: passes, skips `@nimbus/docs`) and `bun run typecheck` (expect: still passes incl. docs). Then `bun test scripts/preflight.test.ts`.

- [ ] **Step 6: Commit**

```
ci: scope @nimbus/docs out of per-OS typecheck + retry (de-flake macOS)

The cross-platform matrix gateway entry ran whole-workspace typecheck incl.
@nimbus/docs, whose astro-sync flakes a 60s Vite timeout on slow macOS
runners (PR #458). Docs has no host-specific TS surface and still gets a
full typecheck once on Ubuntu (_test-suite.yml). New typecheck:no-docs
script + retry-once. Job/check names unchanged (ruleset-required).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 0 — Baseline

### Task 0.1: Worktree builds green

**Files:** none (smoke test).

- [ ] **Step 1: Install deps** — Run: `bun install`. Expected: succeeds.
- [ ] **Step 2: Baseline static gates** — Run: `bun run preflight:fast`. Expected: all gates pass (this is the green baseline). If the `nimbus-vscode` typecheck fails, run `bun run --filter '@nimbus-dev/client' build` and re-run.
- [ ] **Step 3: Record HEAD** — Run: `git rev-parse HEAD`. Note the SHA for the final PR description (should be `1fd2ab9f` or later).

### Task 0.2: Capture the SonarCloud baseline snapshot

**Files:**
- Create: `docs/superpowers/specs/sonar-baseline-2026-05-29.md`

- [ ] **Step 1: Fetch the measures and save them**

Run (PowerShell-native `Invoke-RestMethod` — no Python/curl dependency):

```powershell
$m = "bugs,vulnerabilities,code_smells,security_hotspots,duplicated_lines_density,duplicated_blocks,duplicated_files,ncloc,sqale_index,sqale_rating,reliability_rating,security_rating,coverage"
(Invoke-RestMethod -Uri "https://sonarcloud.io/api/measures/component?component=asafgolombek_Nimbus&metricKeys=$m").component.measures |
  Sort-Object metric | Format-Table metric, value -AutoSize
```

Paste the table (and the raw JSON, via appending `| ConvertTo-Json -Depth 6` to the same call) into `docs/superpowers/specs/sonar-baseline-2026-05-29.md` under a `## Baseline (before cleanup pass 2)` heading. This is the before-snapshot the final PR cites.

- [ ] **Step 2: Commit**

```
chore(cleanup2): capture SonarCloud baseline snapshot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

### Task 0.3: C toolchain availability (decides whether C.7 is reachable)

**Files:** none (capability probe).

Task C.7 refactors `packages/gateway/src-native/sandbox-helper/main.c`, which can only be *verified* if a C compiler is present. Probe upfront so C.7's reachability is known on day one rather than discovered at the end.

- [ ] **Step 1: Probe for a C compiler**

```powershell
$cc = (Get-Command gcc -ErrorAction SilentlyContinue) ?? (Get-Command clang -ErrorAction SilentlyContinue) ?? (Get-Command cl -ErrorAction SilentlyContinue)
if ($cc) { "C toolchain: $($cc.Source)" } else { "NO C toolchain — Task C.7 will be BLOCKED on this machine" }
```

- [ ] **Step 2: Record the result.** If no compiler is found, note in the scratchpad that **C.7 is BLOCKED** (the `c:S3776` / `c:S134` findings in `main.c` will not be resolvable here — defer C.7 to a machine/CI job with a C toolchain, or hand it to the Linux CI image which has `gcc`). Do not attempt uncompilable C edits. All other workstreams (A, B-TS, C.1–C.6, D, E) are unaffected.

---

## WS-A — Bugs (rule `S2871`, reliability D → A)

`Array.prototype.sort()` called without a compare function on string/object arrays. JS default sort is lexicographic-by-UTF-16-code-unit, which is locale-unsafe and (for non-string elements) coerces to string. Three sites. Fixing all three flips `reliability_rating` from 4.0 (D) to 1.0 (A) — the highest-value, lowest-effort win in this plan.

### Task A.1: Add stable comparators to the three unguarded sorts

**Files:**
- Modify: `packages/cli/src/commands/extension-tree.ts:27`
- Modify: `packages/gateway/src/extensions/dependency-graph.ts:172`
- Modify: `packages/gateway/src/extensions/dependency-graph.ts:186`
- Test: `packages/gateway/src/extensions/dependency-graph.test.ts` (create or extend), `packages/cli/src/commands/extension-tree.test.ts` (create or extend)

- [ ] **Step 1: Read each call site** to learn the element type. For string arrays the fix is `.sort((a, b) => a.localeCompare(b))`; for object arrays sort by a string key, e.g. `.sort((a, b) => a.id.localeCompare(b.id))`.

- [ ] **Step 2: Write a failing/characterization test for each sort's determinism**

For `dependency-graph.ts` (the install-order/closure output is order-sensitive — determinism matters for reproducible installs), add a test asserting the sorted output order for a fixed input set including mixed-case and locale-edge strings (e.g. `["b","A","a","B"]`). For `extension-tree.ts`, assert the displayed child order. Run them; the determinism assertion should pass today only by accident — write the assertion against the **intended** locale order so it pins the fix.

Run: `bun test packages/gateway/src/extensions/dependency-graph.test.ts`
Expected: the new ordering assertion may pass or fail depending on input; the point is to lock intended order.

- [ ] **Step 3: Apply `localeCompare` comparators** at all three sites.

- [ ] **Step 4: Run the tests + the dependency-resolution suite**

Run: `bun run test:coverage:extensions` and `bun test packages/gateway/src/extensions/`
Expected: PASS — closure/install-order tests still green.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck` and `bun run lint`. Expected: both pass.

- [ ] **Step 6: Commit**

```
fix(extensions,cli): stable locale-aware sort comparators (Sonar S2871)

Three Array.sort() calls lacked a compare function — locale-unsafe and
(for object arrays) string-coercing. dependency-graph closure ordering is
install-reproducibility-sensitive, so determinism is pinned by test.
Flips SonarCloud reliability_rating D -> A (3 bugs -> 0).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## WS-B — Security hotspots (18 to review)

Hotspots are *review* items, not auto-bugs. Each is either (a) fixed with a code change, or (b) judged safe and marked **Reviewed → Safe** in SonarCloud with a one-line justification. **Never bulk-mark Safe without reading each site.** Categories: 14× ReDoS (`dos`), 1× buffer-overflow (HIGH), 1× weak-cryptography, 1× encrypt-data, 1× other.

### Task B.1: Triage + bound the 14 ReDoS regexes

**Files (regex sites flagged):**
- `packages/gateway/src/connectors/_lib/pagination.ts:52`
- `packages/gateway/src/connectors/intercom-conversation-mapping.ts:26`
- `packages/gateway/src/connectors/obsidian-daily-note.ts:70`
- `packages/gateway/src/connectors/obsidian-parsing.ts:5` & `:6`
- `packages/gateway/src/connectors/obsidian-vault-id.ts:9`
- `packages/gateway/src/connectors/openapi-indexer-service-name.ts:20` & `:31`
- `packages/gateway/src/connectors/stackoverflow-question-mapping.ts:29`
- `packages/gateway/src/extensions/registry-client.ts:23` & `:128`
- (run the query in Step 1 for the remaining ~3 sites)

- [ ] **Step 1: Enumerate every ReDoS hotspot**

Run (PowerShell-native; the hotspots search tops out well under one 500-item page):

```powershell
(Invoke-RestMethod -Uri "https://sonarcloud.io/api/hotspots/search?projectKey=asafgolombek_Nimbus&status=TO_REVIEW&ps=500").hotspots |
  Where-Object { $_.securityCategory -eq 'dos' } |
  ForEach-Object { "{0}:{1} :: {2}" -f $_.component.Split(':')[-1], $_.line, $_.message.Substring(0, [math]::Min($_.message.Length, 90)) }
```

- [ ] **Step 2: For each regex, classify and act**

For each: identify the super-linear construct (nested quantifiers `(a+)+`, `(.*)*`, overlapping alternations, unbounded `.*` before a backtracking group). Then:
- **If the input is attacker-influenced** (connector API payloads, indexed content, extension-registry responses): rewrite to a linear form — anchor it, replace `.*` with a negated char class `[^x]*`, make quantifiers possessive-equivalent by restructuring, or cap input length before matching. Add a unit test feeding a pathological input and asserting the function returns within a tight bound (e.g. completes; or use a length guard).
- **If the input is bounded/trusted** (a fixed config key, a short internal id): mark the hotspot **Safe** in SonarCloud with the justification, and add a `docs/internals/platform-quirks.md` (or a connector doc) note only if the reasoning is non-obvious.

- [ ] **Step 3: Add a ReDoS characterization test for each rewritten regex**

Test file alongside each module (e.g. `obsidian-parsing.test.ts`). Feed a degenerate input (`"a".repeat(50000) + "!"`) and assert the parse completes and returns the expected (empty/partial) result. Run the relevant `bun test <file>`.

- [ ] **Step 4: Run the connector + extensions suites**

Run: `bun run test:coverage:sync` and `bun run test:coverage:extensions`. Expected: PASS.

- [ ] **Step 5: Commit** (one commit; cite the rule)

```
fix(connectors,extensions): linear-time regexes for ReDoS hotspots (Sonar)

Rewrites attacker-influenced patterns to non-backtracking forms with
pathological-input tests; trusted/bounded-input sites marked Safe in
SonarCloud with justification.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

### Task B.2: The C buffer-overflow + crypto/encrypt hotspots

**Files:**
- `packages/gateway/src-native/sandbox-helper/main.c:92` (HIGH — `strlen` use)
- the weak-cryptography site, the encrypt-data site, the "other" site (enumerate via the hotspots API, `securityCategory != dos`)

- [ ] **Step 1: Enumerate the four non-ReDoS hotspots**

Run the Step-1 query from B.1 but filter `securityCategory != 'dos'`.

- [ ] **Step 2: `main.c` `strlen` — bound the read**

Read `main.c:92` context. If the buffer is not guaranteed NUL-terminated within a known size, replace `strlen(buf)` with `strnlen(buf, sizeof(buf))` (or carry an explicit length). This file is the privileged sandbox helper (I15-adjacent) — **do not change its capability/setns behavior**; this is a bounds-safety fix only. The C `S3776`/`S134` complexity in this file is handled in WS-C Task C.7.

- [ ] **Step 3: Review the crypto + encrypt-data + other sites**

For each: confirm the algorithm/usage against `nimbus-security-invariants` (I10 constant-time, I12 DPAPI entropy, I16 Ed25519). These are almost certainly already-correct usages flagged by pattern; mark **Safe** with a justification that names the invariant, **unless** a real weakness is found (then fix + add an invariant test per the triple rule).

- [ ] **Step 4: Verify** — Run: `bun run audit:invariants` and `bun test packages/gateway/src/security-invariants.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```
fix(sandbox): bound strlen read in sandbox-helper; review crypto hotspots

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## WS-C — Cognitive complexity (`S3776`, 54 functions) — the deferred Pass-5 SOLID work

This is the substance of the deferred Pass-5 SRP pass. Each function exceeds the 15-cognitive-complexity threshold (C threshold 25). The refactor is **extract cohesive helper functions / early-return guard clauses / table-driven dispatch** until each function is ≤ 15, with **no behavior change**. Group by subsystem; one commit per subsystem cluster. Each task: characterization test first where coverage is thin, refactor, keep tests green, run `audit:invariants` for security-adjacent subsystems.

**Full site list (complexity → file:line), grouped:**

### Task C.1: `extensions/` cluster (highest concentration)

**Files (sorted by complexity):**
- `install-from-local.ts:479` (49), `:368` (19), `:87` (17)
- `auto-update-rpc.ts:29` (45)
- `verify-extensions.ts:346` (41), `:247` (21), `:47` (21)
- `auto-update.ts:125` (39)
- `sync.ts:64` (31)
- `dependency-graph.ts:55` (30), `:159` (16)
- `manifest.ts:147` (17)

- [ ] **Step 1: Confirm coverage, add characterization tests where thin** — Run `bun run test:coverage:extensions` and note any of the above files below ~85%. For each thin one, add a characterization test capturing current behavior (success + each error branch) before touching it.
- [ ] **Step 2: Refactor each function ≤ 15** — extract the discrete phases (validate → copy → verify-signature → register, etc.) into named helpers in the same file or a sibling `_lib`. **Constraint:** I16 signature-verify call (`verifyManifestSignature` / `verifyExtensionsBestEffort`) wiring stays intact; do not move it out of the verify path.
- [ ] **Step 3: Verify** — `bun run test:coverage:extensions` (≥85%), `bun test packages/gateway/src/security-invariants.test.ts`, `bun run audit:invariants`, `bun run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** — `refactor(extensions): reduce cognitive complexity below 15 (Sonar S3776)`

### Task C.2: `ipc/` cluster

**Files:** `http-write-routes.ts:70` (44), `index-reembed-rpc.ts:136` (43), `audit-rpc.ts:28` (27), `server/dispatchers.ts:527` (24), `http-server.ts:288` (22)

- [ ] **Step 1: Characterization tests** — `bun test packages/gateway/test/unit/ipc/`; add coverage for thin branches. **`http-write-routes.ts` is I13** — the `dispatchWriteRoute` allowlist + bearer + rate-limit + audit-on-rejection pipeline; reducing complexity must not drop any stage (see `nimbus-http-write-surface` skill). Extract per-stage helpers, keep the `WRITE_ROUTE_ALLOWLIST` length assertion and the request-flow order.
- [ ] **Step 2: Refactor ≤ 15** per function via extracted stage helpers / table-driven method dispatch (the `dispatchByMethod` Pass-4 helper may apply to `dispatchers.ts`).
- [ ] **Step 3: Verify** — IPC unit tests, `bun test packages/gateway/src/security-invariants.test.ts` (I13 sub-assertions), `bun run audit:invariants`, `bun run audit:openapi-drift`, `bun run typecheck`.
- [ ] **Step 4: Commit** — `refactor(ipc): reduce cognitive complexity below 15 (Sonar S3776)`

### Task C.3: `config/nimbus-toml.ts` cluster (also the top duplication file)

**Files:** `nimbus-toml.ts:1005, :960, :889, :787, :669` (each ~18–27)

- [ ] **Step 1: Characterization tests** — `bun run test:coverage:config` (≥80%). These are TOML-section validators; add fixtures covering each validation branch (valid + each rejection) before refactor.
- [ ] **Step 2: Extract a shared section-validator helper** — the five flagged functions are near-duplicate `[section.<id>]` validators (this is also WS-E's 7-block duplication in this file). Extract a `validateTomlSection(spec)` / per-field validator combinator so each section validator drops below 15 **and** the duplication collapses. Resolves S3776 + the dup in one move.
- [ ] **Step 3: Verify** — `bun run test:coverage:config`, `bun run typecheck`, `bun run lint`.
- [ ] **Step 4: Commit** — `refactor(config): table-driven TOML validators (Sonar S3776 + duplication)`

### Task C.4: `connectors/` mapping + sync cluster

**Files:** `openapi-indexer-sync.ts:158` (34), `pagerduty-sync.ts:59` (27), `openapi-indexer-discovery.ts:63` (23), `openapi-indexer-config.ts:46` (21), `obsidian-sync.ts:155` (19), `snyk-sync.ts:109` (18), `obsidian-discovery.ts:77` (16), and the mapping files `pipedrive-deal-mapping.ts:63` (21), `raindrop-bookmark-mapping.ts:37` (17), `lever-posting-mapping.ts:54` (17), `stackoverflow-question-mapping.ts:58` (16)

- [ ] **Step 1: Characterization tests** — `bun run test:coverage:sync`. The mapping files are pure (`map*ToItem`) — add input→row fixtures covering each conditional branch before refactor.
- [ ] **Step 2: Refactor ≤ 15** — for mappings, extract per-field derivation helpers (the `buildIndexedItem` / `_lib/item-builder.ts` Pass-4 helper likely applies). For the openapi-indexer cluster, extract the discrete spec-walk phases.
- [ ] **Step 3: Verify** — `bun run test:coverage:sync`, `bun run typecheck`.
- [ ] **Step 4: Commit** — `refactor(connectors): reduce mapping/sync cognitive complexity (Sonar S3776)`

### Task C.5: `cli/` command cluster

**Files:** `commands/extension.ts:176, :480, :594, :430` (28/22/17/17), `start.ts:153` (21), `deploy-annotate.ts:77` (22), `deploy.ts:99, :17` (20), `catchup.ts:18` (20), `impact.ts:14` (19), `index-cmd.ts:44` (18)

- [ ] **Step 1: Characterization tests** — `cd packages/cli; bun test src/` (recall `mock.module` leak — prefer DI). Add coverage for thin command branches.
- [ ] **Step 2: Refactor ≤ 15** — split each fat command handler into a thin arg-parse/registration shell + an extracted `run<Command>` implementation (mirrors the Pass-5.7 split pattern). This is also the deferred Pass-5.7 CLI split.
- [ ] **Step 3: Verify** — `cd packages/cli; bun test src/`, `bun run typecheck`, `bun run lint`.
- [ ] **Step 4: Commit** — `refactor(cli): split fat command handlers (Sonar S3776 + Pass-5.7)`

### Task C.6: misc gateway cluster (`deployment`, `metrics`, `agents`, `search`, `github-actions`, `sdk`)

**Files:** `deployment/annotate.ts:52` (31), `metrics/dora.ts:196` (26), `agents/catchup.ts:70` (23), `search/dual-search.ts:15` (16), `github-actions/annotate-action/src/main.ts:157` (28), `sdk/src/testing/sandbox-probe.ts:26` (20)

- [ ] **Step 1: Characterization tests** — `bun run test:coverage:deployment`, `:metrics`, `:agents`, `:embedding` (covers dual-search), and the github-actions package test. Pure calculators (`dora.ts`, `annotate.ts`) get input→output fixtures per branch.
- [ ] **Step 2: Refactor ≤ 15** — extract helpers; for `annotate.ts` keep the I14 `dbRun` transaction shape; for `dual-search.ts` keep the both-tables KNN merge (see `nimbus-embedding-routing`).
- [ ] **Step 3: Verify** — the coverage gates above, `bun run audit:invariants`, `bun run typecheck`.
- [ ] **Step 4: Commit** — `refactor(gateway): reduce cognitive complexity in deployment/metrics/agents/search (Sonar S3776)`

### Task C.7: C sandbox-helper (`c:S3776` + `c:S134`)

**Files:** `packages/gateway/src-native/sandbox-helper/main.c:316` (66), `:88` (26), `:423` & `:434` (`S134` nesting >3), `:88` (S3776)

- [ ] **Step 1: Read `main.c` fully.** This is the privileged `cap_net_admin` helper (I15). **Behavior is security-critical — setns/unshare/iptables logic must be byte-for-byte equivalent.** There is no Bun test harness for C; rely on the SDK sandbox-contract tests + manual reasoning.
- [ ] **Step 2: Extract static helper functions** for the discrete phases (arg parse, namespace setup, firewall rules, exec) to drop the main function ≤ 25 and nesting ≤ 3. No logic change.
- [ ] **Step 3: Verify** — `bun run test:coverage:sandbox` (the TS runner side) and, if the C build is wired, compile it. Run `bun run audit:invariants` (D10/I15). Expected: PASS. **If the C toolchain is unavailable in the worktree, mark this task BLOCKED and note it — do not guess at C refactors that can't compile.**
- [ ] **Step 4: Commit** — `refactor(sandbox-helper): extract phase helpers to cut C complexity (Sonar)`

---

## WS-D — Mechanical smell sweep (~320 MINOR/MAJOR)

Rule-cluster tasks. Most are Biome-autofixable or a mechanical find-replace. **One commit per rule cluster**, citing the rule id. After each: `bun run lint && bun run typecheck` and the affected package's tests. Get the per-rule issue list with (PowerShell-native; `ps=500` is the SonarCloud max page size):

```powershell
$rule = "typescript:S7735"   # set per cluster
$r = Invoke-RestMethod -Uri "https://sonarcloud.io/api/issues/search?componentKeys=asafgolombek_Nimbus&rules=$rule&resolved=false&ps=500&p=1"
"total: $($r.total)"   # if total > 500, also fetch &p=2, &p=3 ... (Sonar caps p*ps at 10000)
$r.issues | ForEach-Object { "{0}:{1}" -f $_.component.Split(':')[-1], $_.line }
```

**Pagination note:** the largest single rule cluster in the baseline is `S7735` at 82 issues, so one `ps=500` page covers every individual rule. If you ever query *all* code smells in one call (386 > a single 200-page), you **must** page through `p=1..N` or you silently miss the tail — that was the trap the `ps=200` form fell into. Always check `$r.total` against the count you actually received.

### Task D.1: Modern-syntax autofix cluster (`S6582` optional chaining, `S6606` nullish-coalescing, `S6571` redundant union, `S4624` nested template literals)

- [ ] **Step 1:** Confirm whether Biome has a matching rule and `bun run lint:fix` auto-applies it; for the rest, apply mechanically per the SonarCloud file list.
- [ ] **Step 2: Verify** — `bun run lint`, `bun run typecheck`, `bun test` (affected packages).
- [ ] **Step 3: Commit** — `refactor: optional-chaining / nullish-coalescing / redundant-union sweep (Sonar S6582/S6606/S6571/S4624)`

### Task D.2: Redundant casts/assertions (`S4325`, 72) + nested ternaries (`S3358`, 34)

- [ ] **Step 1:** For `S4325`, remove the redundant `as`/non-null assertions (TypeScript will confirm they were redundant — typecheck stays green). For `S3358`, lift nested ternaries into early-return helpers or `if`/`switch`. **No `any` may be introduced** (I7/CLAUDE.md #7) — if removing a cast reveals a real type gap, fix the type, don't `as any`.
- [ ] **Step 2: Verify** — `bun run typecheck` (the real gate here), `bun run lint`, `bun test`.
- [ ] **Step 3: Commit** — `refactor: drop redundant casts; unnest ternaries (Sonar S4325/S3358)`

### Task D.3: Deprecated-API usage (`S1874`, 24)

- [ ] **Step 1: Enumerate** with the per-rule query. Each flags a deprecated Node/TS/library API. Replace with the documented successor (the Sonar message names it).
- [ ] **Step 2: Verify** — `bun run typecheck`, `bun test`, and `bun run audit:cross-platform` if any path/OS API changed.
- [ ] **Step 3: Commit** — `refactor: replace deprecated APIs (Sonar S1874)`

### Task D.4: Remaining modern-idiom rules (`S7735` ×82, `S7778` ×20, `S7786` ×5, `S7763` ×4, `S5914` ×10, `S6353` ×6, `S6606`/`S6607` leftovers)

- [ ] **Step 1: Look up each rule** on `https://rules.sonarsource.com/typescript/RSPEC-<NNNN>/` (strip the `S`) to learn the exact transform; `S7735` is the largest cluster — handle it first as its own commit if it dominates. Apply per the SonarCloud file list. `S5914` (boolean-constant assertions) is typically in test files — confirm before changing test semantics.
- [ ] **Step 2: Verify** — `bun run lint`, `bun run typecheck`, `bun test` (+ UI vitest if `packages/ui` touched).
- [ ] **Step 3: Commit** — one per rule or a grouped `refactor: modern-idiom sweep (Sonar S7735/S7778/...)` with the rule list in the body.

---

## WS-E — Duplication (1.4% — 80 blocks / 53 files)

Extends the Pass-4 `_lib`/`shared` helper pattern. The clusters worth extracting (rest is acceptable noise at 1.4%):

### Task E.1: Shared MCP `search-filter` helper

**Files:** `packages/mcp-connectors/{metabase,superset,zendesk,raindrop,wiz}/src/search-filter.ts` (3+3+3+3+2 blocks) — near-identical substring/field-match filters.

- [ ] **Step 1: Characterization tests** — each connector has a `search-filter.test.ts`; confirm green first.
- [ ] **Step 2: Extract** `filterByQuery(items, { query, limit, fields })` into `packages/mcp-connectors/shared/search-filter.ts` (the relative-import `shared/` folder — see memory `shared-folder-external-deps`; no new external deps). Each connector's `search-filter.ts` becomes a thin call passing its field list.
- [ ] **Step 3: Verify** — `bun test packages/mcp-connectors/`, `bun run typecheck`, `bun run test:coverage:mcp` (≥70%).
- [ ] **Step 4: Commit** — `refactor(mcp-connectors): shared search-filter helper (Sonar duplication)`

### Task E.2: `nimbus-toml.ts` validators

- [ ] Covered by **WS-C Task C.3** (the table-driven validator extraction collapses the 7 duplicated blocks). No separate task — verify the dup count dropped in the after-snapshot.

### Task E.3: Residual mapping/agent duplication (judgment call)

**Files:** `semgrep-finding-mapping.ts` / `sonarqube-issue-mapping.ts` / `argocd-application-mapping.ts` (1–2 blocks each), `agents/expert.ts` + `cli/commands/{expert,impact,catchup,deploy}.ts` (CLI-agent boilerplate), `auth/oauth-registry.ts`, `connectors/lazy-mesh/phase3-config.ts`.

- [ ] **Step 1: Review each cluster** in the SonarCloud "Duplications" tab. Extract only where the shared code is genuinely one concept (e.g. the `emitBriefWithSynthesis` Pass-4 helper may already cover the agent CLI boilerplate — confirm adoption). For 1-block incidental dups, **mark as acceptable** rather than over-abstract (YAGNI).
- [ ] **Step 2: Verify** — affected package tests + `bun run typecheck`.
- [ ] **Step 3: Commit** — `refactor: extract genuine duplication clusters (Sonar)` (or skip with a note if all are incidental).

---

## Phase F — Verify + PR

### Task F.1: Full local gate

- [ ] **Step 1: Sync with `main` first.** `main` may have moved since the branch was cut (e.g. PR #458 / other work landing). Integrate before the final gate so conflicts surface locally, not on CI:

```powershell
git fetch origin
git rebase origin/main    # branch not yet pushed → rebase is clean; if already pushed, use: git merge --no-ff origin/main
```

Re-run `bun install` if `bun.lock` changed in the merge. Resolve any conflicts before continuing.

- [ ] **Step 2:** Run `bun run preflight --no-bail`. Expected: every gate green (the two known Windows-local coverage-floor flags on `ipc-transport.ts` / `socket-listeners.ts` are pre-existing and CI-Linux-authoritative — confirm they are unchanged, not newly introduced).
- [ ] **Step 3:** `bun run audit:invariants`, `bun run audit:openapi-drift`, `bun run audit:cross-platform`. Expected: PASS.
- [ ] **Step 4:** `cd packages/ui/src-tauri; cargo test` if any allowlist-adjacent file changed. Expected: PASS.

### Task F.2: Capture the after-snapshot + diff

- [ ] **Step 1:** Re-run the Task 0.2 measures query; append `## After (cleanup pass 2)` to `docs/superpowers/specs/sonar-baseline-2026-05-29.md` with the new JSON. Target deltas: bugs 3→0, reliability D→A, hotspots 18→0 reviewed, code_smells 386→<60, S3776 sites 54→0, duplicated_blocks 80→<40.

> **Note:** SonarCloud only recomputes on a fresh analysis (CI `sonar-scanner` step on push/PR). The local gates are the proxy; the authoritative after-numbers land on the dashboard once the PR's analysis runs.

### Task F.3: Push + open PR (PAUSE for user)

- [ ] **Step 1:** Print `git log --oneline origin/main..HEAD` and **confirm with the user before pushing** (per repo convention — nothing pushed until the user says so).
- [ ] **Step 2:** On go-ahead: `git push -u origin dev/asafgolombek/cleanup-pass-2` then `gh pr create --base main` with a body that links the before/after SonarCloud snapshot and lists the workstreams.

### Task F.4: Formally track the deferred Pass-5 lanes

**Files:**
- Create: `docs/superpowers/plans/2026-05-29-deferred-pass-5-lanes.md`

The Pass-5 SOLID lanes with **no** Sonar finding (so not pulled into WS-C) must not be silently dropped. Record them as a tracked stub so a future session can pick them up.

- [ ] **Step 1: Write the stub** — a short markdown file listing each deferred lane with its original Pass-5 task reference, why it was out of scope here (no `S3776`/duplication hit), and the trigger that would make it worth doing:

```markdown
# Deferred Pass-5 SOLID lanes (not Sonar-driven)

These lanes from `2026-05-28-monorepo-cleanup-pass.md` Pass 5 were NOT executed
in cleanup pass 2 because they had no SonarCloud finding driving them. Tracked
here so they are not forgotten.

- **5.5 vault Liskov** — confirm win32/darwin/linux conform to `NimbusVault` with no signature widening. Trigger: any new vault backend or `NimbusVault` method.
- **5.6 llm/voice provider DI** — `LlmRouter` constructor injection instead of direct `OllamaProvider`/`LlamaCppProvider` imports. Trigger: adding a 3rd LLM provider, or a `mock.module` test flake on the llm suite.
- **5.8 UI component splits** — React files >250 LOC. Trigger: a UI file crossing the threshold with a real maintainability cost.
- **5.9 sdk/client conservative SOLID** — API-preserving only; needs a version bump if exports change. Trigger: a published-surface refactor.
- **5.10 vscode-extension** — minimal pass; small package. Trigger: opportunistic.
```

- [ ] **Step 2: Commit** — `docs(plan): track deferred non-Sonar Pass-5 lanes`. (Open GitHub issues instead only if the team prefers issue-tracking over plan-doc-tracking — a maintainer decision, not required by this plan.)

---

## Self-review (completed during authoring)

- **Every SonarCloud finding category maps to a workstream:** bugs→WS-A, hotspots→WS-B, complexity(S3776)→WS-C, mechanical smells→WS-D, duplication→WS-E. ✓
- **Deferred Pass-5 SOLID is folded in:** WS-C **is** the SRP/complexity refactor (engine/ipc/db-adjacent/cli); C.5 = Pass-5.7 CLI split; C.3 = the `nimbus-toml` SRP+dup; E.1 = the `search-filter` dedupe. The remaining Pass-5 lanes not driven by a Sonar finding (5.5 vault Liskov, 5.6 llm/voice DI, 5.8 UI component split, 5.9 sdk/client, 5.10 vscode) are **out of scope for this Sonar-driven pass** — flag them as a separate follow-up if desired; they had no S3776/dup hits in the snapshot.
- **No placeholders:** every task names exact files (with line numbers from the live Sonar snapshot), the verify command, and the commit message. The per-rule WS-D file lists are fetched at execution via the documented query (the rule ids + counts are fixed).
- **Behavior-preservation discipline:** every refactor task leads with a characterization-test step; security-adjacent tasks (C.1 I16, C.2 I13, C.6 I14, B.2/C.7 I15) re-run `audit:invariants` + `security-invariants.test.ts`.
- **House-style + non-negotiables:** comment-light helpers, no `any`, invariants/HITL/vault-keys/license/audit-chain/Tauri-allowlist/OpenAPI untouched, cross-platform paths.

## Review dispositions (2026-05-29)

Plan review (`2026-05-29-cleanup-pass-2-review.md`) raised five points; all five fixed:

1. **Python dependency in API queries (point 1).** ✅ **Fixed.** Task 0.2, B.1, and the WS-D enumeration now use PowerShell-native `Invoke-RestMethod` (+ `Where-Object`/`ForEach-Object`) instead of `curl.exe | python -c`. No Python in the PATH is assumed, matching the plan's PowerShell-only convention.
2. **API pagination limit (point 2).** ✅ **Fixed.** WS-D queries bumped `ps=200 → ps=500` (the Sonar max) with an explicit pagination note: the largest single rule cluster is `S7735` at 82, so per-rule queries fit one page; any all-smells query (386 > one page) must page `p=1..N` and check `$r.total`. The hotspots query is likewise `ps=500`.
3. **C toolchain pre-flight (point 3).** ✅ **Fixed.** New Task 0.3 probes for `gcc`/`clang`/`cl` at the start and records whether Task C.7 (`main.c`) is BLOCKED on this machine, so it is known on day one rather than discovered at the end. All other workstreams are explicitly noted as unaffected.
4. **Branch up-to-dateness before push (point 4).** ✅ **Fixed.** Task F.1 Step 1 now does `git fetch origin` + `git rebase origin/main` (with a `merge --no-ff` fallback if already pushed) and a conditional `bun install`, before the final preflight — so integration conflicts surface locally.
5. **Tracking deferred Pass-5 lanes (point 5, open question).** ✅ **Fixed (lightweight).** New Task F.4 writes a tracked stub `docs/superpowers/plans/2026-05-29-deferred-pass-5-lanes.md` listing lanes 5.5/5.6/5.8/5.9/5.10 with their trigger conditions. Chosen over authoring a second full plan now (scope creep) or opening GitHub issues (a maintainer's tracking-preference call, noted as the alternative in F.4 Step 2).
