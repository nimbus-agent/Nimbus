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

- [ ] **Step 1:** Write `runner-v109.test.ts`: `CURRENT_SCHEMA_VERSION >= 109`; a fresh DB has `cost_line` with columns above plus `grain_hash`, unique index on (source, provider, billing_account_id, charge_day, grain_hash), indexes (source, charge_day) and (source, provider, sub_account_id, charge_day). Run → FAIL.
- [ ] **Step 2:** Write the DDL and register it. Run → PASS.
- [ ] **Step 3:** Write `cost-line-store.test.ts`: replace inserts; replacing days {01..19} then {01..20} leaves exactly the 20-day set (Review Focus 2); identical re-import changes nothing (inserted 0, replaced = n is acceptable only if values equal: assert row count and sums unchanged); lines on days not in the set are kept; delete by source and by import id.
- [ ] **Step 4:** Implement the store with `dbRun`/`dbStmtRun` (I14). Run → PASS.
- [ ] **Step 5:** Add the `cost-line-confined` static rule with its own fixture test; `bun run audit:invariants` (or the `check-nimbus-invariants.ts` entry) passes; add `cost_line` to `LocalIndex.removeConnectorIndexData` (in `index/local-index.ts`) and the `nimbus data delete` path for its source (mirror the `chat_read_marker` erasure) with a test.
- [ ] **Step 6:** Commit `feat(gateway): the cost_line table and store (V109)`.

### Task 2: FOCUS CSV reader

**Files:** Create `packages/gateway/src/finops/focus-csv.ts`, `focus-csv.test.ts`, fixtures under `packages/gateway/src/finops/__fixtures__/focus/` (a small AWS, Azure and GCP FOCUS 1.x sample each, hand-made, plus BOM/CRLF variants)

**Interfaces:** Produces `parseFocusCsv(text: string, opts: { provider?: "aws"|"azure"|"gcp"; importId: string }): { lines: CostLine[]; byPeriod: Map<string /*billingAccountId|billingPeriod*/, { days: Set<string>; totals: Map<string /*currency*/, number> }>; skipped: { row: number; reason: string }[] }`

- [ ] **Step 1:** Tests: the three fixtures parse to the expected lines; BOM + CRLF + quoted comma/newline fixture equals the clean one (Review Focus 1); missing required FOCUS columns (`BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ServiceName`) → a thrown error naming the column; a row with a non-numeric cost → `skipped` with reason; provider inferred from `ProviderName` when `--provider` absent; `Tags` JSON column flattened, at most 50 tags of at most 128 chars each (excess recorded in `skipped`-style warnings, not dropped silently).
- [ ] **Step 2:** Implement a dependency-free RFC 4180 parser (strip BOM, CRLF/LF, quotes) and the FOCUS column mapping; day = UTC date of `ChargePeriodStart`. Rows sharing (billingAccountId, chargeDay, grain hash) within a file are AGGREGATED into one line (summing `billedCost` and `effectiveCost`; a null effectiveCost stays null only if all are null), so the unique key never collides and totals still reconcile; add a test with two raw rows of one grain. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): FOCUS CSV reader`.

### Task 3: `cost.import` IPC and `nimbus cost import`

**Files:** Create `packages/gateway/src/finops/cost-import.ts`, `cost-import.test.ts`, `packages/gateway/src/finops/cost-folder-watch.ts` (+ test); Modify `packages/gateway/src/ipc/cost-rpc.ts` (+ test: `CostRpcCtx` gains `caller: { kind: ClientKind }` from `ctx.getClientKind`, as `incident-rpc.ts` does; the IPC routing site passes it), Create `packages/cli/src/commands/cost-import-cli.ts` (+ test; `cost.ts` only routes to it), `docs/cli-reference.md`

**Interfaces:** Produces `importFocusPath(db, path: string, opts: { provider?; dryRun: boolean; now: () => number }): ImportReport` where `ImportReport = { importId; files: { path; sha256; lines; replaced; skipped; totals: Record<string, number> }[] }`; IPC `cost.import { path, provider?, dryRun? }` (owner kinds `cli` only, reads a local path), `cost.importRemove { importId }`.

- [ ] **Step 1:** Tests: a directory imports every `*.csv` (non-recursive), each file in its own transaction; the per-file totals equal the sum of its lines per currency; `--dry-run` writes nothing; a second identical run reports 0 net change; `cost.import` from a connection that did not declare `cli` is refused; the `cost` namespace stays in `FORBIDDEN_OVER_LAN`.
- [ ] **Step 2:** Implement (read through one handle per file, cap 512 MiB per file with a stated refusal, `path.join`); wire the handler; `[cost.focus] dir` (parsed in Task 4's config) is imported by `cost-folder-watch.ts` once a day from the gateway's existing scheduler hook (the one the FinOps sync uses), new or changed files only (by SHA-256), never on a demo gateway, with a test using an injected clock; CLI `nimbus cost import <path> [--provider aws|azure|gcp] [--dry-run] [--json]` and `nimbus cost import --remove <importId>`. Run → PASS.
- [ ] **Step 3:** Commit `feat: nimbus cost import for FOCUS CSV exports`.

### Task 4: Allocation rules

**Files:** Create `packages/gateway/src/finops/cost-rules.ts`, `cost-rules.test.ts`; Modify `packages/gateway/src/config/finops-toml.ts` (+ test) for `[[cost.rule]]`, `[cost] internal_envs`, `[cost] authoritative`, `[cost.focus] dir` (an absolute path, refused if it is a link)

**Interfaces:** Produces `type CostRule = { match: Partial<{ source; provider; sub_account; service; region; resource; repo; workflow; tag: Record<string,string> }>; set: Partial<{ product; env; service }> }`; `allocate(line: CostLine, rules: readonly CostRule[]): { product: string|null; env: string|null; service: string|null; rule: number|null; unassignedReason: string|null }`; matchers in one registry `COST_MATCHERS` keyed by match field (glob via a small literal-glob matcher: `*` and `?` only).

- [ ] **Step 1:** Tests: first match wins; all given match keys must match; placeholder `{tag.product}` substitutes; a substituted value failing the charset → unassigned with reason (Review Focus 4); no rule matches → unassigned "no rule matched"; unknown match key or placeholder → config load error naming it; `internal_envs` default `["ci","dev","test","staging"]`.
- [ ] **Step 2:** Implement; config parsing refuses unknown keys. Run → PASS.
- [ ] **Step 3:** Commit `feat(gateway): cost allocation rules`.

### Task 5: Views: `cost.products` and `cost.internal`

**Files:** Create `packages/gateway/src/finops/cost-views.ts`, `cost-views.test.ts`, `packages/gateway/src/finops/cost-allocation-adapter.ts`, `cost-allocation-adapter.test.ts`; Modify `ipc/cost-rpc.ts`, `packages/cli/src/commands/cost.ts` (split into `cost-views-cli.ts` if it nears 500 lines), `docs/cli-reference.md`

**Interfaces:** Produces `productView(lines, rules, opts: { fromDay; toDay; currencyOrder? }): ViewResult` and `internalView(...)`, where `ViewResult = { byCurrency: Record<string, { total: number; rows: { product|env: string; service: string|null; provider: string; amount: number }[]; unassigned: number }>; freshness: { source: string; lastDay: string|null; provisionalFrom: string|null }[]; empty: boolean; excludedSources: string[] }`. Sources: `cost_line` rows, plus a read-side adapter `adaptCostAllocationItems(db, window)` in `finops/cost-allocation-adapter.ts` that projects existing `item` rows of type `cost_allocation` (Vantage) into `CostLine` shape (`currency` from the row or `"unknown"`, shown as its own currency group) for providers with no raw lines, or when `[cost] authoritative` names `vantage` for that provider. Authoritative rule: when raw lines exist for a provider, its Vantage rows are excluded and listed in `excludedSources`. Kubecost/OpenCost never enter cloud totals; `--allocation cluster` returns them as their own view (`clusterView`).

- [ ] **Step 1:** Tests: per-currency totals, no grand total across currencies (Review Focus 3); unassigned shown per currency; provisional marking for the last 3 days; Vantage exclusion listed; IPC `cost.products|internal { period }` (`7d|30d|month|week`, owner kinds `cli`/`ui`).
- [ ] **Step 2:** Implement + CLI `nimbus cost products|internal [--period 30d] [--allocation cluster] [--json|--csv]` (CSV: one row per currency/product/env/service/provider, header row fixed and documented). Run → PASS.
- [ ] **Step 3:** Commit `feat: nimbus cost products and nimbus cost internal`.

### Task 6: Demo cost lines, docs, slice close-out

**Files:** Modify `packages/gateway/src/demo/corpus/acme.ts` (or a new `corpus/acme-cost.ts` it imports), `demo/seed.ts` (+ tests); `docs/roadmap.md` (Phase 7 rows: tick intake-from-files partially with a progress note), `docs/CHANGELOG.md`, `docs/architecture.md` (FinOps section: the cost-line model), `docs/cli-reference.md`

- [ ] **Step 1:** Test: a demo gateway seeds FOCUS lines for three products (checkout, search, internal tools), envs prod/dev/ci, a seeded spike on checkout's service, two currencies NOT used (USD only) and a demo rules block; `nimbus --demo cost products` lists the three products; an empty real install says "no cost data imported" (Review Focus 5).
- [ ] **Step 2:** Implement; update docs; `bun run preflight:fast`; run `bun test packages/gateway/src/finops packages/gateway/src/ipc/cost-rpc.test.ts packages/cli/src/commands/cost.test.ts packages/gateway/src/demo`.
- [ ] **Step 3:** PR `feat: cost lines from FOCUS exports, allocation rules and cost views (Phase 7, slice 1)`; `gh pr merge --squash --auto`; resolve review threads.

---

## Slices 2–8 (each gets a detailed task list here before its code starts)

- **Slice 2 — `cost why` + `cost rules check`.** `finops/cost-why.ts` (pure; compares period vs previous, ranks moved lines); the deploy/PR/owner lookup lives OUTSIDE `finops/` in `agents/_lib/cost-why-query.ts`, passed in as data (D48). IPC `cost.why`, `cost.rulesCheck`; CLI `nimbus cost why <product|service> [--period 14d] [--json]`, `nimbus cost rules check`. Acceptance: the demo spike names the seeded deploy, PR and owner with no network.
- **Slice 3 — Reports.** `finops/cost-report-model.ts` (the JSON model), `finops/cost-report-render.ts` (text, markdown, html, csv), `finops/cost-template.ts` (closed placeholder set, per-channel escaping, unknown placeholder refused at load, values capped at 128 chars), `[[cost.report]]` config with per-channel `format`/`template`/`template_file` (confined to `<configDir>/cost-templates/`, no `..`, no absolute, no link, 64 KiB) and the email `subject`. CLI `nimbus cost report <name> [--json|--csv|--text]`, IPC `cost.report.render`.
- **Slice 4 — Delivery and the I55 extension.** `automation/workflow-steps.ts` gains the `report` step (output `{ body, subject? }`), produced only by `automation/workflow-report-step.ts`; the value source `{ report: <earlier step index> }` allowed only for `REPORT_BODY_FIELDS` (body of `slack_message_post`, `teams_message_post`, `gmail_draft_create`, `outlook_draft_create`, plus a templated draft subject), all destination/routing fields `constant`, checked at `workflow.save` and in `standingRuleStep` `accountedStep` AND `scopeMatches` (a `{ report }` source matches only the same step index in the rule's scope); refused in signed imports (I59 unchanged). Triple rule in one commit: wiring + `docs/SECURITY-INVARIANTS.md` I55 text (the stated content bound: rule outputs charset-validated, other values escaped and capped, door refusals on the final text) + tests; static D44 clause for the single producer. `nimbus cost report schedule <name>` generates one workflow per channel (`cost-<report>-<channel>`) embedding scope, period, tz, destination, subject and template TEXT. Acceptance: scheduled Slack post under a rule with no prompt, audited and ledgered; `<!here>` in a tag inert; no rule → blocks and notifies; email → draft only.
- **Slice 5 — GitHub Actions usage.** Connectors repo: a read tool for the billing usage endpoint (verify endpoint, scope, shape; documentation-verified only), released; gateway pin + `connectors/github-actions-cost-sync.ts` producing `CostLine`s (`source: "github_actions"`, `repo`, `workflow`, runner SKU) through `replaceCostLines`.
- **Slice 6 — OpenAI and Anthropic usage.** Connectors repo: two read-only connectors with each vendor's organisation admin key (Vault only); gateway syncs producing `model`-tagged lines.
- **Slice 7 — FinOps role pack and close-out.** `finops` 1.0.0 pack (defaults only, I47) in the official registry; roadmap Phase 7 rows ticked with what shipped and the acceptance criteria rewritten from the spec; the guardrail text changed to "cost data leaves only in a report the owner approved as a standing rule, and every post is in the ledger"; the Phase 14 revenue row (Stripe first, sources pluggable). Delete the spec and plan from `dev/asaf/phase7-cost-pack`.
- **Slice 8+ — later sources, one PR each:** GitLab, Bitbucket, Jenkins agent cost (via cloud lines tagged to agents, or a configured rate), cloud API pulls (AWS Cost Explorer, Azure Cost Management, GCP BigQuery billing) as connectors.
