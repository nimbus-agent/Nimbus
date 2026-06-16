# Design — jscpd Duplication Reduction & Gate Tightening

**Date:** 2026-06-17
**Branch:** `worktree-jscpd-dedup` (worktree off `origin/main` @ `5993765b`)
**Status:** approved design → ready for implementation plan

## Problem

The repo runs jscpd at two disagreeing settings:

| Config | Command | Settings | Result |
| --- | --- | --- | --- |
| Local `.jscpd.json` (`audit:duplication` = `bunx jscpd packages`; also chained by `audit:structure`) | `bunx jscpd packages` | `min-lines 5`, `min-tokens 50`, `threshold 3` | **5.51% — FAILS** (711 clones) |
| CI gate `.github/workflows/ci.yml` → `pr-quality-duplication` (~line 353) | `bunx jscpd --min-lines 10 --min-tokens 50 --threshold 5 -i "**/node_modules/**,**/*.test.ts,**/*.test.tsx,**/*.vitest.tsx" packages/` | `min-lines 10`, `threshold 5` | 3.53% — PASSES (350 clones) |

CI is more lenient than the local check; the strict local check fails on pre-existing
duplication, so `bun run audit:duplication` and `bun run audit:structure` are red today.

## Goal

Drive the **strict** duplication (`min-lines 5 / min-tokens 50 / threshold 3`, measured by
`bunx jscpd packages`) from **5.51% to under 3% with margin (target ≈ ≤2.3%)** by
**extracting shared scaffolding into helpers — never by adding jscpd ignores**. Then
tighten the CI gate and align `.jscpd.json` so local == CI at `min-lines 5 / threshold 3`,
and confirm the gate is green at the new threshold.

### Non-goals / constraints

- **Pure dedup/extraction — zero behavior change.** All connector contracts and per-file
  tests stay green throughout each stage.
- **Do NOT touch perf/Bencher work** (PR #666) or anything under
  `packages/gateway/src/perf/**`. (The `bench-rss-*` clones are perf surfaces and are out
  of scope.)
- **Respect package dependency rules:** `mcp-connectors/*` depend only on
  `@nimbus-dev/sdk`; `gateway` imports nothing from `cli`/`ui`; `sdk` imports nothing from
  `gateway`/`cli`/`ui`. So: shared mcp-connector code → `@nimbus-dev/sdk`; shared gateway
  code → a gateway-internal `_lib`; cross-`cli↔gateway` shared types → an MIT package both
  already depend on (`@nimbus-dev/client` or `@nimbus-dev/sdk`).
- **Fix, don't exclude** (precedent: installer channel-resolver + cross-boundary signer
  hoisted to the SDK to kill a Sonar duplication gate, rather than CPD-excluding).

## Root-cause map (from `docs/structure-audit/jscpd-report.json`, 711 clones)

The single biggest signal: `gateway/src/connectors/zotero-sync.ts` shows **85 clones, all
external** — it is the *centroid* of the gateway connector-sync family. It clones against
~45 other `*-sync.ts` files (zendesk, vercel, superset, stackoverflow, readwise, raindrop,
prefect, netlify, mlflow, greenhouse, databricks, …), each sharing an **identical
single-pass paginated `sync()` loop + `upsert*` loop**; only creds/path/headers/extract/
mapping vary. There are 95 `*-sync.ts` files and 92 mcp-connector `server.ts` files — both
large families of near-identical scaffolding.

Top file involvement (clone count): `zotero-sync.ts` 85 · `outlook/server.ts` 27 ·
`zotero/server.ts` 21 · `gmail/server.ts` 18 · `gitlab/server.ts` 17 · `oauth-registry.ts`
16 · `github/server.ts` 15 · `vertex-ai-sync.ts` 15 · `connector-rpc-handlers/auth.ts` 12 ·
`wiz/server.ts` 12 · `protonmail/server.ts` 12 · `dataprofile/profile.ts` 12 ·
`cli/types/agents.ts` 12 (↔ `gateway/agents/_lib/findings.ts`) · `cli/commands/workflow.ts`
12.

## Approach — a measurement-driven program of staged PRs

Leverage-ordered clusters, each its own PR off latest `main`, **re-measuring strict %
after each**, stopping once strict is comfortably under 3% (≈≤2.3%). We may stop before
completing every cluster — low-value cross-package clusters are done only if needed for a
safe margin.

### Stage A — Gateway connector-sync scaffolding (highest leverage)

- **Extract** `runPaginatedSync(...)` + `upsertMapped(...)` (working names) into a new
  `packages/gateway/src/connectors/_lib/paginated-sync.ts`. The helper parameterizes the
  per-connector variations the duplicated bodies expose: start-page (0 vs 1), per-page path
  builder, fetch (headers/auth), `extract` (response → items [+ optional `next`]), the
  break/continuation condition, and the `mapXToItem` mapping function. It reuses the
  existing `_lib/fetch-outcome.ts`, `sync/pass-cursor-sync-result.ts`, `sync/types.ts`.
- **Migrate** only the **single-pass paginated family** — the zotero centroid plus the
  ~45 partners the jscpd pairs identify. Multi-pass / cursor-continuation syncs that do
  *not* match the shape are left untouched (no force-fit).
- **Stage split:** if ~45 files is too large for one reviewable PR, split A1 (helper + the
  first batch) / A2 (remaining), tests green per batch.
- **Expected:** the largest single drop — the whole zotero-partner clique collapses when
  every member delegates to one helper.

### Stage B — MCP `server.ts` tool-registration scaffolding

- **Extract** the repeated registration scaffolding into `@nimbus-dev/sdk` (the established
  precedent). Target the worst offenders first: outlook, gmail, gitlab, github, imap,
  protonmail, onedrive, wiz, tableau, github-actions, google-drive. Internal (same-file)
  *and* cross-connector clones (imap↔protonmail, onedrive↔outlook, github-actions↔github).
- The exact helper API is a planning detail — derived from reading the imap/protonmail and
  github/github-actions `server.ts` pairs.

### Stage C — Email-connector `tools.ts` + gateway email-mapping

- imap/protonmail/fastmail `tools.ts` shared logic → `@nimbus-dev/sdk` (may fold into B).
- `fastmail-email-mapping.ts` ↔ `protonmail-email-mapping.ts` shared logic → gateway
  `_lib`.

### Stage D — Gateway auth scaffolding

- `auth/oauth-registry.ts` internal per-provider repetition + `ipc/connector-rpc-handlers/
  auth.ts` → a gateway-internal helper. Self-contained.

### Stage E — CLI agent-brief + cross-package types

- CLI agent-brief command rendering (catchup/impact/workflow/run-workflow) → a cli-internal
  helper.
- The shared agent-brief/finding **type** definitions (`cli/src/types/agents.ts` ↔
  `gateway/src/agents/_lib/findings.ts` — the single largest pair cluster, 170 lines) →
  hoisted into an MIT package both `cli` and `gateway` already depend on (pin
  `@nimbus-dev/client` vs `@nimbus-dev/sdk` during planning; prefer the one both already
  import). Each side imports rather than redeclares.

### Final stage — gate tightening (only after strict < 3% with margin)

- Change `ci.yml` `pr-quality-duplication` to run `bunx jscpd packages` (which reads
  `.jscpd.json`) — or equivalently `bun run audit:duplication` — at `min-lines 5 /
  min-tokens 50 / threshold 3`, so local and CI use the **same** settings and ignore set.
- Confirm `.jscpd.json` already encodes `min-lines 5 / threshold 3` (it does) so the two
  configs match.
- Verify the gate is green at the new threshold before this lands.

## Measurement protocol (every stage)

- **Strict (the gate under repair):** `bunx jscpd packages` → read the `Total:` row %.
- **Per-file / per-pair deltas:** regenerate `docs/structure-audit/jscpd-report.json` and
  diff file-involvement + pair-cluster counts (analysis script grouping `duplicates[]` by
  `firstFile`/`secondFile`).
- Record before/after strict % in each PR description.
- **Anchored baselines (clean worktree @ `5993765b`):** strict **5.51%** (711 clones) /
  CI-lenient **3.53%** (350 clones).

## Risks & mitigations

- **Coverage-floor ratchet (≥80% line+branch/file; baseline starts `{}` for new files).**
  Every new helper file must hit ≥80% immediately. Helpers are exercised by all delegating
  connector tests, so coverage should follow — but verify via the Docker-Linux lcov build
  (`audit:coverage-floor`, CI-Linux-authoritative) before pushing each PR.
- **Behavioral fidelity.** The sync helper must faithfully reproduce each connector's
  start-page, break condition, error-pass cursor, and byte/upsert accounting. Per-file
  tests are the guardrail; migrate in small batches and keep them green.
- **CI-only traps.** Follow the ship-readiness rule: full `bun run preflight` + coverage-
  floor + whole-branch `/code-review` before the FIRST push of each PR. Watch the
  cross-boundary-import rule when hoisting to sdk/client (dependency-cruiser / structure
  audit).
- **Scope creep.** Don't refactor beyond what removes clones; no unrelated rewrites.

## Success criteria

1. `bunx jscpd packages` reports **< 3%** (target ≈≤2.3%) with all package tests green.
2. CI `pr-quality-duplication` tightened to `min-lines 5 / threshold 3`, `.jscpd.json`
   aligned, and the gate verified green at the new threshold.
3. `bun run audit:duplication` and `bun run audit:structure` pass locally.
4. No behavior change; no new jscpd ignores added to dodge the threshold; perf surfaces
   untouched.
