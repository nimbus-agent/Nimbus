# Phase 7 — The Cost Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 7 as eight PRs; this plan details slice 1 (cost-line model, FOCUS CSV import, allocation rules, `nimbus cost products|internal`, demo lines) task by task and fixes the scope, files and gates of slices 2–8, each of which gets its own detailed task list at its start (written into this file on the branch before that slice's code).

**Architecture:** A dedicated `cost_line` table (V109) holds normalised FOCUS-shaped daily lines from every source; `finops/` (pure, D48) parses, stores, allocates (owner rules from `nimbus.toml`, evaluated at read time) and renders; IPC `cost.*` methods in `ipc/cost-rpc.ts` serve `cli`/`ui` kinds; the CLI renders text/JSON/CSV. Delivery (slice 4) is a workflow `report` step plus the I55 extension; connector sources (slices 5–6) are sandboxed connectors in `nimbus-mcp-servers`.

**Tech Stack:** Bun 1.4, TypeScript strict, bun:sqlite through `db/write.ts` helpers (I14), Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-26-phase7-cost-pack-design.md` (Antigravity-approved 2026-11-26; read its "Resolved after the builder check" and "Fixes from the Antigravity review" sections: they override earlier text).

## Global Constraints

- Non-negotiables (CLAUDE.md): no `any`; Vault-only credentials; MCP as connector standard (no cloud API call from the gateway); platform equality (path.join, tests on all OSes).
- D48: nothing under `packages/gateway/src/finops/` imports ChatOps, egress, federation, share, llm, engine, agents or a connectors value, or uses a network primitive.
- New D24 rule `cost-line-confined`: write verbs on `cost_line` only in `finops/cost-line-store.ts` and its DDL.
- Amounts are never summed across currencies; every total is per currency.
- Imported lines are never folded into `__other__`.
- Re-import: per (source, provider, billing account, billing period) REPLACE stored lines on exactly the charge days the file contains; unique key (source, provider, billing_account, charge_day, grain_hash) makes an identical re-import a no-op.
- Rule `set` values after substitution must match `^[A-Za-z0-9._:/@+-]{1,64}$`, else the line is `unassigned` with the reason.
- Files under 500 lines (`audit:file-size`); split by responsibility.
- Every PR: `bun run preflight:fast` green; touched suites green; core docs updated in the same PR (CHANGELOG, roadmap row, cli-reference, architecture, CLAUDE.md/GEMINI.md only if a summary line becomes false); the spec and this plan are deleted from the branch before the LAST slice merges, and never appear in any PR diff (`git diff origin/main...HEAD --stat`): each slice's PR branch is cut from main WITHOUT them (keep the spec/plan on `dev/asaf/phase7-cost-pack` only).

## Review Focus

1. A FOCUS CSV with a UTF-8 BOM, CRLF line endings and quoted fields containing commas/newlines imports identically to a clean LF file (Task 2 test).
2. Re-importing a month-to-date file that grew from day 1..19 to 1..20 yields exactly the day-1..20 lines, no duplicates (Task 3 test).
3. Two currencies in one window never produce a grand total (Task 5 test).
4. A tag value like `<!here>` or `../../x` substituted by a rule lands the line in `unassigned` with a reason (Task 4 test).
5. An empty table reads "no cost data imported" and a zero-cost period reads "0.00 USD": different outputs (Task 6 test).

---

## Slice 1 (PR 1): cost lines, FOCUS CSV import, rules, products/internal, demo

Branch: `dev/asaf/phase7-s1-cost-lines` from `origin/main`.

**As built (PR #2168, 2026-11-26):** all six tasks shipped, with these builder calls: the grain hash also includes the region; the re-import result reports `inserted`/`replaced`/`unchanged`/`removed`; the import id is the file content hash `focus:<16 hex>` (per file, so `--remove` names one export); a directory imports oldest modification time first; `[[cost.rule]]` follows the layered config's array rule (the highest layer with rule blocks supplies all of them, so a role pack's rules apply until the owner writes their own); a bad `[cost]` config refuses the whole section (`configError`) rather than dropping a rule; the cost config lives in `config/cost-toml.ts` (re-exported from `config/finops-toml.ts`, registered with `nimbus config explain`); `cost_line` erasure on `connector remove` goes through `index/item-store.ts` `deleteAllItemsForService` (local-index.ts may not grow); the Vantage adapter uses one report configuration per day; `--period` also takes `<N>d`; `finops/` names its window `range` (D48 bans the identifier `window`); CSV cells are formula-guarded; the demo export is loaded through the real `importFocusPath`.

### Task 1: The `cost_line` table (V109) and its store

**Files:**
- Create: `packages/gateway/src/index/cost-line-v109-sql.ts`, `packages/gateway/src/index/migrations/runner-v109.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (register 109 after 108), `packages/gateway/src/index/local-index.ts` (`CURRENT_SCHEMA_VERSION = 109`, and `removeConnectorIndexData` deletes the service's `cost_line` rows), `docs/schema-reference.md`
- Create: `packages/gateway/src/finops/cost-line-store.ts`, `cost-line-store.test.ts`
- Modify: `scripts/structure-audit/invariants/` (add `cost-line-confined` beside `schema-history-confined`), `docs/SECURITY-INVARIANTS.md` (D24 text)

**Interfaces:**
- Produces: `interface CostLine { source: string; provider: string; billingAccountId: string; billingPeriod: string /*YYYY-MM*/; chargeDay: string /*YYYY-MM-DD UTC*/; subAccountId: string | null; subAccountName: string | null; serviceName: string; serviceCategory: string | null; regionId: string | null; resourceId: string | null; resourceName: string | null; skuId: string | null; chargeCategory: "usage"|"purchase"|"tax"|"credit"|"adjustment"; billedCost: number; effectiveCost: number | null; currency: string; tags: Readonly<Record<string,string>>; repo: string | null; workflow: string | null; model: string | null; importId: string; }`
- Produces: `replaceCostLines(db, key: { source; provider; billingAccountId; billingPeriod }, days: readonly string[], lines: readonly CostLine[]): { inserted: number; replaced: number }` (one transaction); `readCostLines(db, q: { fromDay: string; toDay: string; sources?: readonly string[] }): CostLine[]`; `deleteCostLinesBySource(db, source): number`; `deleteCostImport(db, importId): number`.
- Grain hash: SHA-256 hex of the canonical JSON of (subAccountId, serviceName, resourceId ?? skuId, chargeCategory, sorted tags, repo, workflow, model).

- [x] **Step 1:** Write `runner-v109.test.ts`: `CURRENT_SCHEMA_VERSION >= 109`; a fresh DB has `cost_line` with columns above plus `grain_hash`, unique index on (source, provider, billing_account_id, charge_day, grain_hash), indexes (source, charge_day) and (source, provider, sub_account_id, charge_day). Run → FAIL.
- [x] **Step 2:** Write the DDL and register it. Run → PASS.
- [x] **Step 3:** Write `cost-line-store.test.ts`: replace inserts; replacing days {01..19} then {01..20} leaves exactly the 20-day set (Review Focus 2); identical re-import changes nothing (inserted 0, replaced = n is acceptable only if values equal: assert row count and sums unchanged); lines on days not in the set are kept; delete by source and by import id.
- [x] **Step 4:** Implement the store with `dbRun`/`dbStmtRun` (I14). Run → PASS.
- [x] **Step 5:** Add the `cost-line-confined` static rule with its own fixture test; `bun run audit:invariants` (or the `check-nimbus-invariants.ts` entry) passes; add `cost_line` to `LocalIndex.removeConnectorIndexData` (in `index/local-index.ts`) and the `nimbus data delete` path for its source (mirror the `chat_read_marker` erasure) with a test.
- [x] **Step 6:** Commit `feat(gateway): the cost_line table and store (V109)`.

### Task 2: FOCUS CSV reader

**Files:** Create `packages/gateway/src/finops/focus-csv.ts`, `focus-csv.test.ts`, fixtures under `packages/gateway/src/finops/__fixtures__/focus/` (a small AWS, Azure and GCP FOCUS 1.x sample each, hand-made, plus BOM/CRLF variants)

**Interfaces:** Produces `parseFocusCsv(text: string, opts: { provider?: "aws"|"azure"|"gcp"; importId: string }): { lines: CostLine[]; byPeriod: Map<string /*billingAccountId|billingPeriod*/, { days: Set<string>; totals: Map<string /*currency*/, number> }>; skipped: { row: number; reason: string }[] }`

- [x] **Step 1:** Tests: the three fixtures parse to the expected lines; BOM + CRLF + quoted comma/newline fixture equals the clean one (Review Focus 1); missing required FOCUS columns (`BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ServiceName`) → a thrown error naming the column; a row with a non-numeric cost → `skipped` with reason; provider inferred from `ProviderName` when `--provider` absent; `Tags` JSON column flattened, at most 50 tags of at most 128 chars each (excess recorded in `skipped`-style warnings, not dropped silently).
- [x] **Step 2:** Implement a dependency-free RFC 4180 parser (strip BOM, CRLF/LF, quotes) and the FOCUS column mapping; day = UTC date of `ChargePeriodStart`. Rows sharing (billingAccountId, chargeDay, grain hash) within a file are AGGREGATED into one line (summing `billedCost` and `effectiveCost`; a null effectiveCost stays null only if all are null), so the unique key never collides and totals still reconcile; add a test with two raw rows of one grain. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): FOCUS CSV reader`.

### Task 3: `cost.import` IPC and `nimbus cost import`

**Files:** Create `packages/gateway/src/finops/cost-import.ts`, `cost-import.test.ts`, `packages/gateway/src/finops/cost-folder-watch.ts` (+ test); Modify `packages/gateway/src/ipc/cost-rpc.ts` (+ test: `CostRpcCtx` gains `caller: { kind: ClientKind }` from `ctx.getClientKind`, as `incident-rpc.ts` does; the IPC routing site passes it), Create `packages/cli/src/commands/cost-import-cli.ts` (+ test; `cost.ts` only routes to it), `docs/cli-reference.md`

**Interfaces:** Produces `importFocusPath(db, path: string, opts: { provider?; dryRun: boolean; now: () => number }): ImportReport` where `ImportReport = { importId; files: { path; sha256; lines; replaced; skipped; totals: Record<string, number> }[] }`; IPC `cost.import { path, provider?, dryRun? }` (owner kinds `cli` only, reads a local path), `cost.importRemove { importId }`.

- [x] **Step 1:** Tests: a directory imports every `*.csv` (non-recursive), each file in its own transaction; the per-file totals equal the sum of its lines per currency; `--dry-run` writes nothing; a second identical run reports 0 net change; `cost.import` from a connection that did not declare `cli` is refused; the `cost` namespace stays in `FORBIDDEN_OVER_LAN`.
- [x] **Step 2:** Implement (read through one handle per file, cap 512 MiB per file with a stated refusal, `path.join`); wire the handler; `[cost.focus] dir` (parsed in Task 4's config) is imported by `cost-folder-watch.ts` once a day from the gateway's existing scheduler hook (the one the FinOps sync uses), new or changed files only (by SHA-256), never on a demo gateway, with a test using an injected clock; CLI `nimbus cost import <path> [--provider aws|azure|gcp] [--dry-run] [--json]` and `nimbus cost import --remove <importId>`. Run → PASS.
- [x] **Step 3:** Commit `feat: nimbus cost import for FOCUS CSV exports`.

### Task 4: Allocation rules

**Files:** Create `packages/gateway/src/finops/cost-rules.ts`, `cost-rules.test.ts`; Modify `packages/gateway/src/config/finops-toml.ts` (+ test) for `[[cost.rule]]`, `[cost] internal_envs`, `[cost] authoritative`, `[cost.focus] dir` (an absolute path, refused if it is a link)

**Interfaces:** Produces `type CostRule = { match: Partial<{ source; provider; sub_account; service; region; resource; repo; workflow; tag: Record<string,string> }>; set: Partial<{ product; env; service }> }`; `allocate(line: CostLine, rules: readonly CostRule[]): { product: string|null; env: string|null; service: string|null; rule: number|null; unassignedReason: string|null }`; matchers in one registry `COST_MATCHERS` keyed by match field (glob via a small literal-glob matcher: `*` and `?` only).

- [x] **Step 1:** Tests: first match wins; all given match keys must match; placeholder `{tag.product}` substitutes; a substituted value failing the charset → unassigned with reason (Review Focus 4); no rule matches → unassigned "no rule matched"; unknown match key or placeholder → config load error naming it; `internal_envs` default `["ci","dev","test","staging"]`.
- [x] **Step 2:** Implement; config parsing refuses unknown keys. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost allocation rules`.

### Task 5: Views: `cost.products` and `cost.internal`

**Files:** Create `packages/gateway/src/finops/cost-views.ts`, `cost-views.test.ts`, `packages/gateway/src/finops/cost-allocation-adapter.ts`, `cost-allocation-adapter.test.ts`; Modify `ipc/cost-rpc.ts`, `packages/cli/src/commands/cost.ts` (split into `cost-views-cli.ts` if it nears 500 lines), `docs/cli-reference.md`

**Interfaces:** Produces `productView(lines, rules, opts: { fromDay; toDay; currencyOrder? }): ViewResult` and `internalView(...)`, where `ViewResult = { byCurrency: Record<string, { total: number; rows: { product|env: string; service: string|null; provider: string; amount: number }[]; unassigned: number }>; freshness: { source: string; lastDay: string|null; provisionalFrom: string|null }[]; empty: boolean; excludedSources: string[] }`. Sources: `cost_line` rows, plus a read-side adapter `adaptCostAllocationItems(db, window)` in `finops/cost-allocation-adapter.ts` that projects existing `item` rows of type `cost_allocation` (Vantage) into `CostLine` shape (`currency` from the row or `"unknown"`, shown as its own currency group) for providers with no raw lines, or when `[cost] authoritative` names `vantage` for that provider. Authoritative rule: when raw lines exist for a provider, its Vantage rows are excluded and listed in `excludedSources`. Kubecost/OpenCost never enter cloud totals; `--allocation cluster` returns them as their own view (`clusterView`).

- [x] **Step 1:** Tests: per-currency totals, no grand total across currencies (Review Focus 3); unassigned shown per currency; provisional marking for the last 3 days; Vantage exclusion listed; IPC `cost.products|internal { period }` (`7d|30d|month|week`, owner kinds `cli`/`ui`).
- [x] **Step 2:** Implement + CLI `nimbus cost products|internal [--period 30d] [--allocation cluster] [--json|--csv]` (CSV: one row per currency/product/env/service/provider, header row fixed and documented). Run → PASS.
- [x] **Step 3:** Commit `feat: nimbus cost products and nimbus cost internal`.

### Task 6: Demo cost lines, docs, slice close-out

**Files:** Modify `packages/gateway/src/demo/corpus/acme.ts` (or a new `corpus/acme-cost.ts` it imports), `demo/seed.ts` (+ tests); `docs/roadmap.md` (Phase 7 rows: tick intake-from-files partially with a progress note), `docs/CHANGELOG.md`, `docs/architecture.md` (FinOps section: the cost-line model), `docs/cli-reference.md`

- [x] **Step 1:** Test: a demo gateway seeds FOCUS lines for three products (checkout, search, internal tools), envs prod/dev/ci, a seeded spike on checkout's service, two currencies NOT used (USD only) and a demo rules block; `nimbus --demo cost products` lists the three products; an empty real install says "no cost data imported" (Review Focus 5).
- [x] **Step 2:** Implement; update docs; `bun run preflight:fast`; run `bun test packages/gateway/src/finops packages/gateway/src/ipc/cost-rpc.test.ts packages/cli/src/commands/cost.test.ts packages/gateway/src/demo`.
- [x] **Step 3:** PR `feat: cost lines from FOCUS exports, allocation rules and cost views (Phase 7, slice 1)`; `gh pr merge --squash --auto`; resolve review threads.

---

## Slice 2 (PR 2): `nimbus cost why` and `nimbus cost rules check`

*Antigravity review 2026-11-26: APPROVED; binding fixes 1 to 5 and advisories 6 to 8 applied below (deploy window end, spike tie-break and near-spike window, own PR query, `distinctPrServiceColumns` path, target resolution over both ranges).*

Branch: `dev/asaf/phase7-s2-cost-why` from `origin/main` (after PR #2168, slice 1, merged). Spec § 4 (`cost why`), Fixes 6 (D48 boundary), Resolved 5 and Fixes 7 (currency), acceptance criterion 1.

**As built (branch `dev/asaf/phase7-s2-cost-why`, stacked on slice 1, 2026-11-26):** Tasks 1 to 6 shipped with these builder calls: movers name the provider service as `part`; `rulesInForce` handles a refused config in the pure layer; deploys of every environment are listed and carry a `runId` (`ci_run_external_id`, else the annotation metadata `run_id`); a non-GitHub repo gets a merge-commit gap; the demo acceptance asserts the owners GAP (spec acceptance names the owning service; the demo binds no repo to a service); `nimbus cost rules check` has its own CLI file. Final review fixes: one gather over both periods (one source rule), the deploy window reaches the day before a first-day spike, services ranked by net rise within each currency (round-robin), per-currency `coverage` and `unassigned`, freshness on rules check.

**What slice 1 left that this slice uses (verified 2026-11-26):** a cost line's service is the `set.service` output of the matching `[[cost.rule]]` (a `[ci.service.<id>]` / `[metrics.dora.<id>]` id); `finops/cost-view-input.ts` `gatherCostViewInput` gives the lines after the authoritative-source rule; `finops/cost-rules.ts` `allocate`; `finops/cost-views.ts` `periodWindow` (renamed field `range`, because D48 bans the identifier `window`).

**Index facts (verified 2026-11-26):**
- Deployments: `item.type = 'deployment'` joined to `deployment_items` (`nimbus_service_id`, `environment`, `sha`, `started_at_ms`, `finished_at_ms`, `conclusion`, `workflow_url`), indexes `idx_deployment_items_service_env_started`, `idx_deployment_items_sha` (`deployment/annotate.ts`). No PR link is stored: the PR is joined by sha.
- PR for a sha: `agents/_lib/oncall-queries.ts` `selectChangeForDeployment(db, sha, prServices)` (`item.type = 'pr'`, `metadata.merge_commit_sha`); PR services from `metrics/dora-config.ts` `distinctPrServiceColumns(repos)` (not re-exported by `metrics/dora.ts`). `selectChangeForDeployment` returns `OncallChange` (`id, title, url, service, mergedAtMs`, diffstat) with no repo, number or author, so this slice runs its own PR query (Task 2).
- Owners: `ownership/ownership-store.ts` `findServiceEntity(db, serviceId)` then `ownersOf(db, entityId)` (ranked `{ externalId, label, share, resolved }`).
- Service configs: `config/nimbus-toml.ts` `loadNimbusServiceConfigsFromConfigDir` (`ServiceConfig.repos`, `deployEnvironments`).
- D48: `finops/**` may not import `agents/` (including `_lib/`); D22(d) bars `agents/<name>.ts` outside `ipc/agents-rpc*` but not `agents/_lib/`. So the context query lives in `agents/_lib/cost-why-query.ts` and is called by the IPC layer, which combines its result with the `CostWhy` that `finops/cost-why.ts` computes; `finops/` never sees deploy, PR or owner types.
- Demo: the story deploy (`payment-service`, run `7412`, sha of `acme/payments#412`, about 11 minutes before seed time) and a background `payment-service` deploy about 22 hours earlier both fall on the two spike days the slice-1 demo export seeds.

### Task 1: The pure cost comparison (`finops/cost-why.ts`)

**Files:** Create `packages/gateway/src/finops/cost-why.ts`, `cost-why.test.ts`.

**Interfaces:**
- `previousRange(range: CostWindow): CostWindow` — the same number of days immediately before `range`.
- `resolveCostTarget(lines, rules, name): { kind: "product" | "service"; name: string } | { kind: "unknown"; known: { products: string[]; services: string[] } }` — a product name wins over a service id of the same name (the result says which it read). It is given the lines of BOTH the current and the previous range, so a target whose cost fell to 0 is still known (review fix 5).
- `compareCost(input: { lines; rules; target; range; previous; nowMs }): CostWhy` where `CostWhy = { target; range; previous; byCurrency: Record<string, { current: number; previous: number; change: number; changePct: number | null; spikeDay: string | null; movers: { service: string | null; part: string; provider: string; current: number; previous: number; change: number }[]; moversTruncated: number }>; services: string[]; provisionalFrom: string | null }`.
  - Only lines whose allocation matches the target (product, or rule `service` output) count; amounts per currency, never across currencies.
  - `changePct` is null when the previous amount is 0 (no division by zero; the CLI says "new").
  - `spikeDay`: the day in `range` whose amount minus the previous period's daily mean is largest and positive; on a tie the EARLIEST such day (the spike onset); null when no day exceeds it.
  - Movers: grouped by (rule service, part, provider), ranked by `|change|`, at most 10, the rest counted.
  - `services`: the distinct rule `service` outputs among the target's lines, movers with a positive change first.
- `provisionalFrom` follows `COST_PROVISIONAL_DAYS` (the label, never an exclusion; Resolved 7).

- [x] **Step 1:** Tests: previous range alignment (14d → the 14 days before); per-currency comparison with two currencies and no total; `changePct` null on a zero baseline; spike day picked on the demo-shaped series (flat then two high days) and null on a flat series; movers ranking and truncation count; a product target and a service target; an unknown target lists the known names; a target whose current cost is 0 but whose previous cost is not is still resolved (and shows the drop); a tie between two spike days picks the earlier; a refused config (`configError`) reads everything as unassigned and the target as unknown.
- [x] **Step 2:** Implement (pure; named steps, each function under the S3776 limit). Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): the cost comparison behind nimbus cost why`.

### Task 2: The change context query (`agents/_lib/cost-why-query.ts`)

**Files:** Create `packages/gateway/src/agents/_lib/cost-why-query.ts`, `cost-why-query.test.ts`.

**Interfaces:** `selectCostChangeContext(db, input: { serviceIds: readonly string[]; services: ReadonlyMap<string, ServiceConfig>; fromMs: number; toMs: number; spikeDayMs: number | null; maxDeploys?: number }): CostChangeContext[]`, one per service id: `{ serviceId; configured: boolean; deploys: { sha; environment; startedAtMs; finishedAtMs; conclusion; url; nearSpike: boolean; pr: { repo; number; title; url; author } | null }[]; deploysTruncated: number; owners: { label; share; resolved }[]; gaps: string[] }`.
- Deploys: `deployment_items` joined to `item` (`type = 'deployment'`) for the service in `[fromMs, toMs)` by `COALESCE(finished_at_ms, started_at_ms)`, all conclusions (shown), newest first, at most 10 (default), near-spike ones listed first. The IPC layer passes `fromMs = Date.parse(`${range.fromDay}T00:00:00Z`)` and `toMs = Date.parse(`${range.toDay}T00:00:00Z`) + DAY_MS`, so today's deploys are inside (review fix 1). `nearSpike` is `deployMs >= spikeDayMs - DAY_MS && deployMs < spikeDayMs + 2 * DAY_MS`, where `spikeDayMs` is the spike day's UTC midnight: the day before, the day and the day after (review fix 2).
- PR (review fix 3): its own bound-parameter query `SELECT i.id, i.title, i.url, i.external_id, i.metadata, p.display_name FROM item i LEFT JOIN person p ON p.id = i.author_id WHERE i.type = 'pr' AND i.service IN (…) AND json_valid(i.metadata) AND json_extract(i.metadata, '$.merge_commit_sha') = ? LIMIT 1`; `repo` and `number` from the metadata, falling back to splitting `external_id` (`owner/repo#N`); `author` is the person's display name, else `metadata.user`.
- PR services: the service's `distinctPrServiceColumns(repos)`; the PR is null when none matches, and a gap when the service has no repo configured.
- Owners: `findServiceEntity` + `ownersOf`, top 3; a gap when the service has no ownership entity.
- A service id with no `[ci.service]` / `[metrics.dora]` block: `configured: false`, no deploy query, gap "service X is not configured ([ci.service.X])".
- Read only; no write, no network, no model; bound parameters only (I9).

- [x] **Step 1:** Tests on real SQLite: a service with two deploys (one near the spike), a deploy later on `toDay` than midnight is inside the window, a deploy 37 h after the spike day's midnight is `nearSpike`, the PR joined by sha with repo, number and author, owners from a seeded ownership entity; a deploy outside the window excluded; an unconfigured service and a service with no owners produce the named gaps; the cap and truncation count.
- [x] **Step 2:** Implement. Run → PASS; `bun run audit:invariants` stays green (no D48/D22(d) change).
- [x] **Step 3:** Commit `feat(gateway): the deploy, pull request and owner context for a cost change`.

### Task 3: `cost.rulesCheck` (`finops/cost-rules-check.ts`)

**Files:** Create `packages/gateway/src/finops/cost-rules-check.ts`, `cost-rules-check.test.ts`.

**Interfaces:** `checkCostRules(input: CostViewInput): { range; configError; byCurrency: Record<string, { total; unassigned; unassignedPct: number | null }>; rules: { index; lines; amountByCurrency: Record<string, number>; unassignedLines: number }[]; unusedRules: number[]; topUnassigned: { provider; service; subAccount: string | null; tagKeys: string[]; lines; amountByCurrency: Record<string, number>; reason: string }[]; topUnassignedTruncated: number }` (top 10 by line count, the rest counted).

- [x] **Step 1:** Tests: per-rule counts including a rule that matched but produced an unsafe value (counted under that rule's `unassignedLines`); an unused rule listed; top unassigned grouped by (provider, service, sub-account, sorted tag keys) with the reason; a refused config reports the error and no rule counts.
- [x] **Step 2:** Implement. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): nimbus cost rules check`.

### Task 4: IPC `cost.why` and `cost.rulesCheck`

**Files:** Create `packages/gateway/src/ipc/cost-why-rpc.ts`, `cost-why-rpc.test.ts`; Modify `packages/gateway/src/ipc/cost-rpc.ts` (register both), `packages/gateway/src/ipc/cost-import-rpc.test.ts` (the LAN test list gains both).

- `cost.why { target: string; period?: string }` (default `14d`): owner kinds `cli`/`ui` (`ctx.getClientKind`), loads `[cost]` and the service configs from `configDir`, runs `gatherCostViewInput` for the current and previous ranges, `compareCost`, then `selectCostChangeContext` for `CostWhy.services` (at most 3), and returns `{ ...CostWhy, context }`. Unknown target → `-32602` with the known names. Answers on a demo gateway (its seeded lines and deploys).
- `cost.rulesCheck { period?: string }` (default `30d`): owner kinds `cli`/`ui`.
- Both LAN-forbidden by the namespace entry; neither on the renderer allowlist (I7 unchanged).
- Errors: the handlers throw `CostViewsRpcError` (or a subclass), which `cost-rpc.ts` `viaImport` already maps to `CostRpcError`.

- [x] **Step 1:** Tests: `cli` and `ui` served, every other kind refused; bad params `-32602`; an unknown target lists the known names; the result carries context only for the services in `CostWhy.services`; **no egress row** after either call; global `fetch` replaced by a throwing stub for the duration of the call is never reached; both refused over LAN.
- [x] **Step 2:** Implement. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost.why and cost.rulesCheck`.

### Task 5: CLI `nimbus cost why` and `nimbus cost rules check`

**Files:** Create `packages/cli/src/commands/cost-why-cli.ts`, `cost-why-cli.test.ts`; Modify `packages/cli/src/commands/cost.ts` (routing, usage), `packages/cli/src/commands/help.ts`.

- `nimbus cost why <product|service> [--period <N>d|week|month] [--json]`: per currency the current vs previous amount, the change and percent ("new" when the previous was 0), the spike day, the movers, then per service the deploys (near-spike first, with the PR number, title and author) and the owners, then the gaps, the provisional marker and the source freshness. Text output strips control characters and caps vendor strings at 200 characters. Exit 0 for a comparison, 1 for no cost data, an unknown target or an error.
- `nimbus cost rules check [--period ...] [--json]`: the unassigned share per currency, per-rule counts, unused rules, the top unassigned groups with their reasons. Exit 0, or 1 for a refused config, no cost data or an error.

- [x] **Step 1:** Tests over faked IPC results: rendering of each section, the "new" case, two currencies, an unknown target's known names, exit codes, `--json`.
- [x] **Step 2:** Implement (named steps; each function under the S3776 limit). Run → PASS.
- [x] **Step 3:** Commit `feat(cli): nimbus cost why and nimbus cost rules check`.

### Task 6: Demo acceptance, docs, slice close-out

**Files:** Create `packages/gateway/src/demo/cost-why-demo.test.ts`; Modify `docs/cli-reference.md`, `docs/architecture.md` (Cost lines section: `cost why`, the D48 split), `docs/roadmap.md` (Phase 7 rows: the cost-to-change join and the briefs row progress notes; status line "slice 2 of 8"), `docs/CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` (status line), the plan's slice-2 checkboxes on `dev/asaf/phase7-cost-pack`.

- [x] **Step 1:** Acceptance test (spec acceptance 1): seed the demo corpus, call `cost.why { target: "checkout" }` through `dispatchCostRpc` with the demo config dir; assert the spike day is the seed day or the day before, `payment-service` is the first service, its deploys include run `7412` with `nearSpike: true` and PR `acme/payments#412`, the payment-service context carries the "no ownership entry" gap (the demo binds no repo to a service; spec acceptance names the owning service), no egress row was written, and the throwing `fetch` stub was never called.
- [x] **Step 2:** Docs; `bun run preflight:fast`; the touched suites (`packages/gateway/src/finops`, `packages/gateway/src/agents/_lib`, `packages/gateway/src/ipc`, `packages/gateway/src/demo`, `packages/cli/src/commands`).
- [ ] **Step 3:** PR `feat: nimbus cost why joins a cost change to its deploys, pull requests and owners (Phase 7, slice 2)`; `gh pr merge --squash --auto`; resolve review threads.

**Review focus (slice 2):**
1. `finops/` imports nothing from `agents/` (D48); the context crosses only as plain data from the IPC layer.
2. A zero previous amount never divides (`changePct` null).
3. Two currencies give two comparisons and no total.
4. A deploy is listed for a service only when that service is configured and the deploy is in the window; nothing is guessed from names.
5. The demo answer is reached with no egress row and no `fetch`.

---

## Slice 3 (PR 3): `nimbus cost report` — report definitions, templates and rendering

*Antigravity review 2026-11-26: APPROVED WITH FIXES; binding fixes 1 to 3 and advisories 4 to 8 applied below (template real-path check, the previous calendar month, subject line breaks; multi-currency placeholders, `costFreshness` input, one gather over both periods, a single email address, Files lines).*

Branch: `dev/asaf/phase7-s3-cost-reports` from `origin/main` (after #2177). Spec § 5 (reports and templates), § 4 (`cost report`), Resolved 7 (provisional days, the previous full week), Resolved 9 (content in the body), Fixes 3 (template path confinement) and 4 (email subject). Nothing is SENT in this slice: it defines, renders and checks reports. Delivery, the `report` workflow step and the I55 extension are slice 4.

**Facts this slice builds on (verified 2026-11-26 on `b248ccad0`):**
- Layered config: an array of tables (`[[x]]`) follows "the highest layer that has blocks supplies all of them" (`config/layered-merge.ts` `mergeLayerDocs`); a sub-table under an array element (`[cost.report.channel.slack]` below `[[cost.report]]`) is NOT kept with its element (it becomes one plain section merged across every report). `parseSection` refuses any non `key = value` line, so a multi-line TOML string cannot be used for a template.
- D48 (`scripts/structure-audit/invariants/briefing-incident-workflow-toolgen.ts`): `finops/` may import `util/`, `config/`, `index/`, `db/`, `automation/`; not `chatops/ egress/ federation/ share/ llm/ engine/ agents/`, and `connectors/` only as types. So the door checks (`connectors/connector-writes/model-write-refusals.ts` `broadcastMentionIn`, `remote-content.ts` `remoteContentIn`) and the chat escapers (`chatops/escape-outbound.ts`, `agents/_lib/…`) are NOT importable from `finops/`.
- D20: a write tool id (`slack_message_post`, …) may be NAMED only in `connectors/connector-writes/` and its listed transport files — so slice 3 names channel KINDS (`slack`, `teams`, `gmail`, `outlook`), never tool ids.
- No shared confined file reader exists: `runbook/runbook-loader.ts` `readRunbookFile` (one handle, `O_NOFOLLOW`, post-read `lstat`) and `connectors/obsidian-sync.ts` `readNoteSource` (realpath + `util/path-overlap.ts` `isSameOrInside`) are private or forbidden; `finops/cost-import.ts` has private `readCapped` and the fatal `TextDecoder`.
- No row-level body or subject caps exist for the four rows; precedent `incident-update/update-send.ts` `UPDATE_TEXT_MAX = 12_000` ("Slack's `text` limit is 40,000 characters").
- Time zones: `automation/cron.ts` (`isValidTimeZone`, `machineTimeZone`, `scheduleRefusal`, `nextFire`), `util/zoned-time.ts` (`wallToInstantMs`, `wallOfInstant`, `gatewayZone`); no "previous full Monday–Sunday week in zone" helper exists.
- IPC naming is `namespace.methodName` camelCase (`cost.rulesCheck`, `cost.importRemove`); `cost.*` routes by prefix (`ipc/server/dispatchers/ops-rpcs.ts`), `cost` is in `FORBIDDEN_OVER_LAN` (covers any new method), and no `cost` method is on the renderer allowlist (I7).
- Reusable: `finops/cost-view-input.ts` `gatherCostViewInput`, `finops/cost-rules.ts` `allocate`, `finops/cost-why.ts` `previousRange`, `finops/cost-views.ts` `costFreshness`/`COST_PROVISIONAL_DAYS`, `util/code-unit-compare.ts`.

**Design rulings for this slice (builder; for review):**
1. **Config shape (deviates from the spec's example, which the layered reader cannot express).** Reports and channels are two arrays:
   ```toml
   [[cost.report]]
   name = "checkout-weekly"
   scope = { product = "checkout" }       # any of product, env, service, provider; all given must match
   period = "week"                        # week | month | <N>d
   schedule = "0 8 * * MON"               # optional (used by slice 4); validated now
   tz = "Europe/Berlin"                   # optional; default the gateway zone

   [[cost.report.channel]]
   report = "checkout-weekly"
   kind = "slack"                         # slack | teams | gmail | outlook
   to = "C0123ABC"                        # slack: channel id; teams: { team = "…", channel = "…" }; gmail/outlook: list of addresses
   format = "markdown"                    # per kind, see ruling 4
   template = "Checkout, week of {week_start}: {total} ({change}).\nTop: {top_movers}"
   # or template_file = "checkout-weekly.md"   (exactly one of the two)
   # subject = "…"                        # gmail/outlook only, required
   ```
   Each array follows the layered rule separately, so a role pack's reports stay while the owner adds channels in their own layer; a channel naming no defined report refuses the cost config. A report may have at most one channel per kind; at most 50 reports and 200 channels.
2. **IPC names:** `cost.reportList` and `cost.reportRender` (the repo convention), not the spec's `cost.report.render`; recorded as a spec correction.
3. **Door checks run outside `finops/`.** `finops/` renders (pure). `ipc/cost-report-rpc.ts` runs `broadcastMentionIn` and `remoteContentIn` (the same detectors the send door uses) on the template's own literal text (a template that already contains a broadcast mention or remote content is refused, naming it) and on every rendered body; the render result carries `doorRefusal: string | null` per channel. The send door in slice 4 still runs the full `messagingDestinationRefusal` on the real input.
4. **Formats per kind:** `slack`: `text | markdown` (mrkdwn); `teams`: `text | markdown | html`; `gmail`: `text` (the draft row is plain text); `outlook`: `text | html`. Any kind may add `csv` for `{breakdown}` only via `breakdown = "csv"` on the channel (renders the breakdown as a fenced CSV block for chat, an inline table in html). A format a kind does not support refuses the config.
5. **Size caps (builder; no row caps exist):** body `slack` 12 000, `teams` 12 000, `gmail`/`outlook` 100 000 characters; subject 255. `{breakdown}` and `{top_movers}` shrink first (rows dropped from the end, with "… and N more"); a body still over its cap is refused, never cut.
6. **Periods (Resolved 7):** `week` = the previous full Monday–Sunday week by the report zone's calendar; `month` = the previous full calendar month; `<N>d` (1–400) = the N days ending yesterday. Cost lines carry UTC charge days, so the zone picks WHICH dates; a stated bound says lines are not re-split by hour. Provisional days are labelled, never excluded.
7. **Escaping (Resolved 9):** every substituted value is stripped of control and format-invisible characters (`util/invisible-text.ts`) and capped at 128 characters before formatting; then per format: `html` HTML-escapes `& < > " '`; `slack`/`teams` `text`/`markdown` neutralise `< > & @ * _ ~` and backtick (each replaced by a visually close inert form or escaped, e.g. `&lt;`); `gmail`/`outlook` `text` only strip. The template's own literal text is the owner's and is not escaped. Rule outputs are already charset-validated (§ 3).

### Task 1: Report definitions in the cost config

**Files:** Create `packages/gateway/src/config/cost-report-toml.ts` (+ test); Modify `config/cost-toml.ts` (collect `cost.report` and `cost.report.channel` array blocks beside `cost.rule`; `NimbusCostConfig` gains `reports: readonly CostReportDef[]`; the plain-section reader still refuses any other `cost.*` header), `config/cost-toml.test.ts`.

**Interfaces:** `type CostReportScope = Partial<Record<"product" | "env" | "service" | "provider", string>>`; `interface CostReportChannelDef { kind: "slack" | "teams" | "gmail" | "outlook"; to: string | { team: string; channel: string } | readonly string[]; format: "text" | "markdown" | "html"; breakdown: "list" | "csv"; template: { inline: string } | { file: string }; subject: string | null }`; `interface CostReportDef { name: string; scope: CostReportScope; period: string; schedule: string | null; tz: string | null; channels: readonly CostReportChannelDef[] }`.

- [x] **Step 1:** Tests: the example above parses; a role-pack layer's reports plus owner-layer channels combine; unknown keys in either block refuse the whole cost config naming them; `name` must be `^[a-z0-9][a-z0-9-]{0,63}$` and unique; `scope` keys only the four, values `COST_SET_VALUE_RE`, at least one key; `period` refused outside `week|month|<N>d (1–400)`; `schedule` refused via `scheduleRefusal`; `tz` refused unless `isValidTimeZone`; a channel naming an unknown report, a second channel of the same kind for one report, a format the kind does not support, both or neither of `template`/`template_file`, a missing `subject` on gmail/outlook or one on slack/teams, a `subject` containing a control character or a line break (`
`, `
`) (review fix 3), a bad `to` per kind (Slack id `^[CDG][A-Z0-9]{2,}$`, Teams ids non-empty ≤ 256, addresses a simple `local@domain` check, 1–50 of them; a single string is accepted and normalised to a one-element list (review advisory 7)) each refuse with a reason; the caps 50 reports / 200 channels; `template_file` is a plain file name `^[A-Za-z0-9._-]{1,128}$` with no `/`, `\`, `..` or leading `.` (the read itself is Task 4); `nimbus config explain` shows the section (existing `cost` loader).
- [x] **Step 2:** Implement (named steps; each function under the S3776 limit; `cost-toml.ts` stays under 500 lines by keeping report parsing in the new file). Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost report definitions in the cost config`.

### Task 2: Report periods in a time zone (`finops/cost-report-period.ts`)

**Files:** Create `packages/gateway/src/finops/cost-report-period.ts`, `cost-report-period.test.ts`.

**Interfaces:** `reportPeriods(period: string, tz: string, nowMs: number): { range: CostWindow; previous: CostWindow; weekStart: string | null }` (`fromDay`/`toDay` are calendar dates in `tz`; `label` e.g. "week of Monday 2026-11-16"; `weekStart` is the Monday for `week`, else null). `previous` is the week before, the calendar month before (by wall-date math, NOT `finops/cost-why.ts` `previousRange`, which steps back the same number of days), or the N days before (review fix 2).

- [x] **Step 1:** Tests: `week` on a Wednesday, a Monday 00:30 local and a Sunday 23:30 local in `Europe/Berlin` and `America/Los_Angeles` give the previous full Monday–Sunday; across the DST changes of 2026 (EU 2026-03-29 / 2026-10-25, US 2026-03-08 / 2026-11-01) and across a year boundary (now = 2027-01-03); `month` in January gives the previous December, and its `previous` is the whole November; `month` in March gives February 1–28 with `previous` January 1–31 (never a day-count shift); `7d` ends yesterday local; an invalid zone throws (the config already refused it; defence in depth).
- [x] **Step 2:** Implement with `util/zoned-time.ts` `wallOfInstant` (D48-allowed). Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost report periods in the report's time zone`.

### Task 3: The report model (`finops/cost-report-model.ts`)

**Files:** Create `packages/gateway/src/finops/cost-report-model.ts`, `cost-report-model.test.ts`; Modify `finops/cost-views.ts` (`costFreshness` takes `{ lastDays; nowMs }`, a structural subset of `CostViewInput`, so existing callers are unchanged) (review advisory 5).

**Interfaces:** `buildCostReport(input: { lines: readonly CostLine[]; rules: readonly CostRule[]; configError: string | null; def: CostReportDef; range: CostWindow; previous: CostWindow; weekStart: string | null; nowMs: number; lastDays; empty: boolean }): CostReportModel` where `CostReportModel = { name; scope; range; previous; weekStart; byCurrency: Record<string, { total; previous; change; changePct: number | null; topMovers: { part; provider; service: string | null; change }[]; breakdown: { part; provider; env: string | null; amount }[]; unassigned; unassignedPct: number | null }>; provisionalFrom: string | null; freshness: CostFreshness[]; empty: boolean; configError: string | null; command: string }`.
- In scope = lines whose allocation has no `unassignedReason` and matches every scope key (`provider` matches the line's provider). `unassigned` is the currency's unassigned cost in the range over ALL lines (the share the report cannot attribute), never added to `total`.
- `topMovers`: at most 3 per currency by `|change|`; `breakdown`: by (part, provider, env), largest first, the full list (the template shrinks it).
- `command`: `nimbus cost report <name>`.

- [x] **Step 1:** Tests: scope by product, by service, by env + provider; two currencies give two blocks and no total anywhere in the model; `changePct` null on a zero previous; unassigned stated beside, not inside, the total; a refused config yields `configError` and nothing in scope; an empty store gives `empty: true`; provisional marking when the range touches the last 3 days.
- [x] **Step 2:** Implement (pure). Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): the cost report model`.

### Task 4: The confined template file (`finops/cost-template-file.ts`)

**Interfaces:** `readCostTemplateFile(configDir: string, file: string): string` (throws `CostTemplateError` with the reason). Resolves `join(configDir, "cost-templates", file)`; refuses a name failing Task 1's pattern; `lstat` of the directory and of the file must not be links; the file's real path (`realpathSync`) must be inside the directory's real path (`util/path-overlap.ts` `isSameOrInside`) — never compare a real path to the joined path by string (macOS `/var` → `/private/var`, Windows device prefixes) (review fix 1); opened once with `O_RDONLY | O_NOFOLLOW` (where defined) and `O_NONBLOCK`; `fstat` must be a regular file of ≤ 64 KiB; read through that handle; strict UTF-8 (`TextDecoder` fatal); post-read `lstat` must still not be a link.

- [x] **Step 1:** Tests (temp dirs, all OSes): a plain file reads; `../x`, an absolute name, `a/b`, a dot-file, a missing file, a directory, a 64 KiB + 1 file, invalid UTF-8, a file that is a link, and a `cost-templates` directory that is a link (junction on Windows) each refuse with a distinct reason; no read happens for an oversize file (size checked on the handle first).
- [x] **Step 2:** Implement. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): read cost report templates only from the cost-templates folder`.

### Task 5: Templates, escaping and caps (`finops/cost-template.ts`)

**Interfaces:** `COST_TEMPLATE_PLACEHOLDERS` (the closed set of spec § 5: `report_name period_start period_end week_start total currency change change_pct top_movers breakdown unassigned unassigned_pct freshness command`); `parseCostTemplate(text: string): CostTemplate` (throws `CostTemplateError` naming an unknown placeholder or an unbalanced brace; `{{`/`}}` are literal braces); `renderCostTemplate(t: CostTemplate, model: CostReportModel, opts: { kind; format; breakdown: "list" | "csv"; maxChars: number }): { text: string; truncated: { breakdown: number; topMovers: number } }` (throws `CostTemplateError` when over the cap with both lists empty); `renderCostSubject(...)` (plain text: every control character and line break stripped from substituted values, and the result refused if it still holds `
` or `
`; cap 255) (review fix 3); `COST_REPORT_BODY_MAX` per kind.
- Value formatting: amounts `1234.50 USD` (2 decimals, currency after); several currencies joined `; ` in code-unit order, for EVERY per-currency placeholder: `{currency}` (`EUR; USD`), `{total}`, `{change}`, `{change_pct}`, `{unassigned}` and `{unassigned_pct}` (review advisory 4); `{week_start}` is empty for a report whose period is not `week`; `change` signed (`+80.00 USD`), `change_pct` signed one decimal or `new`; `{total}` carries ` (provisional from <day>)` when provisional; `{freshness}` one line per source.
- Lists: `list` = one line per item (markdown/html bullets per format); `csv` = header `part,provider,env,currency,amount` with the `csv-cell` formula guard (`'` before `= + - @ \t \r`), fenced for chat, a table in html.

- [x] **Step 1:** Tests: every placeholder renders; an unknown placeholder and `{total` refuse naming them; `{{total}}` is literal; per-format escaping of a service named `<!here> *x* _y_ ~z~ `c` & @team` (Slack/Teams inert, HTML escaped, plain text unchanged apart from stripping); a 200-character tag value is capped at 128; two currencies never summed; a body over the cap drops breakdown then mover rows with "… and N more", and refuses when still over; the subject cap; CSV formula guard.
- [x] **Step 2:** Implement (pure; named steps). Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost report templates, per-channel escaping and caps`.

### Task 6: IPC `cost.reportList` and `cost.reportRender`

**Files:** Create `packages/gateway/src/ipc/cost-report-rpc.ts` (+ test); Modify `ipc/cost-rpc.ts` (register both), `ipc/cost-import-rpc.test.ts` (LAN list gains both).

- `cost.reportList {}` → `{ reports: { name; scope; period; schedule; tz; channels: { kind; format }[] }[]; configError }` (no destinations echoed beyond kind).
- `cost.reportRender { name, channel?: kind }` → `{ model: CostReportModel; channels: { kind; format; to; subject: string | null; body: string | null; truncated; error: string | null; doorRefusal: string | null }[] }` for every channel, or the named one. The handler computes `reportPeriods`, then runs ONE `gatherCostViewInput` over `[previous.fromDay, range.toDay]` (as `cost.why` does), so both periods use one source rule (review advisory 6). Per channel: read the template (inline or Task 4), parse, render; `error` holds a template or cap refusal; `doorRefusal` holds the broadcast or remote-content finding on the template literal or the rendered body (Slack `text`, Teams `body` as html when `format = "html"`, Outlook `html`).
- Owner kinds `cli`/`ui` (`requireOwner`); unknown report `-32602` listing the names; reads only: no network, no model, no egress row; LAN-forbidden by the namespace; not on the renderer allowlist.

- [x] **Step 1:** Tests: both methods served to `cli`/`ui`, refused otherwise; an unknown name lists the known ones; a template literal containing `<!channel>` and one with `<img src="https://x">` (Teams html) report `doorRefusal`; a tag value `<!here>` in the data does NOT trip the door after escaping; a missing template file reports `error` for that channel only; no egress row and a throwing `fetch` stub never reached; LAN refusal.
- [x] **Step 2:** Implement. Run → PASS.
- [x] **Step 3:** Commit `feat(gateway): cost.reportList and cost.reportRender`.

### Task 7: CLI `nimbus cost report`

**Files:** Create `packages/cli/src/commands/cost-report-cli.ts` (+ test); Modify `cost.ts` (route `report`, usage), `help.ts`.

- `nimbus cost report` (no name): lists the reports (name, scope, period, schedule, channel kinds). `nimbus cost report <name> [--channel <kind>] [--json|--csv]`: default text prints the model (per currency total, change, movers, breakdown, unassigned, freshness, provisional) and then each channel's rendered body exactly as it would be posted (or its `error` / `doorRefusal`); `--channel` prints that one body only (raw, for piping); `--csv` prints the breakdown with the fixed header; `--json` the IPC result. Exit 0 when every requested channel rendered with no refusal; 1 for no cost data, an unknown report, a refused config, any channel `error` or `doorRefusal`, or an IPC error. Text strips control characters (the bodies were already escaped for their channel).

- [x] **Step 1:** Tests over faked IPC: list, model text, one channel raw, `--csv`, `--json`, each exit code; the runner declares the `cli` kind first (extend the declare-kind test list).
- [x] **Step 2:** Implement. Run → PASS.
- [x] **Step 3:** Commit `feat(cli): nimbus cost report`.

### Task 8: Demo report, docs, slice close-out

**Files:** Modify `packages/gateway/src/demo/seed-cost.ts` (`DEMO_COST_TOML` gains report `checkout-weekly` with a Slack channel `C0DEMOCOST` in markdown and an Outlook draft channel in html with a subject; `[oncall.push]` stays the last table), `demo/seed-cost.test.ts`; Create `demo/cost-report-demo.test.ts`; docs `docs/cli-reference.md` (`nimbus cost report`, the `[[cost.report]]` / `[[cost.report.channel]]` keys under Configuration), `docs/architecture.md` (Cost lines section: reports and the D48 split for door checks), `docs/roadmap.md` (Phase 7 rows: reports progress; status "slices 1 to 3 of 8"), `docs/CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` status line, `.claude/commands/nimbus-ipc.md` (the `cost.*` row is stale: list every method), the plan's slice-3 checkboxes on `dev/asaf/phase7-cost-pack`.

- [x] **Step 1:** Acceptance test: seed the demo; `cost.reportRender { name: "checkout-weekly" }` renders both channels with no `error` and no `doorRefusal`, the Slack body names checkout's total for the previous full week and its top mover, the html body is escaped, no egress row, no `fetch`.
- [x] **Step 2:** Docs; `bun run preflight:fast`; the touched suites (`packages/gateway/src/finops`, `packages/gateway/src/config`, `packages/gateway/src/ipc`, `packages/gateway/src/demo`, `packages/cli/src/commands`); the per-file coverage floor on the Linux run before the PR.
- [ ] **Step 3:** PR `feat: nimbus cost report renders configured cost reports for Slack, Teams and email drafts (Phase 7, slice 3)`; `gh pr merge --squash --auto`; resolve review threads.

**As built (branch `dev/asaf/phase7-s3-cost-reports`, 2026-11-26):** Tasks 1 to 8 shipped. Spec corrections recorded by the builder: (a) a template's unknown placeholder or unbalanced brace is refused at RENDER, per channel, not at config load (spec § 5 said "at load"; refusing at load would refuse the whole cost config for one typo) — slice 4's `cost report schedule` must parse the template and subject before embedding them; (b) a bad report or channel refuses only the reports (`reportsError`), not the cost rules; (c) values are NFKC-normalised, then `< > & @` → `‹ › ⅋ (at)` (chat also `* _ ~ [ ]` and backtick look-alikes; html also `" '` entities and `= ( )` → `꞊ ❨ ❩`), because the door detectors decode entities and fold look-alikes; (d) the render runs the door's FULL destination check through `connectors/connector-writes/cost-report-rows.ts` (ChatOps channel first), with the policy from `enforcedPolicy().chatops`; (e) schedules use the workflow cron (numeric days). Slice-4 seams from the final review: send an explicit Teams/Outlook `contentType` (`html` only for `html`), decide whether the embedded step freezes a null `tz`, keep the `{ report }` subject source on the subject field only, and move the render-then-check sequence out of `ipc/` into one shared module.

**Review focus (slice 3):**
1. A tag or service name such as `<!here>`, `@channel`, `*x*`, `<img src=…>` reaching `{breakdown}` is inert in every channel's output, and the door detectors agree (no `doorRefusal`).
2. An unknown placeholder, an unbalanced brace, and a template literal with a broadcast mention or remote content are refused before any render, naming the problem.
3. `template_file` cannot be read from outside `<configDir>/cost-templates/` by `..`, an absolute name, a link file, a linked directory, or a race between check and read (one handle; post-read `lstat`).
4. Two currencies never produce a summed figure in the model, any format or the subject.
5. The previous full week is right across DST changes and the year boundary in a zone east and west of UTC.
6. A body over its cap shrinks the lists with a stated count, and is refused rather than cut when it still does not fit.

---

## Slice 4 (PR 4): scheduled delivery — the `report` step and the I55 `report` value source

*Antigravity review 2026-11-27: APPROVED WITH FIXES; binding fixes 1 to 6 applied below (a seventh constant site, `{report}` reference validation, the skip condition, the report outputs' data flow, the skip notification, the I55 stated-bound text).*

Branch: `dev/asaf/phase7-s4-cost-delivery` from `origin/main` (28f07036d, v11.17.0). Spec § 6 (unattended delivery and the I55 extension), Resolved 1 (the report definition is EMBEDDED), 2 (I59 refuses it), 7 (provisional), 8 (one workflow per channel), 9 (content bound), Fixes 1 (field-level restriction), 2 (no template hash in the rule scope), 4 (email subject), 10 (step schema). Owner rulings 2026-11-27: (1) a null `tz` is frozen to the gateway zone at generation; (2) a run whose period has no cost data is SKIPPED, recorded with the reason and notified locally; (3) `schedule` refuses to generate a channel the send door would refuse, naming the reason, and still generates the report's other channels.

**Facts this slice builds on (verified 2026-11-27 on 28f07036d):**
- Steps (`automation/workflow-steps.ts`): kinds `run | query | write`; one parser `parseWorkflowSteps` for save and run (re-parsed every run); write values are `{ const: JsonValue }` or `{ from: <EARLIER query label>, column }` (`parseWriteValue` 324-345, `validateReferences` 411-449); at most 32 fields, a `const` at most 8192 bytes. Steps are referenced by LABEL; indexes are 0-based inside, 1-based to the owner.
- Six places read "not `from`" as "constant" and would silently accept a new source as a constant: `workflow-write-step.ts:62,78,91` (`fieldSourcesOf`, `inputFor`), `standing-rule-derive.ts:100` (`scopeOfStep`), `workflow-import-prompt.ts:64-67` (`renderWriteValue`: "not const" is rendered as a query `from`) and `:145`; `workflow-steps.ts:405` (`referencesOf`) collects only `from` references, so `validateReferences` would ignore a `{report}` (review fixes 1, 2); plus `"const" in entry` at `standing-rule-step.ts:171` and `standing-rule-text.ts:193`. Kind switches: `workflow-dry-run.ts:55-98`, `workflow-import-prompt.ts:84-142`, `workflow-runner.ts:357-362`, `skippedOnResume` 523-525, `needsModel`/`nonRunStepLabels`.
- I55 (`engine/standing-rule-step.ts`): `accountedStep` (every field `"constant"` or `{query, column}`), `scopeMatches` (a `const` entry needs `"constant"` and an equal canonical value), `ruleStep` (workflow id + `workflowStepsSha256` + step + action type + tool), `doorRefusalStep` (via `standing/standing-rule-capability.ts` → `modelWriteRefusal`, ChatOps refused when the policy is unreadable), `claimStep`; inside `approvalPhase` (`engine/executor.ts:1364-1400`). Rule scope `ScopeEntry = {const} | {query, column}` (`standing/standing-rule-types.ts:7-9`). D44 (`scripts/structure-audit/invariants/standing-and-packs.ts`) pins provenance, tables, outcome, deps, unattended, learning, guard and step order. Enforcement test `security-invariants/i55-standing-rule.test.ts`. Docs `docs/SECURITY-INVARIANTS.md:2009-2035`.
- `workflowStepsSha256 = sha256(canonicalJson(parsedSteps))`: whatever the parsed `report` step holds is covered by the rule's existing workflow binding (Fixes 2).
- The four rows (`slack_message_post`, `teams_message_post`, `gmail_draft_create`, `outlook_draft_create`) are wave 2, not never-offered, no bound/confirm/refuse: workflow- and rule-eligible. D20 confines their ids to `connectors/connector-writes/`; `cost-report-rows.ts` already names them (`COST_REPORT_POST_TOOL_IDS`) with a private `inputFor`.
- Scheduler (`automation/workflow-scheduler.ts`): the only `trigger: "schedule"` producer; a blocked run (`UNATTENDED_NO_RULE_REASON`) is recorded `blocked_on_approval` and notified (`showIgnoringFailure`). A run-level `skipped` exists only for scheduler pre-checks (`recordSkippedFire`, no notification); a step-level `skipped` exists for writes with no matches.
- Saving: only `upsertWorkflowByName` (`workflow-store.ts:72-109`, same name updates in place and keeps the id), confined by D50(c) to `workflow-store.ts`, `ipc/automation-rpc/workflow.ts`, `automation/workflow-import.ts`; the `workflow.save` handler (`ipc/automation-rpc/workflow.ts:88-118`) runs `stepsSaveRefusal`, `refuseSuppliedClientKind`, `resolveSaveSchedule` (cli/ui only, valid cron and zone, no `run` step), then upsert.
- I59: `workflow-bundle.ts:188-195` refuses any kind but `query`/`write` ("a model (run) step is not allowed").
- Egress: every gated action is ledgered before dispatch (`executor.ts:1780-1825`), standing-approved or blocked.
- `CostReportModel.empty` means "no cost source ever synced", not "no line in the period".

**Design rulings for this slice (builder; for review):**
1. **The `report` step** (spec Fixes 10, Resolved 1): `{ kind: "report", label, report: { name, scope, period, tz, kind, format, breakdown, template, subject } }` — every value EMBEDDED as text (the template's TEXT, read once at generation; `tz` always a zone, frozen per owner ruling 1). Validated at save and at run by the same parser: the scope/period/kind/format rules of `config/cost-report-toml.ts`, the template and subject parsed with `parseCostTemplate` (an unknown placeholder refuses the save, closing slice 3's render-time deviation for scheduled reports), the template at most 64 KiB, the subject one line of at most 255, `label` unique like a query label. A workflow holding a `report` step may hold no `run` step (it is scheduled and unattended).
2. **The value source**, by label as the existing `from` is (spec said `{ report: <step index> }`): `{ report: "<an EARLIER report step's label>", part: "body" | "subject" }`. Allowed ONLY for the fields `REPORT_BODY_FIELDS` names, one table in `connectors/connector-writes/cost-report-rows.ts` (D20): `slack_message_post.text`, `teams_message_post.body`, `gmail_draft_create.body`/`subject`, `outlook_draft_create.body`/`subject` — `part: "subject"` only for a subject field, `part: "body"` only for a body field; and the write's tool must be the row for the report step's `kind` (a Slack report feeds only `slack_message_post`). Every other field (channel, team, `to`, `cc`, `bcc`, thread, `contentType`) must be a `const` (Fixes 1). Refused at save (`parseWorkflowSteps`) and again in `accountedStep`.
3. **I55 extension** (one commit: wiring + `docs/SECURITY-INVARIANTS.md` I55 text + tests): `fieldSources` gains `{ report: <step index>, part }`; `accountedStep` accepts it only per ruling 2 and only when the step at that index is a `report` step of the same parsed workflow; the rule scope gains `ScopeEntry {report: <step index>, part}` (derived by `scopeOfStep`), and `scopeMatches` requires the source to be exactly that entry (same index, same part) — no body hash in the scope (Fixes 2): the body is bound by the workflow hash over the embedded report step. The stated content bound (Resolved 9) is added to I55's Stated bounds. Static D44 gains clause `standing-report-source-confined`: the producer of a `report` step output is only `automation/workflow-report-step.ts`, and the `report` field-source literal appears only in the files that already hold `fieldSources`.
4. **Generation** (`nimbus cost report schedule <name> [--channel <kind>]`, IPC `cost.reportSchedule`, `cli` only): builds ONE workflow per channel named `cost-<report>-<kind>` (Resolved 8): step 1 the `report` step, step 2 the write step (destination fields `const`, body/subject `{report}`, Teams/Outlook `contentType` an explicit `const` — `"html"` only for `format = "html"`, else `"text"`), and the report's `schedule` (else the weekly default `0 8 * * 1`) in the frozen zone. It saves through the `workflow.save` handler's own logic, extracted in `ipc/automation-rpc/workflow.ts` as `saveWorkflowDefinition(...)` (so D50(c) is unchanged). Owner ruling 3: before saving, it renders the channel once and runs `costReportDoorRefusal` and the template-literal detectors; a refusal skips that channel with the reason. Regenerating replaces the workflow in place (same id) and changes its hash, so a standing rule stops matching until re-approved (Resolved 1); the output says so and prints the exact `nimbus approve add --workflow cost-<report>-<kind> --step 2` line.
5. **Running a report step** (`automation/workflow-report-step.ts`, the only producer): computes `reportPeriods(period, tz, now)`, gathers both periods in one `gatherCostViewInput` with the CURRENT `[cost]` config (rules, authoritative), builds the model, renders body and subject with the EMBEDDED template; the output `{ body, subject }` reaches later steps only through the `{report}` source. A render error fails the run (error, notified like other failures). Owner ruling 2: when no cost line of any source falls in the report's range, the report step returns `skipped: no cost data for <range>`; the runner ends the run with status `skipped` (new run-level outcome from inside the runner), records the reason, writes no egress row (nothing is dispatched) and notifies through the scheduler's `notify` (`showIgnoringFailure`). `skippedOnResume` treats a `report` step like a query (re-rendered on resume: a resume acts on current data, the SA4 bound).
6. **Where render + check lives**: a shared module `automation/cost-report-render.ts` (D48 keeps `finops/` pure; `automation/` may import `connectors/` values) holds `renderReportChannel(...)` used by `ipc/cost-report-rpc.ts` (slice 3's preview), the generator and the report step; `cost-report-rows.ts` exports `costReportPostInput(...)` (the per-kind field mapping) so no caller spells a tool id.
7. **I59**: `workflow-bundle.ts` keeps refusing a `report` step, with wording that names it ("a bundle holds query and write steps only: a report step is not allowed"); I59 unchanged.

### Task 1: The `report` step and the `{ report }` value source in the step parser

**Files:** Modify `packages/gateway/src/automation/workflow-steps.ts` (+ tests; split a `workflow-report-step-schema.ts` if it nears 500 lines); Modify `packages/gateway/src/connectors/connector-writes/cost-report-rows.ts` (`REPORT_BODY_FIELDS`, `costReportPostInput`, `reportRowFor(kind)`) (+ tests).

- Reference validation (review fix 2): `validateReferences` gains a `{report}` arm: the label names an EARLIER `report` step of the same workflow, `part` is `body` or `subject`, the field is in `REPORT_BODY_FIELDS` for that part, and the write's tool is the row for the report step's `kind`.

- [ ] **Step 1:** Tests: a valid two-step workflow parses and hashes stably; a `report` step with a bad scope/period/kind/format, an unknown placeholder, an unbalanced brace, a template over 64 KiB, a two-line subject, or a duplicate label is refused naming it; a `{report}` source that names a later or a non-report step, uses `part: "subject"` on a body field, sits on a destination field (`channel`, `teamId`, `to`, `cc`, `bcc`, `thread_ts`, `contentType`), or feeds a row of another kind is refused at save; a workflow with a `report` step and a `run` step is refused; the six "not `from` = constant" sites now treat `{report}` explicitly (a test per site that a `{report}` value is never read as a constant).
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): the report workflow step and its value source`.

### Task 2: Run a report step (`automation/workflow-report-step.ts`) and the shared render

**Files:** Create `packages/gateway/src/automation/cost-report-render.ts` (+ test), `packages/gateway/src/automation/workflow-report-step.ts` (+ test); Modify `automation/workflow-runner.ts` (dispatch the kind; `RunState` and `WriteStepRun` gain `reports: ReadonlyMap<label, { index; body; subject: string | null }>`, passed to `inputFor` and `fieldSourcesOf` in `workflow-write-step.ts` (review fix 4); the run-level `skipped` outcome; `skippedOnResume`), `automation/workflow-write-step.ts` (`inputFor`/`fieldSourcesOf` read `{report}`), `ipc/cost-report-rpc.ts` (use the shared render), `automation/workflow-dry-run.ts`, `automation/workflow-scheduler.ts` (an `onSkipped` callback in the runner params, like `onBlocked`; the scheduler notifies `Nimbus: cost report skipped` / `<workflow>: no cost data for <range>; nothing was posted` through its `notify` (`showIgnoringFailure`) (review fix 5)).

- The skip condition (review fix 3) is NOT `CostReportModel.empty` (no source ever synced): it is "no cost line of any source, in any currency, has a charge day inside the report's `range`" (computed over the gathered lines before the model is built). An empty store also skips, with the same reason.

- [ ] **Step 1:** Tests: a report step renders body and subject with the embedded template and the current rules; the write step receives them in exactly the fields that name them; a range with no cost line ends the run `skipped` with the reason, writes no egress row, and notifies once (a rejecting notifier does not crash); a render error fails the run; a resumed run re-renders; `nimbus cost report` (slice 3) output is unchanged through the shared module.
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): run report steps, and skip a report period with no cost data`.

### Task 3: The I55 extension (wiring + docs + enforcement test in ONE commit)

**Files:** Modify `engine/standing-rule-step.ts` (`accountedStep`, `scopeMatches`), `standing/standing-rule-types.ts` (`ScopeEntry`), `standing/standing-rule-derive.ts` (`scopeOfStep`), `standing/standing-rule-text.ts` (the rule text names "the report body of step N"), `engine/executor/audit-shape.ts` if it renders sources, `docs/SECURITY-INVARIANTS.md` (I55 Statement, Mechanism, Stated bounds, D44 text), `scripts/structure-audit/invariants/standing-and-packs.ts` (D44 clause `standing-report-source-confined` + fixtures), `security-invariants/i55-standing-rule.test.ts`.

- The I55 Stated bounds gain this text (review fix 6, Resolved 9): "A `report` value is the body or subject the gateway rendered from the owner's template embedded in the workflow (bound by the workflow hash) and the local cost index, with no model and no tool output. Rule outputs (`product`, `env`, `service`) are charset-validated (`^[A-Za-z0-9._:/@+-]{1,64}$`); every other substituted value is NFKC-normalised, stripped of control and invisible characters, capped at 128 characters and made inert for its channel; the shared door refusals (ChatOps channel, broadcast mention, remote content) then run on the final rendered text in `doorRefusalStep` before dispatch. A `report` value may fill only the body and subject fields `REPORT_BODY_FIELDS` names; every destination and routing field is a constant."

- [ ] **Step 1:** Tests in the I55 enforcement file: a scheduled run of a generated workflow with a matching rule is `standing_approved` with the rendered body, audited and ledgered, with no prompt; the same with no rule blocks and notifies (SA4); a rule whose scope says `{report: 0, part: "body"}` does not match a step whose body is a `const`, a `{from}`, a `{report}` of another step, or the subject part; a `{report}` on a destination field is never accounted (defence in depth beyond the parser); a regenerated workflow (changed template) no longer matches; `<!here>` in a tag value posts inert and passes the door; a template edited to `<!channel>` is refused by the door step (no rule applies → blocked). D44 clause fixtures: a `report` output produced outside `workflow-report-step.ts` is flagged.
- [ ] **Step 2:** Implement. Run → PASS; `bun run audit:invariants` green.
- [ ] **Step 3:** Commit `feat(gateway): standing rules approve a report body (I55 report value source)`.

### Task 4: Generate the workflows — `cost.reportSchedule` and `nimbus cost report schedule`

**Files:** Modify `ipc/automation-rpc/workflow.ts` (extract `saveWorkflowDefinition`); Create `packages/gateway/src/automation/cost-report-workflow.ts` (+ test: builds the steps JSON), `packages/gateway/src/ipc/cost-report-schedule-rpc.ts` (+ test); Modify `ipc/cost-rpc.ts`, `ipc/cost-import-rpc.test.ts` (LAN list); Create `packages/cli/src/commands/cost-report-schedule-cli.ts` (+ test); Modify `packages/cli/src/commands/cost.ts`, `cost-report-cli.ts` usage, `help.ts`.

- [ ] **Step 1:** Tests: `schedule checkout-weekly` saves `cost-checkout-weekly-slack` and `-outlook` with the embedded template text (a `template_file` read once), the frozen zone, the report's schedule (default `0 8 * * 1`), the explicit `contentType`, and prints the `nimbus approve add … --step 2` line per workflow; `--channel` limits it; a channel the door would refuse (ChatOps destination, `<!channel>` in the template, remote content in html) is skipped with the reason while the others save; regenerating keeps the id, changes the hash and says the rule must be re-approved; `cli` kind only (ui, mcp refused); LAN-forbidden; a demo gateway refuses (no scheduler there); the CLI declares the `cli` kind.
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat: nimbus cost report schedule generates one workflow per channel`.

### Task 5: I59, docs, slice close-out

**Files:** Modify `automation/workflow-bundle.ts` (report-step wording) (+ test), `automation/workflow-import-prompt.ts` (renders a report step if ever shown; never "MODEL STEP"); docs `docs/cli-reference.md` (`nimbus cost report schedule`, the delivery path, the approve line, the skip rule), `docs/architecture.md`, `docs/roadmap.md` (Phase 7: delivery row; the guardrail text changes to "cost data leaves only in a report the owner approved as a standing rule, and every post is in the ledger"; status "slices 1 to 4 of 8"), `docs/CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` status line, `.claude/commands/nimbus-standing-workflows.md`, the plan's checkboxes.

- [ ] **Step 1:** Acceptance test (spec acceptance 3): seed the demo-shaped data, generate `cost-checkout-weekly-slack`, approve step 2 with a rule, fire the schedule through the real scheduler with a fake Slack transport: one post with no prompt, `standing_approved` in the audit, one egress row, the body equal to the slice-3 render; with no rule it blocks and notifies; an Outlook channel creates a draft, never sends.
- [ ] **Step 2:** Docs; `bun run preflight:fast`; touched suites (`automation`, `engine`, `standing`, `security-invariants`, `connectors/connector-writes`, `ipc`, `finops`, `cli/src/commands`, `scripts/structure-audit`); the per-file coverage floor on the Linux run.
- [ ] **Step 3:** PR `feat: scheduled cost reports post under a standing rule (Phase 7, slice 4)`; `gh pr merge --squash --auto`; resolve review threads.

**Review focus (slice 4):**
1. No path reads a `{report}` value as a constant (the six sites), and no destination or routing field can take a `{report}` value, at save AND in `accountedStep`.
2. A rule approves exactly one workflow's report body for one field and part; a changed template, scope, period, zone or destination changes the hash and unmatches the rule.
3. The body is rendered by the gateway from the embedded template and local data only: no model, no tool output, no network; the door still runs on the final text.
4. An empty period skips with a notification and dispatches nothing; a render error fails; a block notifies — each exactly once.
5. I59 still refuses a `report` step in a bundle; D50(c) is unchanged.

---

## Slice 5 (PR 5): GitHub billing usage as cost lines

Branch: `dev/asaf/phase7-s5-github-cost` from `origin/main` (c10bd9889, slice 4 merged). Spec § sources ("GitHub Actions usage"), owner rulings 2026-11-27 below.

**Builder check of the endpoint (documentation-verified only; no live call was made).** `GET /organizations/{org}/settings/billing/usage` ([REST: Billing usage](https://docs.github.com/en/rest/billing/usage)): query `year`, `month`, `day` (default the current year); available only to organizations on the enhanced billing platform; the caller must be an organization owner (or billing manager); response `usageItems[]` with `date`, `product`, `sku`, `quantity`, `unitType`, `pricePerUnit`, `grossAmount`, `discountAmount`, `netAmount`, `organizationName`, optional `repositoryName`; statuses 200, 400, 403, 500, 503. No workflow field. The user endpoint `GET /users/{username}/settings/billing/usage` covers only Copilot billed to a personal account, so a personal account's Actions minutes are not available. The docs CONFLICT on tokens: the [usage-reporting tutorial](https://docs.github.com/en/billing/tutorials/automate-usage-reporting) says classic PATs only; the reference says a fine-grained token with "Administration" organization permission (read) works. The schema names no currency (GitHub bills in USD; the builder records lines in USD and states it). No pagination is documented.

**Owner rulings (2026-11-27):** (1) lines carry `repo` and the SKU, never a `workflow` (the API has none; the docs say so); (2) every GitHub product becomes lines (`serviceName` = the product: Actions, Packages, storage, Codespaces, Copilot…), and rules or a report scope narrow them; (3) the sync reuses the Vault `github.pat`; a 403 or 404 is a stated gap for that org, never an error loop; (4) orgs come from a configured list, `[cost.github] orgs = [...]`, and nothing is synced until it is set.

**Builder finding — the connectors-repo tool is deferred.** Every GitHub index path in this repo is a gateway syncable that calls the API through `SyncContext` with the Vault PAT (`connectors/github-actions-sync.ts`); none goes through a connector tool. A model-facing billing read tool is not needed for cost lines, so slice 5 is gateway-only (no connectors release, no pin bump). If a model-facing tool is wanted later it is its own row.

Design:

1. **Config** (`config/cost-toml.ts`): `[cost.github] orgs = ["acme"]` — 0 to 20 names, each `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, unique case-insensitively. Absent = no sync. A bad value refuses the `[cost]` config as every other `[cost]` error does.
2. **Pure mapper** (`finops/github-billing-lines.ts`, D48-clean): one `usageItems[]` entry → one `CostLine`: `source: "github_billing"`, `provider: "github"`, `billingAccountId` = the org (lowercased), `billingPeriod` = `YYYY-MM` of `date`, `chargeDay` = the UTC day of `date`, `serviceName` = `product`, `skuId` = `sku`, `repo` = `repositoryName ?? null`, `billedCost` = `netAmount`, `effectiveCost` = `netAmount`, `currency` = `USD`, `chargeCategory` = `usage`, `tags` = `{ unit_type, quantity }` as strings, `workflow` and `model` null. An entry with a missing required field, a non-finite amount, a date outside the requested month or another org's name is DROPPED and counted (never thrown); the sync reports the count.
3. **The intake door** (`finops/cost-sync-intake.ts`): `ingestSyncedCostLines(db, sourceId, month, lines)` replaces exactly the requested month's days up to today for `(sourceId, provider, account, period)` through `replaceCostLines` and records a `cost_import` ledger row (`kind: "sync"`), so a re-sync is idempotent and `nimbus cost import --remove` cannot target it by mistake (separate kind). Reached by a syncable ONLY through a new capability `replaceCostLinesForMonth` on `SyncCapabilities`, bound to the syncable's own service id (the capability cannot write another source's lines). **D24 extension:** `cost-line-confined` allows `replaceCostLines` and `recordCostImport` also in `finops/cost-sync-intake.ts`, and the new capability name only in `sync/` and the GitHub billing syncable; `docs/SECURITY-INVARIANTS.md` D24 text, the static rule and its fixtures in the same commit.
4. **The syncable** (`connectors/github-billing-cost-sync.ts`, companion service `github_billing` beside `github_actions`: `connector-secrets-manifest.ts` `github_billing: []`, catalog entry, `connector remove github` drops its lines through the existing `deleteCostLinesBySource` path): every 24 h, per configured org, fetches the current month and, until the 5th of a month, the previous one (restated days in an open month are replaced); rate limiter `github`; a GitHub Enterprise Server `github.api_base` skips with a stated gap (the endpoint is github.com only); no `github.pat` skips quietly; 403/404 records the gap "cannot read billing for <org>: the token needs org owner or billing-manager access and the org must be on GitHub's enhanced billing platform" once per run and moves on; 5xx retries on the next tick only. The gap reaches `nimbus cost products|why|report` freshness (the source's last day plus the gap line) and `nimbus connector status`.
5. **Demo:** a few seeded `github_billing` lines (Actions Linux minutes on `checkout`) so the demo's product views show GitHub cost.

**Fixes from the Antigravity review (slice 5, 2026-11-27: APPROVED WITH FIXES; each claim verified against the code). These override Design 1 to 5 and the tasks where they differ.**

1. **No sync ledger row.** `cost_import` (V109) has no `kind` column and `file_sha256` must be 64 characters; `removeCostImport` already accepts only `focus:<16 hex>` ids. The intake writes NO `cost_import` row; idempotency is `replaceCostLines`'s `unchanged` count. D24's `cost-line-confined` widens for `replaceCostLines` only (not `recordCostImport`). Drop the Task 3 ledger tests.
2. **The capability closes over the bound service id.** `buildSyncCapabilities(deps, serviceId)` (`sync/sync-capabilities.ts`) implements `replaceCostLinesForMonth(month, lines)` by calling `ingestSyncedCostLines(db, serviceId, month, lines, nowMs)`, which refuses any line whose `source !== serviceId`. The unbound and local-only capability builders refuse the call, as `replaceWorkSnapshot` does.
3. **Days to replace.** For the CURRENT UTC month: day 1 to today (UTC); for an EARLIER month: every calendar day of that month. All day arithmetic in UTC.
4. **Aggregate before writing.** Several `usageItems` can share a day and grain (product, SKU, repo); the `cost_line_grain` unique index would refuse duplicates. The mapper sums `billedCost`/`effectiveCost` (and the `quantity` tag) of entries with the same `(chargeDay, grain hash)`, as `focus-csv.ts` does, and sets every nullable `CostLine` field explicitly to `null`.
5. **Companion wiring (all of it).** `github_billing: ["github"]` in `SHARED_CREDENTIAL_GRANTS`; `github_billing: isGithubPatConfigured` in `DERIVED_CONFIGURED_CHECKS` (and its pin test's service list); `ipc/connector-rpc-handlers/removal.ts` unregisters it and calls `removeConnectorIndexData("github_billing")` when `github` is removed (and that path reaches `deleteCostLinesBySource`); `ipc/connector-rpc-handlers/status.ts` treats it beside `github_actions`; `connector-catalog.ts` (`CONNECTOR_SERVICE_IDS`, `CREDENTIALS_REUSED_FROM` → `github`, the OAuth-unsupported detail, a 24 h default interval); `connector-secrets-manifest.ts` `github_billing: []`.
6. **Where a gap lives.** The syncable's cursor (persisted by the scheduler in `sync_state.next_sync_token`) is `nimbus-ghb1:{ "gaps": { "<org>": "<fixed reason>" }, "synced": { "<org>": "<YYYY-MM-DD last sync>" } }`. `CostFreshness` gains `readonly gap?: string | null`; the cost RPCs (`ipc/`) read the cursor through the scheduler-state accessor and pass `sourceGaps` into the view input, so `finops/` never imports `sync/` (D48). `nimbus connector status github` shows the same gaps. A gap clears when that org next syncs.
7. **Advisory, adopted.** A 403 carrying GitHub's rate-limit headers (`x-ratelimit-remaining: 0` or `retry-after`) penalises the `github` limiter and is NOT a permission gap. A first sync for an org (no `synced` entry) fetches the current AND the previous month whatever the day. Each task below gains a **Files** line.

**Files per task (fix 7):** Task 1 `config/cost-toml.ts` (+ test). Task 2 `finops/github-billing-lines.ts` (+ test). Task 3 `finops/cost-sync-intake.ts` (+ test), `sync/sync-capabilities.ts`, `sync/types.ts` if the capability type lives there, `scripts/structure-audit/invariants/cost-line.ts` (+ fixtures in a new test file if the invariants test is baselined), `docs/SECURITY-INVARIANTS.md` D24. Task 4 `connectors/github-billing-cost-sync.ts` (+ test), `platform/assemble-sync-registrations.ts`, `connectors/connector-catalog.ts`, `connectors/connector-secrets-manifest.ts`, `sync/connector-configured.ts` (+ pin test), `ipc/connector-rpc-handlers/{removal,status}.ts`, `finops/cost-views.ts` (`CostFreshness.gap`), the cost RPC that builds the view input. Task 5 demo seed, docs, acceptance test.

### Task 1: `[cost.github] orgs`
- [ ] Tests: valid list; empty; >20; bad name; duplicate (case-insensitive); unknown key in `[cost.github]`; absent table. Implement. Commit `feat(gateway): [cost.github] orgs for the GitHub billing sync`.

### Task 2: The pure mapper
- [ ] Tests from the documented schema (fixtures marked "documentation-shaped, not a live response"): an Actions row with a repo, a Copilot row without one, a discount (net below gross), each drop reason counted, the month guard, the org guard, lowercase account. Implement. Commit `feat(gateway): map GitHub billing usage rows to cost lines`.

### Task 3: The intake door and the D24 extension (wiring + docs + static rule fixtures in ONE commit)
- [ ] Tests: replaces exactly the month's days up to today; idempotent re-run (`unchanged`); another source id refused by the capability; the ledger row kind; `cost import --remove` refuses a sync ledger id; D24 fixtures (the new allowed file clean, `replaceCostLines` named in a syncable refused, the capability named outside `sync/` and the syncable refused). Implement. Commit `feat(gateway): a sync capability that writes cost lines for its own source (D24)`.

### Task 4: The syncable
- [ ] Tests with a fake fetch (no network): no orgs → no call; no PAT → skip; GHES base → gap, no call; 200 → lines replaced; the 5th-of-month rule fetches two months; 403 and 404 → one gap each, no throw, other orgs still synced; 503 → no write, retried next tick; rate limiter acquired; `connector remove github` deletes the lines; companion registration and catalog/manifest sync tests. Implement and register in `platform/assemble-sync-registrations.ts`. Commit `feat(gateway): sync GitHub billing usage into cost lines`.

### Task 5: Demo, docs, close-out
- [ ] Demo lines; acceptance: with a fake GitHub returning two days of Actions rows for `acme/checkout`, `nimbus cost products` shows the GitHub cost under `checkout` (a `[[cost.rule]]` on `repo`), `cost why` lists it as a mover, and a second sync changes nothing. Docs: `cli-reference.md` (`[cost.github]`, what is and is not available, the token requirements and the docs' conflict), `architecture.md`, `roadmap.md` (slices 1 to 5 of 8; the "Raw cloud billing intake" row notes GitHub), `CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` status line, the `nimbus-connector-authoring` / `nimbus-file-map` skills. `bun run preflight:fast`, touched suites, the scoped Istanbul coverage check. PR `feat: GitHub billing usage as cost lines (Phase 7, slice 5)`; auto-merge; resolve threads.

**Review focus (slice 5):** the capability cannot write another source's lines or reach the table any other way; the mapper drops (never throws on) a malformed row and never trusts `organizationName`; a 403/404 never loops and is visible; GHES never calls github.com with the enterprise token; nothing is fetched until orgs are configured; the stated bounds (no workflow, USD, documentation-verified only, enhanced billing platform only, personal accounts unsupported) are in the docs.

## Slice 6 (PR 6): OpenAI and Anthropic costs as cost lines

Branch: `dev/asaf/phase7-s6-ai-costs` from `origin/main` (after slice 5, v11.19.0). Spec § sources ("OpenAI usage/costs and Anthropic usage/cost report"), owner rulings 2026-11-27 below. Builds on slice 5's intake door (`replaceCostLinesForMonth`, D24), its gap/pending cursor and freshness display.

**Builder check of the endpoints (documentation-verified only; no live call was made).**
- **OpenAI** — `GET https://api.openai.com/v1/organization/costs` ([reference](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/)): `Authorization: Bearer <admin key>`; `start_time` (Unix s, inclusive, required), `end_time` (exclusive), `bucket_width` `1d` only, `group_by[]` of `project_id`, `user_id`, `line_item`, `api_key_id`, `api_source` (unsupported combinations are a 400), `limit` 1–180 (default 7), `page` = the previous `next_page`. Response: `{ object: "page", data: [{ object: "bucket", start_time, end_time, results: [{ object: "organization.costs.result", amount: { value: <number>, currency: "usd" }, line_item, project_id, api_key_id, quantity, quantity_unit, user_id, api_source }] }], has_more, next_page }`. A `line_item` names a model and a cost kind (e.g. `"<model>, input"`). No organization id in the result.
- **Anthropic (legacy, stable)** — `GET https://api.anthropic.com/v1/organizations/cost_report` ([guide](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)): `x-api-key: <admin key>`, `anthropic-version`; `starting_at`/`ending_at` RFC 3339, daily buckets only, `group_by[]` of `workspace_id` and `description` (description grouping adds parsed fields such as `model`), `limit`, `page`; `has_more`/`next_page`. "All costs are in USD, reported as decimal strings in lowest units (cents)." Priority Tier costs are NOT included. The default workspace is `workspace_id: null`. Not available to individual Console accounts or the claude.ai Team plan; not on Claude Platform on AWS. The exact per-result field names come from the [Cost API reference](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve); the builder reads it before Task 3 and records the names in the mapper header, and fixtures are documentation-shaped. The newer Analytics cost endpoint is a beta (`anthropic-beta` header) and is NOT used (ruling 2).
- Both report the organization the admin key belongs to: one organization per key.

**Owner rulings (2026-11-27):** (1) Nimbus holds DEDICATED admin keys, Vault only: `openai_billing.admin_key` and `anthropic_billing.admin_key` — never the embeddings key `openai.api_key`, used only for the cost GET, and the docs state what such a key can also do (OpenAI: create and delete API keys, manage members; Anthropic: manage workspaces and keys); (2) Anthropic uses the legacy `cost_report`, not the beta analytics endpoint; (3) grain: `model` on every line and the OpenAI project / Anthropic workspace as the sub-account; no per-API-key or per-user rows.

Design:

1. **Generalise slice 5's cursor and gaps** (`finops/cost-source-gaps.ts`): the cursor codec takes the service's prefix; `readCostSourceGaps` reads every cost-sync service's stored cursor (`github_billing`, `openai_billing`, `anthropic_billing`). The per-account month loop (`monthsForOrg`/`syncOrg`, pending months, restatement window, own-property reads) moves from `github-billing-cost-sync.ts` to `connectors/cost-month-sync.ts`, parameterised by a `fetchMonth(account, month)` function; GitHub's syncable then uses it unchanged in behaviour (its tests are the regression net).
2. **Mappers** (pure, D48): `finops/openai-cost-lines.ts` — `source: "openai_billing"`, `provider: "openai"`, `billingAccountId: "openai"` (one org per key; the API names none), `subAccountId` = `project_id` (null = no project), `serviceName: "openai"`, `skuId` = `line_item`, `model` = the `line_item` text before the first `", "` (null when none), `billedCost`/`effectiveCost` = `amount.value`, `currency` = upper-cased `amount.currency`, `tags.unit` = `quantity_unit` when constant per line item; `finops/anthropic-cost-lines.ts` — `source: "anthropic_billing"`, `provider: "anthropic"`, `billingAccountId: "anthropic"`, `subAccountId` = `workspace_id` (null = default workspace), `serviceName: "anthropic"`, `skuId` = the description, `model` = the parsed `model`, cost = the cent string / 100 (parsed as a decimal string, never through a float of the raw cents beyond `Number`), `currency: "USD"`. Both: the UTC day of the bucket start, sum rows of the same day and grain, drop and count malformed rows, an all-malformed non-empty page is a retry (slice 5 lesson), a row outside the month or after today is dropped.
3. **Syncables** (`connectors/openai-cost-sync.ts`, `connectors/anthropic-cost-sync.ts`), each its own service with its own admin key (not a companion): daily; the current month, plus the previous month until the 5th, on the first sync and while pending; follows `next_page` up to 20 pages per month (more is a retry with a logged cap, never a partial write); 401/403 = a stated gap ("the key is not an admin key, or it lacks access"), 404 = gap ("this organization has no cost report: Anthropic's is not available to individual accounts or the Team plan" / OpenAI's equivalent), 429 or a rate-limited response = penalise that provider's limiter and retry, 5xx/malformed = retry; writes only through `replaceCostLinesForMonth` (extend `COST_SYNC_SERVICES`).
4. **Wiring:** catalog (`CONNECTOR_SERVICE_IDS`, 24 h interval, OAuth-unsupported detail "uses an organization admin key"), catalog meta, secrets manifest (`openai_billing: ["openai_billing.admin_key"]`, `anthropic_billing: ["anthropic_billing.admin_key"]`), configured by the key's presence (no derived check), `connector remove openai_billing` erases its lines (the generic path), `nimbus connector auth <id>` prints the key, egress: the syncables call only `api.openai.com` / `api.anthropic.com` (connector-hosts audit).
5. **Docs** state: documentation-verified only; one organization per key; the admin key's wider powers and that Nimbus uses it only for the cost GET; Priority Tier excluded (Anthropic); not for individual/Team accounts (Anthropic); USD; no per-key or per-user detail by ruling.

**Files per task:** Task 1 `finops/cost-source-gaps.ts` (+ test), `connectors/cost-month-sync.ts` (+ test), `connectors/github-billing-cost-sync.ts`. Task 2 `finops/openai-cost-lines.ts` (+ test). Task 3 `finops/anthropic-cost-lines.ts` (+ test). Task 4 `connectors/{openai,anthropic}-cost-sync.ts` (+ tests), `connectors/finops-syncables.ts`, `connectors/connector-catalog.ts`, `connectors/connector-oauth-unsupported.ts`, `connectors/connector-secrets-manifest.ts`, `catalog/connector-catalog-meta.ts`, `sync/sync-capabilities.ts` (`COST_SYNC_SERVICES`), the pinned lists those touch. Task 5 acceptance test, docs (`cli-reference.md` connector rows and a "AI provider costs" section, `architecture.md`, `roadmap.md` slices 1 to 6 of 8, `CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md`, `nimbus-file-map`).

**Fixes from the Antigravity review (slice 6, 2026-11-27: APPROVED WITH FIXES; each verified). These override Design 1 to 5 and the tasks where they differ.**

1. **Same-origin transport.** Both syncables send the admin key only through `fetchSameOriginOnly` (`connectors/same-origin-fetch.ts`, manual redirects, same-origin check), as the GitHub syncable does; a test proves a cross-origin redirect is refused and the key is never sent to the other host.
2. **No key is ever printed.** `nimbus connector auth openai_billing|anthropic_billing` prints the key NAME and how to set it (`nimbus vault set openai_billing.admin_key`), never a value: Design 4's "prints the key" means the name.
3. **Aggregate across pages.** A month's pages are collected first and mapped ONCE, so rows of one day and grain on two pages are summed, never written twice (the `cost_line_grain` unique index).
4. **Exact cents.** `centsToDollars(s)` shifts the decimal point on the string (sign kept, zero-padded) and converts once, so `"12345.678"` is `123.45678` exactly as `Number("123.45678")`, never `12345.678 / 100`.
5. **Query parameters, explicitly.** OpenAI: `start_time`, `end_time`, `bucket_width=1d`, `limit=180`, `group_by[]=project_id`, `group_by[]=line_item`. Anthropic: `starting_at`, `ending_at`, `bucket_width=1d`, `limit=31` (the documented maximum), `group_by[]=workspace_id`, `group_by[]=description`.
6. **400 is a stated gap** ("the vendor refused the cost request"), not a daily retry.
7. **A non-empty report that maps to no line is a retry** (all malformed, or all outside the requested range), so stored lines are never cleared by it; an empty `data`/`results` list still clears.
8. **D24 docs.** `docs/SECURITY-INVARIANTS.md`'s `cost-line-confined` paragraph names the three cost-sync services; Task 4 edits it in the same commit as `COST_SYNC_SERVICES`.
9. **Advisory, adopted.** The GitHub cursor names (`encodeGithubBillingCursor`, `decodeGithubBillingCursor`, `GithubBillingCursor`) stay as thin wrappers over the generic codec, so slice 5's tests compile unchanged.
10. **Advisory, adopted.** OpenAI `model` from `line_item`: split on `", "`; when the first part is a known non-model prefix (`fine-tuning`), the model is the second part; otherwise the first part; null when the text has no model part. Recorded as documentation-shaped (the docs give one example).
11. **Advisory, adopted.** Docs also state: Anthropic's cost report is not on Claude Platform on AWS; the default workspace (`workspace_id: null`) is a null sub-account.

**Anthropic Cost API reference, read (Task 3 step 1).** Results: `amount` (string, lowest units: `"123.45"` = $1.23), `currency` (always `"USD"`), `workspace_id` (null = default or not grouped), `description` (null unless grouped), `model` (null for non-token costs), `cost_type` (`tokens`, `web_search`, `code_execution`, `session_usage`), `token_type`, `service_tier` (`batch`/`standard`), `context_window`, `speed`, `inference_geo`. Buckets: `starting_at`, `ending_at`, `results`, oldest first, empty buckets included; `limit` 1 to 31. The mapper's grain uses `workspace_id` (sub-account), `description` (sku), `model`; `cost_type` and `service_tier` as tags (constant per description).

### Task 1: One month-sync loop and cursor for every cost sync
- [ ] Move the loop and the cursor codec; GitHub's tests unchanged and green; new tests for the generic loop (pending, window, own keys) and for gaps read across services. Commit `refactor(gateway): one month-sync loop and cursor for every cost sync`.

### Task 2: The OpenAI cost mapper
- [ ] Tests (documentation-shaped fixtures): a model line item with a project, no project, a line item with no model text, two pages' rows of one grain summed, currency upper-cased, every drop reason, the month and today guards. Commit `feat(gateway): map OpenAI organization costs to cost lines`.

### Task 3: The Anthropic cost mapper
- [ ] Read the Cost API reference first; record the field names. Tests: cents strings ("12345.678" → 123.45678), a null workspace, description and model, drops, guards. Commit `feat(gateway): map Anthropic cost reports to cost lines`.

### Task 4: The two syncables and their wiring
- [ ] Tests with a fake fetch: no key → no request; 200 across two pages; the page cap; 401/403/404 gaps; 429; 5xx; all-malformed page; restatement window and pending months; the key never sent to another host; registration, catalog/manifest/configured pins; `connector remove` erases lines. Commit `feat(gateway): sync OpenAI and Anthropic costs into cost lines`.

### Task 5: Docs, acceptance, close-out
- [ ] Acceptance: fake vendors return a day of costs for two models and two projects/workspaces; with a `[[cost.rule]]` on `sub_account`, `cost.products` shows each vendor's cost under its product per model; a re-sync changes nothing; a 401 shows its gap. Docs; preflight; scoped coverage; whole-branch review; PR with auto-merge.

**Review focus (slice 6):** the admin keys never leave the Vault except as the auth header to their own vendor host; the syncables can only write their own source's lines; cents parsing is exact; a malformed or partial (page-capped) report never clears a month; the Anthropic exclusions and the one-org-per-key bound are in the docs.

## Slice 7 (PR 7): the `finops` role pack and the Phase 7 close-out

**Owner rulings 2026-11-27 (supersede the spec's "official registry" wording):**
(a) `finops` 1.0.0 ships **bundled** in the gateway, like `pm`, `devops` and `developer`. Registry-published
packs are not built: no installer reads the signed index's `packs` map, `nimbus registry maintain` cannot add a
pack, and a pack entry has no publisher or trust rule (`docs/roadmap.md` already says so). That stays its own
unbuilt item. (b) The pack allowlist (`config/pack-settable.ts`, I47) is widened to exactly three cost defaults:
`[cost] internal_envs`, `[[cost.rule]]` and `[[cost.report]]`. **Not** `[[cost.report.channel]]`: a pack never
chooses where cost data goes. Not `[cost] authoritative`, `[cost.focus]` or `[cost.github]`. (c) Phase 7 stays
open after this slice: slice 8+ (every later cost source) is built in Phase 7, and the phase closes only after
the owner releases the agent-door launch copy (that row stays in Phase 7).

**Probe (done 2026-11-27):** `resolveCostConfig` over a pack layer alone accepts the rules and `internal_envs`,
and refuses a `[[cost.report]]` with no `scope` ("scope must name at least one of product, env, service,
provider"). So the pack's report carries a fixed scope.

**Task 1. The allowlist (I47 triple rule: wiring + docs + test in this commit).**
- `config/pack-settable.ts`:
  - `PACK_SETTABLE_LISTS` gains `cost.internal_envs` (per-call). Its parser is the strict string list, with each
    value matching `COST_SET_VALUE_RE` (the same set an env value may take), non-empty, at most 32 entries.
  - `PACK_SETTABLE_ARRAYS` gains `cost.rule` and `cost.report` (per-call). The header type widens from the
    literal `"fleet.job"` to a union, and `checkArraySection` dispatches on it: a fleet job stays checked by
    `checkJobBlock`, and a cost block is collected as raw lines.
  - After the loop, the cost sections (the `[cost]` section, if any, plus the collected cost blocks) are checked
    by the REAL compiler, not a copy: a new pure `config/pack-cost-check.ts` parses them as one pack layer
    (`parseLayerDoc` + `mergeLayerDocs`) and runs `resolveCostConfig`. A non-null `error` or `reportsError` is a
    fragment problem, prefixed `cost:`. A cost block that is not `key = value` is already refused by
    `resolveCostConfig` (passthrough check).
  - The `ok` result gains `cost: boolean` (the fragment sets any cost default).
- `packs/pack-layer-store.ts`: `CleanPack` gains `cost`, and `conflicts` gains `costConflicts`. **Only one
  installed pack may set cost defaults**: two would silently resolve as "the highest pack layer's rules win
  whole", so the second is refused `ERR_PACK_CONFLICT` ("cost defaults are also set by pack X"). The file is
  484 lines and must stay under 500.
- `packs/pack-prompt.ts`: `diffPacks` gains `cost: boolean` (the cost text changed), and the update prompt says
  "cost defaults changed" when it did. The full `defaults` text is already printed on every install and update
  prompt, so the owner sees every rule and report verbatim.
- Tests:
  - `pack-settable.test.ts`: update the pinned allowlist, and add accept/refuse cases:
    - accepted: the pack's exact fragment, `internal_envs` alone, a rule alone, a report alone;
    - refused: `[[cost.report.channel]]`, `[cost] authoritative`, `[cost.focus]`, `[cost.github]`, a rule with
      an unknown placeholder, a report with no scope, a bad env value, a cost line that is not `key = value`.
  - `pack-layer-store.test.ts`: a second cost-setting pack conflicts; a pack with no cost keys does not.
  - `pack-prompt.test.ts`: the cost-changed diff.
  - `security-invariants/i47-*.test.ts`: a pack can never set a report channel (the I47 statement's
    "allowlisted, local-only keys" stays true: cost rules and report definitions send nothing; a report posts
    only through a channel the owner wrote and a workflow the owner approved, I55/I29).

**Task 2. The pack.**
- `packs/bundled/finops.json`: `finops` 1.0.0, name "FinOps", roles `["finops"]`. `suggestedConnectors`:
  `vantage`, `kubecost`, `opencost`, `github_billing`, `openai_billing`, `anthropic_billing` (every id
  checked by `validatePackContent` against the catalog). No `agents.visible`: the cost briefs are CLI commands,
  not catalog agents. `defaults`:
  ```toml
  [cost]
  internal_envs = ["ci", "dev", "test", "staging"]

  [[cost.rule]]
  match = { tag = { product = "*", env = "*" } }
  set = { product = "{tag.product}", env = "{tag.env}" }

  [[cost.rule]]
  match = { tag = { product = "*" } }
  set = { product = "{tag.product}" }

  [[cost.report]]
  name = "prod-weekly"
  scope = { env = "prod" }
  period = "week"
  schedule = "0 8 * * 1"
  ```
  The rules are the tagging convention, product and env tags. A line with neither tag stays `unassigned`, which
  is what the views show today. The report is inert until the owner adds a `[[cost.report.channel]]` in their
  own file and runs `nimbus cost report schedule prod-weekly` (which generates the workflow the owner approves).
  An owner `[[cost.rule]]` or `[[cost.report]]` replaces the pack's whole set (the existing array-layer rule),
  and an owner `internal_envs` overrides the pack's.
- `packs/bundled-packs.ts`: import it. `bundled-packs.test.ts`: the id list becomes
  `["developer","devops","finops","pm"]`; all four install into one profile without conflict; the finops
  fragment resolves through `loadNimbusCostFromConfigDir` (the real layered reader, a temp config dir) to two
  rules, one report and the four envs. `ipc/pack-rpc.test.ts`: the `available` ids.

**Task 3. Docs (the five core docs, plus the close-out).**
- `docs/cli-reference.md`: the bundled pack list (L83 area and the Tip line), and a `finops` paragraph under
  the cost section: what it sets, that an owner rule or report replaces the pack's whole set, that it sets no
  channel.
- `docs/SECURITY-INVARIANTS.md` I47: the allowlist now includes three cost defaults, and a pack can never set
  a report channel; the one-cost-pack conflict.
- `docs/architecture.md`: the role-pack paragraph lists the cost defaults.
- `docs/roadmap.md` Phase 7:
  - the sequencing line says slices 1 to 7 of 8;
  - tick "A FinOps role pack" (bundled; registry-published packs remain the separate unbuilt item);
  - tick "Cost in the demo";
  - tick "`nimbus cost` briefs" (summary, why, owners, waste all shipped; verify `cost waste` before ticking);
  - the guardrail text changes to "cost data leaves only in a report the owner approved, at the prompt or once
    as a standing rule for that exact workflow, and every post is in the egress ledger" (already close; align
    it to the spec);
  - the acceptance criteria are replaced by the spec's five;
  - the moved-out rows move to where the spec put them: GC deletion to Phase 13; data FinOps attribution,
    further FinOps and sustainability connectors, and cost in the approval (Terraform) to Phase 8, each with
    "(moved from Phase 7 on 2026-11-26, owner)";
  - "Raw cloud billing intake" stays open (the cloud API pulls are slice 8+);
  - the Phase 14 revenue row: "Revenue as the other side of product cost (Stripe first, sources pluggable);
    Phase 7's product mapping is the key it joins on".
- `docs/CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` (only if a summary line becomes false), and `nimbus-file-map`.

**Antigravity review (2026-11-27, APPROVED WITH CHANGES), applied:**
(1) `checkArraySection` branches on the header: only `fleet.job` goes to `checkJobBlock` and `checkJobs`, and a
cost block is collected as a `DocSection`. (2) `config/pack-cost-check.ts` takes the already-parsed cost
`DocSection`s (no re-parse): `mergeLayerDocs([{ layer, sections }])` and then `resolveCostConfig`. (3) The list
entry is `{ section: "cost", key: "internal_envs" }`. (4) `pack-layer-store.ts` keeps the cost conflict inline in
`conflicts()` (no helper) to stay under 500 lines. (5) `pack-prompt.ts`: `fragmentParts` carries the cost text, the
update diff shows "Cost defaults: changed", and install/show list a `Cost defaults:` section (rule count, report
names, internal envs), so `pack show finops` never says the pack sets nothing. (6) Tests: re-installing or updating
the same cost pack does not conflict with itself; a second cost pack does. (7) cli-reference: an owner
`[[cost.report]]` replaces the pack's reports whole, so a channel naming `prod-weekly` then fails "no report
named"; copy the pack's block to keep it.

**Not in this slice:** registry-published packs; deleting the spec and plan (they wait for slice 8+).

**Verify:** `bun run preflight:fast`; the pack, config and security-invariant suites; `audit:file-size`;
`audit:doc-refs`; `audit:status-drift`.

## Slice 8 (PR 8): GitLab compute minutes as cost lines, priced by a configured rate

Branch: `dev/asaf/phase7-s8-gitlab-cost` from `origin/main` (0586051dc, slice 7 merged). Owner ruling 2026-11-27 ("finish phase 7": slice 8+ = GitLab, Bitbucket, Jenkins, AWS Cost Explorer, Azure Cost Management, GCP BigQuery billing, one PR each), owner rulings 2026-11-28 below. Builds on slices 5 and 6: the month loop (`connectors/cost-month-sync.ts`), the cursor and gaps (`finops/cost-source-gaps.ts`), the bound intake (`replaceCostLinesForMonth`, D24).

**Builder check of the endpoints (documentation-verified only, 2026-11-28; no live call was made).**
- **GitLab.com: GraphQL `ciMinutesProjectMonthlyUsage(namespaceId, date)`** ([queries](https://docs.gitlab.com/api/graphql/reference/queries/)). It returns `CiMinutesProjectMonthlyUsageConnection` (Relay pagination: `first`, `after`), and `date` defaults to the current month. Nodes have `minutes` (Int, compute minutes with the runner cost factor already applied), `sharedRunnersDuration` (Int, seconds) and `project { id fullPath name }`. It returns project usage even when no namespace record exists. `ciMinutesUsage(namespaceId, date)` holds the namespace totals, and its `projects` field is "Deprecated in GitLab 19.1", so it is NOT used. The page states no permission or token scope; the builder records that as unverified, and a 401/403/`null` result is a stated gap. Usage is a MONTH-TO-DATE total per project: there is no per-day figure.
- **Self-managed: no usage API.** `ciDedicatedHostedRunnerUsage` covers GitLab Dedicated only (Ultimate), and `runnerUsage`/`runnerUsageByProject` need the ClickHouse backend, so neither is used. Instead, the Jobs API ([jobs](https://docs.gitlab.com/api/jobs/)): `GET /groups/:id/projects?include_subgroups=true` lists the projects, then `GET /projects/:id/jobs` (descending id; `per_page` up to 100; keyset pagination recommended) gives each job's `duration` (the docs give decimal examples and state no unit; GitLab returns seconds, and the builder records that the docs leave the unit unstated), `finished_at`, and `runner { id, description, runner_type, is_shared }` (null for a job that never reached a runner). The page documents no role requirement.
- **Cost factors are not prices** ([compute minutes](https://docs.gitlab.com/ci/pipelines/compute_minutes/)): usage = job duration / 60 × cost factor, which is "not a monetary price". No GitLab endpoint returns money.
- **Rate limit:** 2,000 authenticated API requests per minute per user on GitLab.com ([rate limits](https://docs.gitlab.com/user/gitlab_com/rate_limits/)). Self-managed limits are instance-configured. Both paths use the shared `gitlab` limiter.

**Owner rulings (2026-11-28):**
1. Money comes from a CONFIGURED per-minute rate and currency per source, with a per-runner rate where the source has runners. Lines always carry the minutes. With no rate, lines are imported quantity-only and every brief names them as unpriced minutes.
2. GitLab covers both deployments with two paths. GitLab.com uses monthly per-project compute minutes. Self-managed uses per-day sums of job durations, per project and runner.
3. CI first: GitLab, then Bitbucket, then Jenkins, then AWS Cost Explorer, Azure Cost Management and GCP BigQuery billing.
4. *(For a later slice.)* The flag join: `[ci.service.<id>] feature_flags = ["launchdarkly:<project>", "unleash:<project>:<flag>", …]` is an explicit list. The brief shows the bound flags whose last change falls in the period, and says that only the latest change is known, because the index keeps no flag history.
5. Pricing: V110 adds the FOCUS columns `consumed_quantity` and `consumed_unit`, plus a `priced` flag. The sync stores the minutes and prices them with the current rate. When the rate changes, the next sync re-prices that source's stored lines locally, with no API call. An unpriced line has `billed_cost` 0 and `priced` 0. The sources that report a quantity (FOCUS `ConsumedQuantity`/`ConsumedUnit`, GitHub `quantity`/`unitType`, OpenAI `quantity`/`quantity_unit`) start filling it too.
6. GitLab.com's month-to-date total is turned into a DAILY DELTA: today's month-to-date minutes minus what that month's earlier days already hold, stored on the observed day. A missed sync's minutes land on the next synced day. A drop (a restatement) lowers the latest stored day of that project and month, never below 0, and the drop is stated. The docs and the brief say these minutes are "observed per day, not metered per day".

Design:

1. **V110** (`index/cost-line-v110-sql.ts`). `ALTER TABLE cost_line ADD COLUMN consumed_quantity REAL`, `ADD COLUMN consumed_unit TEXT CHECK (consumed_unit IS NULL OR length(consumed_unit) BETWEEN 1 AND 32)`, and `ADD COLUMN priced INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0,1))`. No backfill: existing lines are priced and have no quantity. The columns are MEASURES, so they are NOT in the grain hash. `CostLine` gains `consumedQuantity: number | null`, `consumedUnit: string | null` and `priced: boolean`. A line with `priced: false` must have `billedCost === 0` and `effectiveCost === null`, and the store refuses it otherwise. The store's "unchanged" comparison covers the new fields. The FOCUS reader, the GitHub mapper and the OpenAI mapper fill quantity and unit (Anthropic's report has none).
2. **Unpriced in the views.** `finops/cost-rollup.ts` and `cost-views.ts` sum `consumed_quantity` of `priced = 0` lines per (`consumed_unit`, source) beside each currency total, as `unpriced: [{ source, unit, quantity }]`. Text output says "plus 1,240 unpriced GitLab compute minutes (set a rate: [cost.gitlab] rate_per_minute)". `cost why` ranks movers by money only, and lists unpriced movers separately by quantity. The report model gains an `unpriced` placeholder (closed set, capped). The FOCUS-import totals check is unchanged.
3. **Config `[cost.gitlab]`** (`config/cost-toml.ts`, beside `[cost.github]`): `groups = ["top-group", "top-group/sub"]` (full paths, at most 50; nothing synced until set); `rate_per_minute` (finite, ≥ 0, optional); `currency` (ISO 4217 three letters, default `"USD"`); and, for self-managed only, `[cost.gitlab.runner_rates]` mapping a runner `description` to a per-minute rate (at most 100 entries; a job on an unlisted runner uses `rate_per_minute`). On GitLab.com, `runner_rates` is a config error ("GitLab.com minutes already include the runner cost factor"). The rate fingerprint is a SHA-256 of the canonical (rate, currency, runner_rates).
4. **Pure mappers** (D48, no I/O):
   - `finops/gitlab-minutes-lines.ts`, the GitLab.com path, does the delta. Inputs: the month, today's UTC day, the fetched `{ projectFullPath, minutes }[]`, the month's stored lines of this source, and the rate. Per project: `earlier` = the sum of the stored `consumed_quantity` on days before the observed day; `delta = minutes − earlier`. If `delta ≥ 0`, the observed day's line has quantity `delta`. If `delta < 0`, the observed day's line is 0, the latest earlier day with quantity is lowered by `|delta|` (never below 0, walking back), and a `restated` note is returned. Every earlier stored line is re-supplied unchanged, because the intake replaces the whole month. For a CLOSED month (synced on days 1–5 of the next month), the observed day is that month's last day. Line shape: `source "gitlab_billing"`, `provider "gitlab"`, `billingAccountId` = the top-level group path, `subAccountId` = the project full path, `serviceName "GitLab CI"`, `skuId "compute_minutes"`, `repo` = the project full path, `consumedUnit "minute"`, `chargeCategory "usage"`, tag `gitlab_deployment: "gitlab.com"`. With a rate, `billedCost = effectiveCost = quantity × rate` (rounded to 1e-9) and `priced: true`; with no rate, `billedCost` 0, `effectiveCost` null and `priced: false`.
   - `finops/gitlab-job-lines.ts`, the self-managed path: jobs → one line per (UTC day of `finished_at`, project, runner description). Quantity = Σ duration / 60 (minutes, unrounded), rate = `runner_rates[description] ?? rate_per_minute`, `resourceId` = the runner id, `resourceName` = the runner description, tags `runner_type` and `gitlab_deployment: "self-managed"`. Drops (counted): no runner, no `finished_at`, a non-finite or negative duration, outside the month, after today.
   - A shared `finops/rate-price.ts` prices a quantity with a rate and states rounding.
5. **Re-pricing.** A new bound capability, `repriceCostLines(rates)` (D24 extension, bound to the syncable's own source, in `sync/sync-capabilities.ts`), runs `UPDATE cost_line SET billed_cost = …, effective_cost = …, priced = … WHERE source = ?` per rate key. The rate key is stored in the tag `rate_key`: `"default"`, or `runner:<description>`. Lines whose key has no rate become unpriced. It runs inside one `dbExec` transaction through the store (`finops/cost-line-store.ts` keeps sole write ownership, I14). The syncable calls it BEFORE fetching when the cursor's rate fingerprint differs from the config's, then stores the new fingerprint. A re-price is not an API call and adds no egress row.
6. **A bound read for the delta**, `readOwnCostLinesForMonth(target)`: a D24 capability that returns only the bound source's lines for one (provider, account, month). It is read-only and used only by `gitlab_billing`.
7. **The syncable** (`connectors/gitlab-cost-sync.ts`) is a companion service `gitlab_billing` with the shared credential grant `gitlab_billing: ["gitlab"]` (`gitlab.pat`, `gitlab.api_base`). It runs daily. The path comes from the base: no `api_base`, or host `gitlab.com`, is the GitLab.com path; anything else is self-managed. GitLab.com: resolve each group's GraphQL id (`group(fullPath:) { id }`; null = a stated gap "group not found or not visible to this token"), then page `ciMinutesProjectMonthlyUsage(namespaceId, date: "<month>-01", first: 100)` up to 20 pages (more = retry with a logged cap, never a partial write). Self-managed: projects of each group (up to 2,000), then per project the jobs pages, newest first, until a job finished before the earliest month fetched, up to 50 pages of 100 per project. Hitting the cap is a `month_gap` ("more than 5,000 jobs in a month for <project>: that month is kept as stored"). Every request goes through `fetchSameOriginOnly` to the configured base; the PAT is sent only as `PRIVATE-TOKEN` to that origin. Status handling: 401/403 is a gap ("the token cannot read <group>'s usage: GitLab names no required role for this query"); 404 is a gap; 429 penalises the `gitlab` limiter and retries; 5xx or a malformed body retries; a non-empty page that maps to no line retries (the slice 5 lesson); GraphQL `errors[]` with no `data` is a gap stating the first message, capped at 200 chars. Writes go only through `replaceCostLinesForMonth`. `COST_SYNC_SERVICES` gains `gitlab_billing`.
8. **Wiring:** catalog (`CONNECTOR_SERVICE_IDS`, 24 h, companion of `gitlab`, configured when `gitlab.pat` exists AND `[cost.gitlab] groups` is non-empty), catalog meta, secrets manifest (`gitlab_billing: []`, shared only), `connector remove gitlab_billing` erases its lines, and the connector-hosts audit allows only the configured GitLab base.
9. **Docs** state: documentation-verified only; GitLab.com minutes are observed per day, not metered per day; compute minutes include GitLab's cost factor, and the rate is the owner's, not GitLab's price; self-managed minutes are wall-clock job minutes on the owner's runners, priced by the owner's rates; jobs on a runner the token cannot see have no runner and are dropped and counted; the token's needed role is not documented; Dedicated and ClickHouse runner usage are not read.

**Files per task:** Task 1 `index/cost-line-v110-sql.ts`, the migration registry and schema-ceiling pins (V110: `audit:status-drift`, `CLAUDE.md`/`GEMINI.md` "schema V110"), `finops/cost-line.ts`, `finops/cost-line-store.ts` (+ tests), `finops/focus-csv.ts`, `finops/github-billing-lines.ts`, `finops/openai-cost-lines.ts` (+ tests). Task 2 `finops/cost-rollup.ts`, `finops/cost-views.ts`, `finops/cost-why.ts`, `finops/cost-report-model.ts`, `finops/cost-template-values.ts` (+ tests), the CLI renderers in `packages/cli/src/commands/cost*.ts`. Task 3 `config/cost-toml.ts` (+ test), `finops/rate-price.ts` (+ test). Task 4 `finops/gitlab-minutes-lines.ts`, `finops/gitlab-job-lines.ts` (+ tests). Task 5 `sync/sync-capabilities.ts` (`repriceCostLines`, `readOwnCostLinesForMonth`, `COST_SYNC_SERVICES`, `SHARED_CREDENTIAL_GRANTS`), `sync/types.ts`, the D24 rule and fixtures under `scripts/structure-audit/invariants/`, `docs/SECURITY-INVARIANTS.md` § `cost-line-confined` (same commit). Task 6 `connectors/gitlab-cost-sync.ts` (+ test), `connectors/finops-syncables.ts`, the catalog, meta, oauth-unsupported and secrets-manifest files and their pinned lists. Task 7 the acceptance test and the docs.

### Task 1: V110 quantity columns, the `priced` flag, and quantity from the existing sources
- [ ] Tests first. V110 applies on a V109 database with lines, and they read back priced with a null quantity. A `priced: false` line with a non-zero cost is refused. A quantity change alone counts as `replaced`, not `unchanged`. The grain hash ignores quantity. FOCUS `ConsumedQuantity`/`ConsumedUnit` are read when present and blank becomes null. GitHub `quantity`/`unitType` and OpenAI `quantity`/`quantity_unit` are filled, and summed with the grain when rows merge. Commit `feat(gateway): cost lines carry their consumed quantity and a priced flag (V110)`.

### Task 2: Unpriced quantity in every cost view
- [ ] Tests: products/internal/why/report each show the unpriced minutes per source and unit beside the money; the text names the config key; a view with no unpriced lines prints nothing new (snapshot of an existing slice-3 report unchanged); the `{unpriced}` placeholder is escaped and capped; `--json` carries `unpriced[]`. Commit `feat: the cost views name unpriced minutes beside the money`.

### Task 3: `[cost.gitlab]` and the rate price
- [ ] Tests: groups validation (paths, the cap, empty = none); a negative, NaN or string rate is refused; the currency must be three letters; `runner_rates` is refused for a GitLab.com base (the check runs where the base is known, in the syncable, as a stated gap; the TOML layer validates the shape only); the fingerprint is stable under key order; `ratePrice` rounding. Commit `feat(gateway): [cost.gitlab] groups and per-minute rates`.

### Task 4: The two GitLab mappers
- [ ] Tests (documentation-shaped fixtures). Delta: a first sync puts the whole month-to-date total on today; the next day's sync stores only the difference; a missed day lands its minutes on the next one; a drop lowers the latest earlier day and never goes below 0, with the note; a closed month lands on its last day; a project with 0 minutes writes no line; with no rate every line is unpriced. Jobs: per day, project and runner, with each drop reason counted, the per-runner rate before the default, and the month and today guards. Commit `feat(gateway): map GitLab compute minutes and job durations to cost lines`.

### Task 5: The bound read and the re-price (D24, wiring + docs + rule fixtures in ONE commit)
- [ ] Tests: `readOwnCostLinesForMonth` returns only the bound source's lines, and a FOCUS line of the same account is not returned. `repriceCostLines` touches only its own source. A rate removed makes the lines unpriced, and a rate added prices them. One transaction: a failure leaves every line as it was. A service outside `COST_SYNC_SERVICES` is refused. The static D24 fixtures cover a direct `UPDATE cost_line` outside the store. Commit `feat(gateway): a cost sync re-prices and reads only its own lines (D24)`.

### Task 6: The `gitlab_billing` syncable and its wiring
- [ ] Tests with a fake fetch. No groups or no PAT makes no request. GitLab.com: the group id, then two pages, then the delta written; a null group is a gap; GraphQL `errors[]` is a gap; the page cap is a retry. Self-managed: projects, then jobs pages stopped at the month boundary; the 5,000-job cap is a `month_gap`; `runner_rates` on GitLab.com is a stated gap. A rate change re-prices before the fetch, with no request for the re-price itself. Both paths: 401/403/404 are gaps, 429 penalises, a 5xx retries; the PAT never goes to another origin; removing the connector erases its lines. Plus the catalog, manifest and configured pins. Commit `feat(gateway): sync GitLab compute minutes into cost lines`.

### Task 7: Acceptance, docs, close-out
- [ ] Acceptance, against a fake GitLab.com. Day 1: two projects with 100 and 40 minutes, no rate, so `cost.products` shows 140 unpriced minutes. Day 2: 130 and 40 minutes with `rate_per_minute = 0.01`, so day 2 holds 30 minutes and the whole month is re-priced to $1.70. A re-sync changes nothing. A 403 shows its gap. Second acceptance, against a fake self-managed instance: jobs on two runners with `runner_rates` give per-runner lines. Docs: `cli-reference.md` gains a "GitLab compute minutes" section and the `[cost.gitlab]` keys; `architecture.md` gets V110 and the delta; `roadmap.md` marks slice 8 of 8+ and adds the slice row; `CHANGELOG.md`; `CLAUDE.md`/`GEMINI.md` (schema V110); `nimbus-file-map`. Then preflight, scoped coverage, a whole-branch review, and a PR with auto-merge.


**Fixes from the Antigravity review (slice 8, 2026-11-28: APPROVED WITH FIXES; each verified against the code). These override Design 1 to 9 and the tasks where they differ.**

1. **One account per configured group.** `billingAccountId` = the configured `groups` entry as written, never the top-level group derived from it (`replaceCostLines` deletes per `(source, provider, billing_account_id, billing_period)` and day, `finops/cost-line-store.ts:166`, so two entries sharing an account would wipe each other). `[cost.gitlab] groups` refuses an entry that is an ancestor or descendant of another entry ("`top/sub` is inside `top`: list one of them"), so no project is counted twice.
2. **Re-price rewrites through the store, currency included.** `currency` is part of the grain hash (`cost-line-store.ts`), so an in-place `UPDATE … SET currency` would leave `grain_hash` stale. `repriceCostLines` reads the source's lines, re-prices each from `consumed_quantity` and its `rate_key`, and rewrites them per (provider, account, month) through `replaceCostLines`, recomputing the hash, in one transaction with parameterised statements (`dbRun`/`dbStmtRun`, never an interpolated `dbExec`; I9/I14). A line whose key has no rate becomes `priced` 0, `billed_cost` 0, `effective_cost` NULL.
3. **`rate_key` on every line.** GitLab.com lines carry `rate_key: "default"`. Self-managed lines carry `runner:<description>` when that description is in `runner_rates`, otherwise `default`. A line with no `rate_key` is never re-priced: it is left as stored and counted in the re-price result.
4. **The delta keeps every stored project.** Design 4's mapper re-supplies every earlier stored line unchanged, EXCEPT those the negative-delta walk-back lowered, which are re-supplied with their lower quantity and cost. Its project set is the UNION of the fetched projects and the projects in the month's stored lines. A stored project missing from the fetch (deleted, renamed or transferred) keeps its stored lines and gets no new line, so the intake never wipes it. Same-day re-sync: `earlier` counts only days before the observed day, so a second sync on the same day replaces that day's line (100 then 150 gives 150, never 250).
5. **The D24 surface is in the store.** `readCostLinesForAccountMonth(db, source, target)` and `repriceCostLines(db, source, rates)` live in `finops/cost-line-store.ts`. The intake (`finops/cost-sync-intake.ts`) wraps them for the capabilities. `scripts/structure-audit/invariants/cost-line.ts` `NAME_RULES` admits them only in STORE, INTAKE and CAPABILITIES. Task 5's files gain `finops/cost-line-store.ts`, `finops/cost-sync-intake.ts` and that rule file, all in the one D24 commit.
6. **File size.** `sync/sync-capabilities.ts` is at 458 lines. The cost capabilities (`replaceCostLinesForMonth` moved, plus the two new ones, and `COST_SYNC_SERVICES`) go to a new `sync/cost-sync-capabilities.ts` that builds them for a bound service. `sync-capabilities.ts` spreads its result, and is left smaller than it is now. The builder's own check is the same.
7. **Advisory, adopted: tests.** Same-day re-sync (100 then 150 gives 150). A multi-day walk-back (a drop of 150 against 100, then 80 on earlier days, lowers them to 0 and 30). Re-price on a currency change (lines move to `EUR`, re-hashed, no duplicate grain) and on a runner removed from `runner_rates` (those lines become unpriced with zero cost).

**Review focus (slice 8):** a delta never makes a month's stored total differ from GitLab's latest month-to-date total (except the stated floor at 0); the re-price and the bound read cannot reach another source; an unpriced line can never carry a cost; the PAT is sent only to the configured origin; a capped or malformed fetch never clears a month; no view sums money and minutes together.

## Slices 2–8 (each gets a detailed task list here before its code starts)

- **Slice 2 — detailed above.** Summary kept for the record: `finops/cost-why.ts` (pure; compares period vs previous, ranks moved lines); the deploy/PR/owner lookup lives OUTSIDE `finops/` in `agents/_lib/cost-why-query.ts`, passed in as data (D48). IPC `cost.why`, `cost.rulesCheck`; CLI `nimbus cost why <product|service> [--period 14d] [--json]`, `nimbus cost rules check`. Acceptance: the demo spike names the seeded deploy, PR and owner with no network.
- **Slice 3 — detailed above.** Summary kept for the record: **Reports.** `finops/cost-report-model.ts` (the JSON model), `finops/cost-report-render.ts` (text, markdown, html, csv), `finops/cost-template.ts` (closed placeholder set, per-channel escaping, unknown placeholder refused at load, values capped at 128 chars), `[[cost.report]]` config with per-channel `format`/`template`/`template_file` (confined to `<configDir>/cost-templates/`, no `..`, no absolute, no link, 64 KiB) and the email `subject`. CLI `nimbus cost report <name> [--json|--csv|--text]`, IPC `cost.report.render`.
- **Slice 4 owner rulings (2026-11-27):** (1) a report with no `tz` has the gateway zone frozen into the generated workflow; (2) a scheduled run with no cost data for its period is skipped (nothing posted), recorded with the reason and notified locally; (3) `nimbus cost report schedule` refuses to generate a channel the send door would refuse, naming the reason, and still generates the report's other channels.
- **Slice 4 — detailed above.** Summary kept for the record: **Delivery and the I55 extension.** `automation/workflow-steps.ts` gains the `report` step (output `{ body, subject? }`), produced only by `automation/workflow-report-step.ts`; the value source `{ report: <earlier step index> }` allowed only for `REPORT_BODY_FIELDS` (body of `slack_message_post`, `teams_message_post`, `gmail_draft_create`, `outlook_draft_create`, plus a templated draft subject), all destination/routing fields `constant`, checked at `workflow.save` and in `standingRuleStep` `accountedStep` AND `scopeMatches` (a `{ report }` source matches only the same step index in the rule's scope); refused in signed imports (I59 unchanged). Triple rule in one commit: wiring + `docs/SECURITY-INVARIANTS.md` I55 text (the stated content bound: rule outputs charset-validated, other values escaped and capped, door refusals on the final text) + tests; static D44 clause for the single producer. `nimbus cost report schedule <name>` generates one workflow per channel (`cost-<report>-<channel>`) embedding scope, period, tz, destination, subject and template TEXT. Acceptance: scheduled Slack post under a rule with no prompt, audited and ledgered; `<!here>` in a tag inert; no rule → blocks and notifies; email → draft only.
- **Slice 5 — detailed above.** GitHub billing usage (every product) as `github_billing` cost lines through a sync capability; repo + SKU, no workflow; configured orgs; gateway-only (the connectors-repo tool deferred, builder finding).
- **Slice 6 — detailed above.** OpenAI and Anthropic costs (dedicated Vault admin keys, Anthropic legacy cost_report, model + project/workspace grain) through the slice-5 intake door; gateway syncs.
- **Slice 7 — FinOps role pack and close-out.** `finops` 1.0.0 pack (defaults only, I47) in the official registry; roadmap Phase 7 rows ticked with what shipped and the acceptance criteria rewritten from the spec; the guardrail text changed to "cost data leaves only in a report the owner approved as a standing rule, and every post is in the ledger"; the Phase 14 revenue row (Stripe first, sources pluggable). Delete the spec and plan from `dev/asaf/phase7-cost-pack`.
- **Slice 8 (GitLab) — detailed above.** **Slice 9+ — later sources, one PR each (owner order 2026-11-28):** Bitbucket, Jenkins agent cost (via cloud lines tagged to agents, or a configured rate), cloud API pulls (AWS Cost Explorer, Azure Cost Management, GCP BigQuery billing) as connectors. Plus one slice for flag changes in the cost-to-change join (owner ruling 4 of 2026-11-28: `[ci.service.<id>] feature_flags`).
