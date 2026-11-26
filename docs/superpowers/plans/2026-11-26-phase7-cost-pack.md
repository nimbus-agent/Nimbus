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

- [ ] **Step 1:** Tests: the example above parses; a role-pack layer's reports plus owner-layer channels combine; unknown keys in either block refuse the whole cost config naming them; `name` must be `^[a-z0-9][a-z0-9-]{0,63}$` and unique; `scope` keys only the four, values `COST_SET_VALUE_RE`, at least one key; `period` refused outside `week|month|<N>d (1–400)`; `schedule` refused via `scheduleRefusal`; `tz` refused unless `isValidTimeZone`; a channel naming an unknown report, a second channel of the same kind for one report, a format the kind does not support, both or neither of `template`/`template_file`, a missing `subject` on gmail/outlook or one on slack/teams, a bad `to` per kind (Slack id `^[CDG][A-Z0-9]{2,}$`, Teams ids non-empty ≤ 256, addresses a simple `local@domain` check, 1–50 of them) each refuse with a reason; the caps 50 reports / 200 channels; `template_file` is a plain file name `^[A-Za-z0-9._-]{1,128}$` with no `/`, `\`, `..` or leading `.` (the read itself is Task 4); `nimbus config explain` shows the section (existing `cost` loader).
- [ ] **Step 2:** Implement (named steps; each function under the S3776 limit; `cost-toml.ts` stays under 500 lines by keeping report parsing in the new file). Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): cost report definitions in the cost config`.

### Task 2: Report periods in a time zone (`finops/cost-report-period.ts`)

**Interfaces:** `reportRange(period: string, tz: string, nowMs: number): CostWindow` (`fromDay`/`toDay` are calendar dates in `tz`; `label` e.g. "week of Monday 2026-11-16"), plus `weekStart: string | null` (the Monday, for `{week_start}`).

- [ ] **Step 1:** Tests: `week` on a Wednesday, a Monday 00:30 local and a Sunday 23:30 local in `Europe/Berlin` and `America/Los_Angeles` give the previous full Monday–Sunday; across the DST changes of 2026 (EU 2026-03-29 / 2026-10-25, US 2026-03-08 / 2026-11-01) and across a year boundary (now = 2027-01-03); `month` in January gives the previous December; `7d` ends yesterday local; an invalid zone throws (the config already refused it; defence in depth).
- [ ] **Step 2:** Implement with `util/zoned-time.ts` `wallOfInstant` (D48-allowed). Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): cost report periods in the report's time zone`.

### Task 3: The report model (`finops/cost-report-model.ts`)

**Interfaces:** `buildCostReport(input: { lines: readonly CostLine[]; rules: readonly CostRule[]; configError: string | null; def: CostReportDef; range: CostWindow; previous: CostWindow; nowMs: number; lastDays; empty: boolean }): CostReportModel` where `CostReportModel = { name; scope; range; previous; weekStart; byCurrency: Record<string, { total; previous; change; changePct: number | null; topMovers: { part; provider; service: string | null; change }[]; breakdown: { part; provider; env: string | null; amount }[]; unassigned; unassignedPct: number | null }>; provisionalFrom: string | null; freshness: CostFreshness[]; empty: boolean; configError: string | null; command: string }`.
- In scope = lines whose allocation has no `unassignedReason` and matches every scope key (`provider` matches the line's provider). `unassigned` is the currency's unassigned cost in the range over ALL lines (the share the report cannot attribute), never added to `total`.
- `topMovers`: at most 3 per currency by `|change|`; `breakdown`: by (part, provider, env), largest first, the full list (the template shrinks it).
- `command`: `nimbus cost report <name>`.

- [ ] **Step 1:** Tests: scope by product, by service, by env + provider; two currencies give two blocks and no total anywhere in the model; `changePct` null on a zero previous; unassigned stated beside, not inside, the total; a refused config yields `configError` and nothing in scope; an empty store gives `empty: true`; provisional marking when the range touches the last 3 days.
- [ ] **Step 2:** Implement (pure). Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): the cost report model`.

### Task 4: The confined template file (`finops/cost-template-file.ts`)

**Interfaces:** `readCostTemplateFile(configDir: string, file: string): string` (throws `CostTemplateError` with the reason). Resolves `join(configDir, "cost-templates", file)`; refuses a name failing Task 1's pattern; `lstat` of the directory and of the file must not be links; `realpathSync.native` of the directory must equal its path, and the file's real path must be inside it (`util/path-overlap.ts` `isSameOrInside`); opened once with `O_RDONLY | O_NOFOLLOW` (where defined) and `O_NONBLOCK`; `fstat` must be a regular file of ≤ 64 KiB; read through that handle; strict UTF-8 (`TextDecoder` fatal); post-read `lstat` must still not be a link.

- [ ] **Step 1:** Tests (temp dirs, all OSes): a plain file reads; `../x`, an absolute name, `a/b`, a dot-file, a missing file, a directory, a 64 KiB + 1 file, invalid UTF-8, a file that is a link, and a `cost-templates` directory that is a link (junction on Windows) each refuse with a distinct reason; no read happens for an oversize file (size checked on the handle first).
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): read cost report templates only from the cost-templates folder`.

### Task 5: Templates, escaping and caps (`finops/cost-template.ts`)

**Interfaces:** `COST_TEMPLATE_PLACEHOLDERS` (the closed set of spec § 5: `report_name period_start period_end week_start total currency change change_pct top_movers breakdown unassigned unassigned_pct freshness command`); `parseCostTemplate(text: string): CostTemplate` (throws `CostTemplateError` naming an unknown placeholder or an unbalanced brace; `{{`/`}}` are literal braces); `renderCostTemplate(t: CostTemplate, model: CostReportModel, opts: { kind; format; breakdown: "list" | "csv"; maxChars: number }): { text: string; truncated: { breakdown: number; topMovers: number } }` (throws `CostTemplateError` when over the cap with both lists empty); `renderCostSubject(...)` (plain text, cap 255); `COST_REPORT_BODY_MAX` per kind.
- Value formatting: amounts `1234.50 USD` (2 decimals, currency after); several currencies joined `; ` in code-unit order; `change` signed (`+80.00 USD`), `change_pct` signed one decimal or `new`; `{total}` carries ` (provisional from <day>)` when provisional; `{freshness}` one line per source.
- Lists: `list` = one line per item (markdown/html bullets per format); `csv` = header `part,provider,env,currency,amount` with the `csv-cell` formula guard (`'` before `= + - @ \t \r`), fenced for chat, a table in html.

- [ ] **Step 1:** Tests: every placeholder renders; an unknown placeholder and `{total` refuse naming them; `{{total}}` is literal; per-format escaping of a service named `<!here> *x* _y_ ~z~ `c` & @team` (Slack/Teams inert, HTML escaped, plain text unchanged apart from stripping); a 200-character tag value is capped at 128; two currencies never summed; a body over the cap drops breakdown then mover rows with "… and N more", and refuses when still over; the subject cap; CSV formula guard.
- [ ] **Step 2:** Implement (pure; named steps). Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): cost report templates, per-channel escaping and caps`.

### Task 6: IPC `cost.reportList` and `cost.reportRender`

**Files:** Create `packages/gateway/src/ipc/cost-report-rpc.ts` (+ test); Modify `ipc/cost-rpc.ts` (register both), `ipc/cost-import-rpc.test.ts` (LAN list gains both).

- `cost.reportList {}` → `{ reports: { name; scope; period; schedule; tz; channels: { kind; format }[] }[]; configError }` (no destinations echoed beyond kind).
- `cost.reportRender { name, channel?: kind }` → `{ model: CostReportModel; channels: { kind; format; to; subject: string | null; body: string | null; truncated; error: string | null; doorRefusal: string | null }[] }` for every channel, or the named one. Per channel: read the template (inline or Task 4), parse, render; `error` holds a template or cap refusal; `doorRefusal` holds the broadcast or remote-content finding on the template literal or the rendered body (Slack `text`, Teams `body` as html when `format = "html"`, Outlook `html`).
- Owner kinds `cli`/`ui` (`requireOwner`); unknown report `-32602` listing the names; reads only: no network, no model, no egress row; LAN-forbidden by the namespace; not on the renderer allowlist.

- [ ] **Step 1:** Tests: both methods served to `cli`/`ui`, refused otherwise; an unknown name lists the known ones; a template literal containing `<!channel>` and one with `<img src="https://x">` (Teams html) report `doorRefusal`; a tag value `<!here>` in the data does NOT trip the door after escaping; a missing template file reports `error` for that channel only; no egress row and a throwing `fetch` stub never reached; LAN refusal.
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): cost.reportList and cost.reportRender`.

### Task 7: CLI `nimbus cost report`

**Files:** Create `packages/cli/src/commands/cost-report-cli.ts` (+ test); Modify `cost.ts` (route `report`, usage), `help.ts`.

- `nimbus cost report` (no name): lists the reports (name, scope, period, schedule, channel kinds). `nimbus cost report <name> [--channel <kind>] [--json|--csv]`: default text prints the model (per currency total, change, movers, breakdown, unassigned, freshness, provisional) and then each channel's rendered body exactly as it would be posted (or its `error` / `doorRefusal`); `--channel` prints that one body only (raw, for piping); `--csv` prints the breakdown with the fixed header; `--json` the IPC result. Exit 0 when every requested channel rendered with no refusal; 1 for no cost data, an unknown report, a refused config, any channel `error` or `doorRefusal`, or an IPC error. Text strips control characters (the bodies were already escaped for their channel).

- [ ] **Step 1:** Tests over faked IPC: list, model text, one channel raw, `--csv`, `--json`, each exit code; the runner declares the `cli` kind first (extend the declare-kind test list).
- [ ] **Step 2:** Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(cli): nimbus cost report`.

### Task 8: Demo report, docs, slice close-out

**Files:** Modify `packages/gateway/src/demo/seed-cost.ts` (`DEMO_COST_TOML` gains report `checkout-weekly` with a Slack channel `C0DEMOCOST` in markdown and an Outlook draft channel in html with a subject; `[oncall.push]` stays the last table), `demo/seed-cost.test.ts`; Create `demo/cost-report-demo.test.ts`; docs `docs/cli-reference.md` (`nimbus cost report`, the `[[cost.report]]` / `[[cost.report.channel]]` keys under Configuration), `docs/architecture.md` (Cost lines section: reports and the D48 split for door checks), `docs/roadmap.md` (Phase 7 rows: reports progress; status "slices 1 to 3 of 8"), `docs/CHANGELOG.md`, `CLAUDE.md`/`GEMINI.md` status line, `.claude/commands/nimbus-ipc.md` (the `cost.*` row is stale: list every method), the plan's slice-3 checkboxes on `dev/asaf/phase7-cost-pack`.

- [ ] **Step 1:** Acceptance test: seed the demo; `cost.reportRender { name: "checkout-weekly" }` renders both channels with no `error` and no `doorRefusal`, the Slack body names checkout's total for the previous full week and its top mover, the html body is escaped, no egress row, no `fetch`.
- [ ] **Step 2:** Docs; `bun run preflight:fast`; the touched suites (`packages/gateway/src/finops`, `packages/gateway/src/config`, `packages/gateway/src/ipc`, `packages/gateway/src/demo`, `packages/cli/src/commands`); the per-file coverage floor on the Linux run before the PR.
- [ ] **Step 3:** PR `feat: nimbus cost report renders configured cost reports for Slack, Teams and email drafts (Phase 7, slice 3)`; `gh pr merge --squash --auto`; resolve review threads.

**Review focus (slice 3):**
1. A tag or service name such as `<!here>`, `@channel`, `*x*`, `<img src=…>` reaching `{breakdown}` is inert in every channel's output, and the door detectors agree (no `doorRefusal`).
2. An unknown placeholder, an unbalanced brace, and a template literal with a broadcast mention or remote content are refused before any render, naming the problem.
3. `template_file` cannot be read from outside `<configDir>/cost-templates/` by `..`, an absolute name, a link file, a linked directory, or a race between check and read (one handle; post-read `lstat`).
4. Two currencies never produce a summed figure in the model, any format or the subject.
5. The previous full week is right across DST changes and the year boundary in a zone east and west of UTC.
6. A body over its cap shrinks the lists with a stated count, and is refused rather than cut when it still does not fit.

---

## Slices 2–8 (each gets a detailed task list here before its code starts)

- **Slice 2 — detailed above.** Summary kept for the record: `finops/cost-why.ts` (pure; compares period vs previous, ranks moved lines); the deploy/PR/owner lookup lives OUTSIDE `finops/` in `agents/_lib/cost-why-query.ts`, passed in as data (D48). IPC `cost.why`, `cost.rulesCheck`; CLI `nimbus cost why <product|service> [--period 14d] [--json]`, `nimbus cost rules check`. Acceptance: the demo spike names the seeded deploy, PR and owner with no network.
- **Slice 3 — detailed above.** Summary kept for the record: **Reports.** `finops/cost-report-model.ts` (the JSON model), `finops/cost-report-render.ts` (text, markdown, html, csv), `finops/cost-template.ts` (closed placeholder set, per-channel escaping, unknown placeholder refused at load, values capped at 128 chars), `[[cost.report]]` config with per-channel `format`/`template`/`template_file` (confined to `<configDir>/cost-templates/`, no `..`, no absolute, no link, 64 KiB) and the email `subject`. CLI `nimbus cost report <name> [--json|--csv|--text]`, IPC `cost.report.render`.
- **Slice 4 — Delivery and the I55 extension.** `automation/workflow-steps.ts` gains the `report` step (output `{ body, subject? }`), produced only by `automation/workflow-report-step.ts`; the value source `{ report: <earlier step index> }` allowed only for `REPORT_BODY_FIELDS` (body of `slack_message_post`, `teams_message_post`, `gmail_draft_create`, `outlook_draft_create`, plus a templated draft subject), all destination/routing fields `constant`, checked at `workflow.save` and in `standingRuleStep` `accountedStep` AND `scopeMatches` (a `{ report }` source matches only the same step index in the rule's scope); refused in signed imports (I59 unchanged). Triple rule in one commit: wiring + `docs/SECURITY-INVARIANTS.md` I55 text (the stated content bound: rule outputs charset-validated, other values escaped and capped, door refusals on the final text) + tests; static D44 clause for the single producer. `nimbus cost report schedule <name>` generates one workflow per channel (`cost-<report>-<channel>`) embedding scope, period, tz, destination, subject and template TEXT. Acceptance: scheduled Slack post under a rule with no prompt, audited and ledgered; `<!here>` in a tag inert; no rule → blocks and notifies; email → draft only.
- **Slice 5 — GitHub Actions usage.** Connectors repo: a read tool for the billing usage endpoint (verify endpoint, scope, shape; documentation-verified only), released; gateway pin + `connectors/github-actions-cost-sync.ts` producing `CostLine`s (`source: "github_actions"`, `repo`, `workflow`, runner SKU) through `replaceCostLines`.
- **Slice 6 — OpenAI and Anthropic usage.** Connectors repo: two read-only connectors with each vendor's organisation admin key (Vault only); gateway syncs producing `model`-tagged lines.
- **Slice 7 — FinOps role pack and close-out.** `finops` 1.0.0 pack (defaults only, I47) in the official registry; roadmap Phase 7 rows ticked with what shipped and the acceptance criteria rewritten from the spec; the guardrail text changed to "cost data leaves only in a report the owner approved as a standing rule, and every post is in the ledger"; the Phase 14 revenue row (Stripe first, sources pluggable). Delete the spec and plan from `dev/asaf/phase7-cost-pack`.
- **Slice 8+ — later sources, one PR each:** GitLab, Bitbucket, Jenkins agent cost (via cloud lines tagged to agents, or a configured rate), cloud API pulls (AWS Cost Explorer, Azure Cost Management, GCP BigQuery billing) as connectors.
