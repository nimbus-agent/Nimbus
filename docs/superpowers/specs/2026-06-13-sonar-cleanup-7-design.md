# SonarCloud Cleanup 7 — Design

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/sonar-cleanup-7b` (worktree `.claude/worktrees/sonar-cleanup-7b`, off `origin/main` @ `1d504a23`)
**Project:** `nimbus-agent_Nimbus` (org `nimbus-agent`)

## Goal

Drive the live SonarCloud issue count **13 → 0** and **pragmatically** reduce
duplication, keeping the quality gate green. Fix-in-code, never rule-exclude
(standing policy; see `docs/structure-audit/sonarqube-rule-tuning.md` for the only
sanctioned suppressions). Single PR, commits grouped by rule-family. **Stop before
pushing** (user opens/pushes the PR).

## Current state (live API, 2026-06-13)

- QG: **OK** (green). Bugs 0, vulnerabilities 0, security_hotspots 0.
- Open issues: **13** (all `CODE_SMELL`).
- Duplication: **0.6%** — 819 duplicated lines / 46 blocks (non-gating; old-code).

Note: an abandoned prior branch `dev/asafgolombek/sonar-cleanup-7` exists (stale base
`32f85a12`, never merged, ~800-line diff). **Not** rebased — kept on disk only as a
reference for how it refactored `assemble.ts` / `nimbus-toml.ts`.

## Part A — the 13 open issues

Line numbers are against the Sonar snapshot = `main` = our base HEAD, so they should
be accurate; re-grep the construct before editing (drift-safe habit).

### Commit 1 — trivial/mechanical (proven patterns from cleanup-6)

| Rule | Sev | File:line | Fix |
| --- | --- | --- | --- |
| S7735 | minor | `cli/src/commands/update.ts:62` | invert negated condition + swap branches |
| S7735 | minor | `gateway/src/updater/factory.ts:30` | same |
| S7735 | minor | `cli/src/commands/huddle.ts:38` | same |
| S7735 | minor | `gateway/src/ipc/index-reembed-rpc.ts:264` | same |
| S6606 | minor | `gateway/compile-gateway.ts:105` | ternary → `??` nullish |
| S7781 | minor | `sdk/src/distribution-channel.ts:59` | `resolved.replace(/\\/g, "/")` → `resolved.replaceAll("\\", "/")` (rule = *Prefer `String#replaceAll()` over `String#replace()`*; verified via live Sonar msg) |
| S5914 | major | `gateway/src/connectors/obsidian-daily-note.test.ts:186` | replace the `if (win32) { expect(true)...; return }` sentinel with `test.skipIf(platform() === "win32")(...)` — eliminates the smell and the dummy assertion entirely |
| S3358 | major | `gateway/src/federation/preflight-gate.ts:130` | nested ternary → if/else or extracted var |

### Commit 2 — medium

| Rule | Sev | File:line | Fix |
| --- | --- | --- | --- |
| S4144 | major | `gateway/src/config/nimbus-toml.ts:1211` | `applyPreflightKvLine`@1211 is **byte-identical** to `applyQuorumKvLine`@1028 (verified) — collapse both into one shared `applyKvLine(bucket, trimmed)` |
| S107 | major | `gateway/src/connectors/filesystem-v2-sync.ts:276` | `upsertCodeSymbolsForFile` has 8 params (max 7) → bundle into an options object |

### Commit 3 — S3776 cognitive complexity (one sub-change each, behaviour-preserving)

| File:line | Current → target | Approach |
| --- | --- | --- |
| `gateway/src/config/nimbus-toml.ts:1288` (`applyTribalEntry`) | 16 → 15 | **only 1 over** — minimal extraction: pull the repeated `parseIntDec` + positive-guard + assign pattern (the 3 numeric cases `min_occurrences`/`window_days`/`cooldown_days`) into a small helper |
| `gateway/src/agents/huddle.ts:44` (`runHuddle`) | 17 → 15 | extract the triple-nested per-peer contribution loop into `aggregateContributions(queryResults, cutoff)`; leaves `runHuddle` a clean coordinator |
| `gateway/src/platform/assemble.ts:921` (`assemblePlatformServices`) | 34 → 15 | the big one (~230 lines). Extract cohesive boot steps into named local helpers (e.g. `bootTribalKnowledge(...)` for the whole `if (tribalCfg.enabled)` block — its nested `gatherSources` loop + try/catch dominate the count). Preserve exact execution order **and** the I22 policy-gate / I25 tribal-write-gate wiring |

S3776 refactors **must not change behaviour** — existing tests (subsystems ~90.9%
covered) are the guardrail. Any observable change = stop and verify. Refactors in
`assemble.ts` / tribal parsing **must preserve I22 (policy gate) + I25 (tribal
write-gate) wiring** — verify the security-invariants test stays green.

## Part B — pragmatic duplication

Extract only where a shared helper genuinely improves the code. Each extraction = its
own commit. Candidate clusters (top duplicated, production source):

- `engine/search-ranking.ts` (44), `connectors/_lib/gitlab/events.ts` (40),
  `ipc/lan-client.ts` (36), `agents/_lib/findings.ts` (25), `agents/expert.ts` (30)
- `github-actions/{annotate-action,preflight-query}/src/main.ts` + `output.ts` pairs
  (32+32+20+18) — cross-package twins, strong extraction candidate
- connector `search-filter.ts` (dependencytrack 28 / airflow 27) + `gx-parse.ts` /
  `sql-scan.ts` / `dataprofile/profile.ts` clusters

**Explicitly skip** (deliberately-declarative, DRY hurts readability):
`auth/oauth-registry.ts` (104) and `connectors/lazy-mesh/phase3-config.ts` (136).

Target: meaningfully cut the 819 dup lines (~40–60%) without forced indirection.
Stop where the next extraction would only trade clarity for a lower number.

## Verification

- Per-package `tsc --noEmit` is the **oracle** (`bun test` won't catch type errors).
- `biome format` **before** each commit (codemod/manual edits bypass the editor hook).
- Scoped tests for every touched file (ui/vscode = `bunx vitest run`; others `bun test`).
- Sonar snapshot is pinned to `main`; verify each fix against current HEAD locally,
  then confirm 0-open + dup delta after the PR's analysis runs.
- Lint via `bunx biome check packages scripts` (worktree `bun run lint` false-fails).

## Out of scope

- Coverage work (separate True-Coverage program).
- The `oauth-registry` / `phase3-config` declarative duplication.
- Pushing / opening the PR (user does this).
