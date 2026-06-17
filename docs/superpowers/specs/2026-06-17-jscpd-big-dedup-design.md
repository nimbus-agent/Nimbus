# Design — jscpd "Big PR": drive strict duplication < 2.3% + tighten the gate

**Date:** 2026-06-17
**Branch:** `worktree-jscpd-dedup-big` (worktree off `origin/main` @ `93270cad`)
**Status:** approved design → ready for implementation plan
**Parent program:** [`2026-06-17-jscpd-duplication-reduction-design.md`](./2026-06-17-jscpd-duplication-reduction-design.md)
**Predecessors:** Stage A (PR #673, `8c3bbb35`) · Stage B1 (PR #678, `49132b5e`)

## Context

The jscpd duplication-reduction program drives the **strict** duplication
(`bunx jscpd packages`, reading `.jscpd.json`: `min-lines 5 / min-tokens 50 /
threshold 3`) under 3% by **extracting shared scaffolding into helpers — never by
adding jscpd ignores to handwritten source**. Prior stages shipped incrementally
(Stage A: 5.51→5.09; B1: 4.98→4.83). This PR is deliberately **one big PR** that
combines the highest-leverage remaining clusters to clear the threshold with
margin in a single landing, then tightens the CI gate.

**Re-measured baseline on fresh `main` (`93270cad`):** strict **4.83 %**
(6378 duplicated lines / 604 clones), via `bunx jscpd packages`.

**Goal:** strict **< 2.3 %** (and as low as the extractable clusters allow — no
stop-at-margin), all package tests green, then tighten CI
`pr-quality-duplication` to `min-lines 5 / threshold 3` so local == CI.

### Non-goals / constraints (inherited)

- **Pure dedup — zero behavior change.** Every existing connector / sync /
  command test stays green **unedited**; that is the behavior-fidelity proof. A
  dedup commit's `git status` shows no `*.test.ts` modified.
- **No new jscpd ignores** to dodge the threshold on handwritten source.
- **Do NOT touch** perf/Bencher surfaces (`packages/gateway/src/perf/**`).
- **Dependency rules:** `gateway` imports nothing from `cli`/`ui`; `mcp-connectors/*`
  import `@nimbus-dev/sdk` only; `sdk` imports nothing from gateway/cli/ui;
  circular deps forbidden.

## Verified findings (this session)

### 1. The SonarCloud `new_coverage` blocker — root-caused + fix verified

PR #678's red "Unit + Coverage" and "SonarCloud Code Analysis" checks were a
single cause: SonarCloud's **new-code-coverage** condition saw the new
`mcp-connectors/shared/mcp-search-tool.ts` at **0 %** (`new_coverage actual=0.0
LT 80`) and failed — even though the helper has a passing unit test and CI
explicitly runs `run_pkg "packages/mcp-connectors/shared"`. (#678 merged anyway.)

**Root cause:** `scripts/coverage/instrument-scope.ts` gates which modules the
istanbul preload instruments:

```ts
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/[^/]+\/src\//;
```

This matches `mcp-connectors/<conn>/src/…` but **never** `mcp-connectors/shared/…`
(shared helpers live directly under `shared/`, with no `/src/` segment). So every
file under `mcp-connectors/shared/` is silently un-instrumented → the
`run_pkg "shared"` step writes **0 coverage shards** → those files report 0 % in
the lcov fed to Sonar. The sibling `GHA_SRC` regex was already patched for the
same case (`github-actions/(?:shared|…/src)`); the mcp-connectors one was missed.

**Fix (one line, mirrors `GHA_SRC`):**

```ts
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/(?:shared|[^/]+\/src)\//;
```

**Verified** in this worktree: with the patch, replicating the CI shared run
flips `merge-coverage: merged 0 shard(s)` → `merged 1 shard(s)`, and all 8 shared
helpers (incl. `mcp-search-tool.ts`) appear in `coverage/lcov.info` with real
line/function coverage. This is a **fix-not-exclude** that retroactively gives the
existing shared helpers true coverage and unblocks every new shared helper this PR
adds. It is **Wave 0** (lands first).

> Note: the existing shared helpers were at 0 % all along; they never tripped
> `new_coverage` only because they are not *new* code. After the fix, Sonar's
> *overall* coverage metric (informational, not a gate condition under the "Sonar
> way" gate) gains these files at their true %. The gate condition that matters —
> `new_coverage ≥ 80 %` on this PR's new lines — is satisfied because every new
> helper ships a unit test.

### 2. Universal shared home = `@nimbus-dev/sdk`

`gateway` imports `@nimbus-dev/sdk` (not `client`); `cli` imports both; `sdk`
imports no nimbus package. So **`@nimbus-dev/sdk` is the only MIT package that
both `cli` and `gateway` already depend on**, and it is reachable from
mcp-connectors (sdk-only) and gateway. It is therefore the home for **all**
cross-package extractions in this PR: cli↔gateway shared types (agent-brief) and
gateway↔mcp shared logic (dataprofile, jmap, flux, localdb, storybook). Moving
generic parsing/scaffolding into MIT sdk is license-safe (MIT is more permissive;
no AGPL-domain logic is relocated).

## Live cluster ranking (pair-cluster analysis, dup-LINES by file-pair)

Top file-pairs by summed duplicated lines (from the fresh `jscpd-report.json`):

| dup-L | pair |
| --- | --- |
| 170 | `cli/types/agents.ts` ↔ `gateway/agents/_lib/findings.ts` |
| 147 | `mcp/imap/server.ts` ↔ `mcp/protonmail/server.ts` |
| 134 | `mcp/imap/tools.ts` ↔ `mcp/protonmail/tools.ts` |
| 105 | `mcp/outlook/server.ts` (intra-file) |
| 88 | `gateway/fastmail-sync.ts` ↔ `mcp/fastmail/jmap-core.ts` |
| 82 | `gateway/data-profile-mapping.ts` ↔ `mcp/dataprofile/profile.ts` |
| 79 | `gateway/data-profile-sync.ts` ↔ `mcp/dataprofile/profile.ts` |
| 78 | `gateway/imap-email-mapping.ts` ↔ `gateway/protonmail-email-mapping.ts` |
| 69 | `gateway/cloudwatch-sync.ts` ↔ `gateway/sagemaker-sync.ts` |
| 65 | `mcp/gmail/server.ts` (intra-file) |
| 62 | `cli/commands/catchup.ts` ↔ `cli/commands/impact.ts` |
| 61 | `mcp/github-actions/server.ts` ↔ `mcp/github/server.ts` |
| 55 | `mcp/onedrive/server.ts` ↔ `mcp/outlook/server.ts` |
| 52 | `gateway/connector-rpc-handlers/auth.ts` (intra-file) |
| 52 | `gateway/cloud-logging-sync.ts` ↔ `gateway/vertex-ai-sync.ts` |
| 46 | `gateway/fastmail-email-mapping.ts` ↔ `gateway/protonmail-email-mapping.ts` |
| 45 | `gateway/federation/peer-fanout.ts` (intra-file) |
| 45 | `gateway/federation/audit-export.ts` ↔ `gateway/federation/query-gate.ts` |
| 43 | `mcp/gitlab/server.ts` (intra-file) |
| 42 | `gateway/localdb-sync.ts` ↔ `mcp/localdb/sql-scan.ts` |
| 41 | `gateway/storybook-story-mapping.ts` ↔ `mcp/storybook/storybook-parse.ts` |
| 41 | `gateway/bitrise-sync.ts` ↔ `gateway/testflight-sync.ts` |
| 41 | `gateway/athena-sync.ts` ↔ `gateway/sagemaker-sync.ts` |
| 40 | `gateway/codemagic-sync.ts` ↔ `gateway/testflight-sync.ts` |
| 40 | `cli/run-workflow.ts` ↔ `cli/workflow.ts` |
| 39 | `gateway/google-meet-sync.ts` ↔ `gateway/google-photos-sync.ts` |
| 36 | `mcp/fastmail/tools.ts` ↔ `mcp/protonmail/tools.ts` |
| 55 | `gateway/flux-sync.ts` ↔ `mcp/flux/server.ts` |

(`absolute: false`; pair = unordered file-pair; intra-file = same file's internal
repetition.)

## Approach — one big PR, cluster-batched commits, run all clusters

Each cluster is one (or a few) commit(s); subagent-driven TDD; the controller runs
the per-connector `tsc` loop + biome + `git commit` after each batch (subagents
cannot commit). Re-measure strict % after each wave. **Run every cluster** —
target < 2.3 %, drive lower while clusters remain extractable.

### Wave 0 — Coverage infrastructure fix (lands first)

- Fix `scripts/coverage/instrument-scope.ts` `CONNECTOR_SRC` (the verified
  one-liner above). Add/extend `scripts/coverage/instrument-scope.test.ts` to
  cover several `mcp-connectors/shared/` paths (a flat `…/shared/foo.ts`, a
  nested `…/shared/sub/bar.ts`, and a `.tsx` extension) all returning `true` from
  `shouldInstrument`, **plus regression guards** that a connector
  `…/<conn>/src/server.ts` still instruments and a `…/shared/foo.test.ts` is
  still excluded (TDD: the new shared assertions fail pre-fix). No behavior change
  to any product code; this only widens coverage instrumentation.

### Wave 1 — Sonar-safe clean clusters (gateway / cli / sdk)

Coverage works normally for these targets; each new helper file ships a co-located
unit test (coverage-floor ≥ 80 %/file applies to gateway/cli/sdk/client).

- **C1 — agent-brief shared TYPES** (`cli/src/types/agents.ts` ↔
  `gateway/src/agents/_lib/findings.ts`, 170 L, the largest pair). Hoist the
  shared finding/brief **type** declarations into `@nimbus-dev/sdk`. Since these
  are types-only (erased at runtime — no tree-shaking concern), prefer a **root
  re-export** from `sdk/src/index.ts` (`import { type AgentBrief } from
  "@nimbus-dev/sdk"`) over a new package.json subpath, unless the sdk's existing
  export convention clearly favors a subpath — decide by reading the sdk's current
  `exports`/`index.ts` structure in planning. Each side imports rather than
  redeclares. Types-only → no executable lines → no coverage obligation. Verify
  both `cli` and `gateway` typecheck.
- **C2 — gateway email-mappings** (`imap-email-mapping.ts` ↔
  `protonmail-email-mapping.ts` 78 L; `fastmail-` ↔ `protonmail-email-mapping.ts`
  46 L) → a gateway-internal `_lib` helper (e.g.
  `connectors/_lib/email-mapping.ts`) the three mappers delegate to. Unit test +
  the three mappers' existing tests unedited.
- **C3 — CLI-shell sync clique** → a gateway `_lib` helper
  (`connectors/_lib/cli-shell-sync.ts`) for the shared `isSafeCliArg` + DI
  command-runner + spawn/parse skeleton. Members:
  `cloudwatch`/`sagemaker`/`cloud-logging`/`vertex-ai`/`athena`, plus the
  `bitrise`/`testflight`/`codemagic` build-poll trio and
  `google-meet`/`google-photos`. Migrate only files matching the shape; no
  force-fit. Unit test + each sync's existing test unedited.
- **C4 — CLI agent-brief render** (`catchup` ↔ `impact` 62 L; `run-workflow` ↔
  `workflow` 40 L) → a cli-internal `_lib` render helper. Unit test + command
  tests unedited.
- **C5 — gateway intra-file repetition** → extract local helpers within each
  file (or a small shared `_lib` where two federation files overlap):
  `connector-rpc-handlers/auth.ts` (52 L), `ipc/http-server.ts` (40 L),
  `federation/peer-fanout.ts` (45 L), `federation/audit-export.ts` ↔
  `query-gate.ts` (45 L). ⚠️ `query-gate.ts` is the I17 leak-proof gate — the
  extraction must be a behavior-neutral local helper that does not move the gate
  logic out of `query-gate.ts` (respect static D13 / the structure audit). Unit
  tests + existing tests unedited; run the security-invariants test.

### Wave 2 — MCP shared (requires Wave 0)

New helpers in `packages/mcp-connectors/shared/`, relative-imported. ⚠️ The email
connectors (`gmail`/`outlook`/`teams`/`google-meet`/`google-photos`) `include`
`../shared/**` in their tsconfig, so any new shared file must pass **strict** tsc
(`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`): run
`bunx tsc -p packages/mcp-connectors/{gmail,outlook,teams,google-meet,google-photos}/tsconfig.json`
after edits.

- **C6 — email-family IMAP/JMAP tool+server surface** (imap ↔ protonmail
  `server.ts` 147 L + `tools.ts` 134 L; `fastmail/tools` ↔ `protonmail/tools`
  36 L; `gmail`/`outlook` intra-file; `onedrive` ↔ `outlook` 55 L) → shared
  helper(s) for the repeated tool-registration + envelope/handler bodies.
  Co-located unit test (now coverage-counted via Wave 0). Every email-connector
  fake-server/sandbox test stays green unedited.
- **C7 — REST/Graph per-tool blocks** (`github-actions` ↔ `github` 61 L; `gitlab`
  intra-file 43 L) → a shared REST-tool-block helper in `mcp-connectors/shared/`.
  Unit test + connector tests unedited.

### Wave 3 — Hard cross-boundary (gateway ↔ mcp via `@nimbus-dev/sdk`)

Each pair shares logic across the gateway↔connector boundary; they cannot import
each other, so the shared logic moves into `@nimbus-dev/sdk` and **both** sides
import it. New sdk modules ship unit tests (coverage-floor applies to sdk).

> **SDK purity constraint (hard).** `@nimbus-dev/sdk` is consumed by external
> third-party plugins, so anything hoisted here must be **pure** — parsing /
> validation / type-mapping only, side-effect-free, no DB writes, no Bun/Node PAL
> filesystem/network/process access, no secrets. For each pair, only the **pure**
> portion of the duplicated span hoists; all I/O (JMAP HTTP calls, SQLite
> `sql-scan` queries, file reads in `profile.ts`) **stays in each caller**, which
> passes already-fetched data into the sdk helper. If a pair's duplicated span is
> I/O-bound rather than pure (so nothing pure remains to hoist), it is **not
> safely hoistable — defer that pair** rather than force an impure sdk module.
> Verify the pure/impure split per pair during planning by reading both files.

- **C8 — dataprofile column/row parsing** (`data-profile-mapping.ts` 82 L +
  `data-profile-sync.ts` 79 L ↔ `mcp/dataprofile/profile.ts`) → an sdk
  data-profile parsing module both import.
- **C9 — fastmail JMAP core** (`gateway/fastmail-sync.ts` ↔
  `mcp/fastmail/jmap-core.ts`, 88 L) → an sdk JMAP-core module both import.
- **C10 — flux / localdb / storybook pairs** (`flux-sync` ↔ `flux/server` 55 L;
  `localdb-sync` ↔ `localdb/sql-scan` 42 L; `storybook-story-mapping` ↔
  `storybook/storybook-parse` 41 L) → one sdk module per pair (or a small shared
  module), both sides import.

> These pairs currently sit in `sonar.cpd.exclusions` as "split across the package
> boundary by design." Hoisting to sdk genuinely removes the duplication for the
> pairs we touch. **Do NOT retire the `sonar.cpd.exclusions` entries in this PR.**
> They are **blanket family patterns** (`mcp-connectors/*/src/server.ts`,
> `tools.ts`, `gateway/connectors/*-sync.ts`, `*-mapping.ts`), not per-pair — and
> this PR dedups only a subset of each family, leaving a residual long tail in the
> files we don't touch. Removing the blanket patterns would re-expose that residual
> duplication to Sonar's gated `new_duplicated_lines_density` on any of those files
> we *do* edit. Retiring them is a **separate later cleanup**, safe only once a
> family is fully deduped. This PR's target is the strict *local* jscpd gate, which
> does not honor Sonar CPD exclusions anyway. (Coverage exclusions are parity-
> checked by `audit:exclusion-parity`; CPD exclusions are not — leaving them is
> clean.)

### Wave 4 — Measure + tighten the gate (only after strict < 2.3 % confirmed)

1. Re-measure strict `bunx jscpd packages`; record before/after in the PR body.
2. Tighten CI `pr-quality-duplication` (`.github/workflows/ci.yml` ~L353): replace
   the inline `bunx jscpd --min-lines 10 --min-tokens 50 --threshold 5 -i "…"
   packages/` with `bunx jscpd packages` (reads `.jscpd.json` =
   `min-lines 5 / min-tokens 50 / threshold 3`) — or `bun run audit:duplication`.
   `.jscpd.json` already encodes the strict settings, so local == CI.
3. Verify the tightened gate is green at the new threshold before landing.

## Testing strategy

- **Fidelity:** existing connector/sync/command tests run unedited after each
  dedup batch; `git status` must show no `*.test.ts` modified in those commits.
- **Coverage:** every new gateway/cli/sdk helper file ships a direct unit test
  (coverage-floor ratchet, ≥ 80 % line+branch/file, baseline `{}`); every new
  `mcp-connectors/shared/` helper ships a unit test (Sonar new_coverage, now
  attributed via Wave 0). C1 (types-only) needs none.
- **Strict tsc:** run `bun run typecheck` (all packages) — and **grep the output
  for `error TS`**, since the `--filter` aggregate can mask a sub-package failure.
  Run the 5 email-connector tsconfigs explicitly whenever `shared/` changes.
- **SDK rebuild (cross-package):** consumers resolve `@nimbus-dev/sdk` via its
  built `dist/` + `.d.ts` (not src), so any wave touching sdk (C1, C8–C10) must
  `cd packages/sdk && bun run build` **before** the gateway/cli/mcp typecheck or
  tests — otherwise the new sdk exports appear missing (`Cannot find module
  '@nimbus-dev/sdk/…'`). Same rule for `packages/client` if touched.
- **Security:** run `packages/gateway/src/security-invariants.test.ts` after C5
  (the `query-gate.ts` extraction) and the static
  `check-nimbus-invariants.ts` audit.

## Measurement protocol

- **Strict:** `bunx jscpd packages` → `Total:` % (baseline 4.83 %). Record per wave.
- **Pair/file deltas:** regenerate the report; group `duplicates[]` by file-pair
  and by file-involvement (dup-lines) to confirm each cluster collapsed and to
  re-rank the residual tail (drive lower while extractable).

## Risks & mitigations

- **PR size / reviewability** — cluster-batched commits (review commit-by-commit);
  re-measure per wave to stop adding tail clusters once well under 2.3 %.
- **Coverage-floor on new files** — Docker-Linux lcov build
  (`audit:coverage-floor`, CI-Linux-authoritative) before the first push.
- **Strict-tsc traps** on new shared/sdk files (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`) — the #678 zoom + email-tsconfig lesson; per-batch
  tsc loop, grep for `error TS`.
- **I17 / query-gate** — C5's extraction must keep the leak-proof gate logic in
  `query-gate.ts` (static D13); behavior-neutral local helper only.
- **CI-only traps** — full `bun run preflight` + coverage-floor + markdownlint +
  lychee (docs changed) + whole-branch `/code-review` **before the first push**
  (ship-readiness rule; #595 cost ~6 red rounds by skipping this).

## Success criteria

1. `bunx jscpd packages` reports **< 2.3 %** (lower if clusters allow), all
   package tests green.
2. CI `pr-quality-duplication` tightened to `min-lines 5 / threshold 3`,
   `.jscpd.json` aligned, gate verified green at the new threshold.
3. The coverage-infra fix (Wave 0) is included; `mcp-connectors/shared/` helpers
   are Sonar-covered. No new jscpd ignores; pure dedup; perf surfaces untouched;
   security invariants hold.
