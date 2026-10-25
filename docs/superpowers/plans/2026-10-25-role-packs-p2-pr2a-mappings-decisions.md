# Role packs P2 PR 2a — source mappings, decisions side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A role pack (`[sources] map`) or the owner (`[sources] map` / `exclude`) changes what the decisions pass mines and what `nimbus decisions` shows, live, with already-indexed items caught up and unmapped rows hidden rather than deleted.

**Architecture:** A new resolver, `sources/source-mapping.ts`, turns the built-in kind table plus the layered config into a `SourceMapping` value; the decisions pass resolves one at the start of every run and every decisions read resolves one per call. Schema V74 adds a per-type catch-up cursor table and `decision_record.scored_kind`. The glossary is NOT touched in this PR (PR 2b).

**Tech Stack:** Bun + TypeScript strict, `bun:sqlite`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md` §§ 4, 5, 6, 7 (decisions half), 9 item 2, 10 (+ `-review.md`). On `dev/asaf/role-packs` only. PR 1 (`sources/source-kinds.ts`) is merged as `ebd2a18f`.

## Global Constraints

- Branch `dev/asaf/role-packs-p2-mappings` from `origin/main`, worktree by ABSOLUTE path: `git worktree add C:/gitrep/Nimbus/.claude/worktrees/role-packs-p2-mappings -b dev/asaf/role-packs-p2-mappings origin/main`. Never commit on `main`; no `docs/superpowers/**` on the branch. Verify the branch before every commit.
- **Glossary scope is unchanged in this PR.** `GLOSSARY_SOURCE_TYPES`, `glossarySourceFilter()` and its three consumers (`glossary-extract.ts` `scanDelta` and `loadGlossaryCandidates`, `glossary-store.ts` `computeTermStats`) stay built-in only. A mapping affects decisions only until PR 2b; docs say so.
- Entry grammar `service:type=kind`; `service` and `type` `[a-z0-9_]+`; kind ∈ `message|doc|ticket|commit|note`; list syntax strict like `parseAgentNameList` (`config/pack-settable.ts:107`); 1–64 entries.
- **`nimbus:*` refused at every layer** (pack and owner), in the entry parser AND dropped again by the resolver (I28).
- Pack entries are **add-only**: a pack entry naming a built-in type is refused at validation, whatever kind. Two packs mapping one type to different kinds is a conflict (second install refused before its prompt). Same type and kind: union.
- Packs may not map a personal type: `gmail:email`, `outlook:email`, `imap:email`, `fastmail:email`, `protonmail:email`, `apple:email`, `apple:event` (one constant, `PERSONAL_SOURCE_TYPES`). The owner may.
- Owner layers (base, profile): `map` adds or re-kinds any type; `exclude` removes any type. Later layer wins per type (pack < base < profile); within one layer `exclude` beats `map`. `exclude` is not pack-settable. The owner silently wins over packs (no install refusal because of owner files).
- Live: no boot-time snapshot of the mapping. Use `getLayeredConfig(configDir).snapshot()` (cached by content, `config/layered-config.ts:281`).
- Nothing in `decision_record` is deleted or rewritten by a mapping change.
- Migration V74 is additive only (`ALTER TABLE … ADD COLUMN`, `CREATE TABLE`); writes through `dbRun`/`dbExec` (I14); bound params for every dynamic `IN` (I9).
- No `any`. Run `bun run typecheck:tests` and the WHOLE `bun test packages/gateway/src` before the PR, plus `bun run audit:coverage-floor` after a local lcov build if any new file has a branch (the floor is CI-only; PR 1 was red on one unreachable `??`).
- PR title: `feat(decisions): role packs and your config choose which sources decisions are mined from`. No `!` (nothing a user must change).

## Carried from PR 1

- Empty doc set: when the effective `doc` types are empty, the ADR lookup is skipped (no `adr` evidence), never `IN ()`.
- Keep the built-in table private: stop exporting `BUILTIN_SOURCE_KINDS`; expose `builtinSourceEntries(): readonly (readonly [string, SourceKind])[]` (frozen) for tests and the resolver.

## Review Focus

1. A pack is installed, then removed, then re-installed days later — items of its type modified while it was unmapped must be mined on re-install; items mined before removal must not be re-mined (Task 4 test `re-adding a type catches up only the unmapped window`).
2. An owner `exclude` of a built-in type (`slack:message`) — existing Slack decisions hidden from list, counts and candidate totals; queued Slack `pending` rows not sent to the model; nothing deleted (Task 4 + Task 5 tests).
3. Owner re-kinds a type (`jira:issue=doc`) — authority follows the new kind for NEW scores; existing rows are not reported as "previous scale" (Task 5 test `re-kind does not trip the stale-score check`).
4. A decision whose source item was deleted, and an owner-accepted agent decision whose source is a `nimbus:capture` item — both still shown exactly as today (Task 5 tests).
5. A malformed `[sources]` value in the owner's `nimbus.toml` (`map = "jira:issue=doc"`, a bad kind, `nimbus:capture=note`) — ignored with a `config explain` note, never a crash, never applied (Task 1 test `owner layer bad values are notes, not applied`).

---

### Task 1: The resolver

**Files:**
- Create: `packages/gateway/src/sources/source-mapping.ts`, `packages/gateway/src/sources/source-mapping.test.ts`
- Modify: `packages/gateway/src/sources/source-kinds.ts` (private table + `builtinSourceEntries`), `packages/gateway/src/sources/source-kinds.test.ts` (iterate `builtinSourceEntries()` instead of the map — an import-only change)
- Modify: `packages/gateway/src/security-invariants.test.ts:2926` (the I28 `capture items are never extraction input` test), `docs/SECURITY-INVARIANTS.md` (I28 section, the sentence at ~:792)

**Interfaces:**
- Produces (`sources/source-mapping.ts`):
  - `export type SourceMapEntry = { readonly serviceType: string; readonly kind: SourceKind };`
  - `export function parseSourceMapEntry(raw: string): SourceMapEntry | undefined` — grammar above; `undefined` for `nimbus:*`.
  - `export function parseSourceMapList(valRaw: string): readonly string[] | undefined` — the `PackSettableList.parse` shape (strict TOML string list, every element passes `parseSourceMapEntry`, 1–64).
  - `export function parseSourceTypeList(valRaw: string): readonly string[] | undefined` — for `exclude` (`service:type` elements, `nimbus:*` refused).
  - `export const PERSONAL_SOURCE_TYPES: ReadonlySet<string>` — the seven keys.
  - `export type SourceOrigin = { readonly kind: "builtin" } | { readonly kind: "layer"; readonly layer: LayerRef };`
  - `export interface SourceMapping { kindOf(serviceType: string): SourceKind | undefined; typesFor(pass: SourcePass): readonly string[]; typesOfKind(kind: SourceKind): readonly string[]; readonly entries: readonly { serviceType: string; kind: SourceKind; origin: SourceOrigin }[]; readonly excluded: readonly { serviceType: string; layer: LayerRef }[]; readonly notes: readonly string[] }`
  - `export const BUILTIN_SOURCE_MAPPING: SourceMapping` — built-in table only.
  - `export function resolveSourceMapping(snapshot: Pick<ConfigSnapshot, "doc">): SourceMapping`
  - `export function sourceMappingFor(configDir: string | undefined): SourceMapping` — `undefined` → `BUILTIN_SOURCE_MAPPING`; else `resolveSourceMapping(getLayeredConfig(configDir).snapshot())`.
  - `export function sourceFilterSql(types: readonly string[], alias: string): { sql: string; params: string[] }` — `(<alias>.service || ':' || <alias>.type) IN (?, …)`; for an EMPTY list returns `{ sql: "0", params: [] }` (never `IN ()`).
- `typesFor` / `typesOfKind` keep built-in table order first, then added types in layer order; all returned arrays frozen.

- [ ] **Step 1: Write `source-mapping.test.ts`.** Build snapshots the way `catalog/agent-visibility.test.ts` does (read that file for its helper; reuse it rather than inventing a snapshot shape). Tests, each with exact values:
  - `with no [sources] the mapping equals the built-in table` — `typesFor("decisions")` equals `sourceTypesFor("decisions")` (same order).
  - `a pack adds a type` — pack layer `map = ["readwise:highlight=note"]` → `kindOf("readwise:highlight") === "note"`, it appears last in `typesFor("decisions")`, origin is that pack layer.
  - `two packs with the same entry union` — no note, one entry.
  - `a pack entry naming a built-in type is ignored with a note` (validation refuses it at install; the resolver must still be safe on a hand-edited layer).
  - `the owner re-kinds a built-in` — base `map = ["jira:issue=doc"]` → `kindOf("jira:issue") === "doc"`, `typesOfKind("doc")` includes it, `typesOfKind("ticket")` does not.
  - `owner exclude removes built-in and pack types` — base `exclude = ["slack:message","readwise:highlight"]` → both absent from `typesFor("decisions")`, both in `excluded`.
  - `profile beats base` — base excludes `slack:message`, profile maps `slack:message=message` → present.
  - `in one layer exclude beats map`.
  - `nimbus:* never resolves, from any layer` — pack `nimbus:capture=note` and base `nimbus:glossary_term=doc` → `kindOf` undefined for both, not in any `typesFor`, a note each.
  - `owner layer bad values are notes, not applied` — base `map = "jira:issue=doc"` (not a list), `map = ["jira:issue=wiki"]`, `exclude = [1]` → mapping equals built-in, three notes.
  - `sourceFilterSql of an empty list is false, not IN ()` — `{ sql: "0", params: [] }`; and of two types → `"(i.service || ':' || i.type) IN (?, ?)"`.
  - `parseSourceMapEntry` grammar table: accepts `readwise:highlight=note`, `ext_foo:item=doc`; rejects `Readwise:x=note`, `a:b=wiki`, `a:b`, `a=note`, `nimbus:capture=note`, `a:b=note=x`, empty.
- [ ] **Step 2: Run** `bun test packages/gateway/src/sources` → FAIL (module missing).
- [ ] **Step 3: Implement** `source-mapping.ts` and the `source-kinds.ts` change. Layer walk: start from the built-in table; apply pack layers (from the `[sources]` section entries via `layerValues`, `catalog/agent-visibility.ts:36`, which you may export or copy — prefer importing) in order, each pack `map` entry adding only types not already present (built-in collision → note); then base, then profile: each layer's `map` sets the kind (re-kind allowed), then its `exclude` deletes. `exclude` found on a pack layer → note, ignored. Every parse failure → note naming the layer path and raw value. A final pass drops any `nimbus:` key (defence in depth; add a note if one was present).
- [ ] **Step 4: Rewrite the I28 test** at `security-invariants.test.ts:2926` to keep its two built-in assertions AND add: for a snapshot whose pack and base layers both map `nimbus:capture=note`, `resolveSourceMapping(...).typesFor("decisions")` and `typesFor("glossary")` exclude it and `kindOf("nimbus:capture")` is undefined; `parseSourceMapEntry("nimbus:capture=note")` is undefined. Update the I28 sentence in `docs/SECURITY-INVARIANTS.md` (~:792) to say the exclusion also holds for every source mapping: the entry parser refuses `nimbus:*` and the resolver drops it.
- [ ] **Step 5: Run** `bun test packages/gateway/src/sources packages/gateway/src/security-invariants.test.ts` → PASS; `bun run typecheck` clean.
- [ ] **Step 6: Commit** `feat(sources): resolve the effective source mapping from the layered config`.

---

### Task 2: Packs and config explain

**Files:**
- Modify: `config/pack-settable.ts` (`PACK_SETTABLE_LISTS`, :135), `packs/pack-validate.ts` (:16-20 area), `packs/pack-layer-store.ts` (`CleanPack` :132, build site :294, `conflicts` :206, call :356), `packs/pack-prompt.ts` (:60, :86-95, :115, :197, :224), `packs/pack-install.ts` (`PackListResult` :81, rows :479/:494, a `packSourceMappings` beside `packVisibleAgents` :499), `config/config-explain.ts` (`SECTION_LOADERS` :77 and the agents-notes hook :494/:513), `packages/ui/src/ipc/types.ts:590` (optional field)
- Test: the existing `*.test.ts` beside each (ADD tests)

**Interfaces:**
- Consumes (Task 1): `parseSourceMapList`, `parseSourceMapEntry`, `PERSONAL_SOURCE_TYPES`, `builtinSourceEntries`, `sourceMappingFor`.
- Produces: `PACK_SETTABLE_LISTS` entry `{ section: "sources", key: "map", consumer: "per-call", parse: parseSourceMapList, … }` (list id `"sources.map"`); `CleanPack.sourceMap: ReadonlyMap<string, SourceKind>`; `PackListResult.installed[].sourceMappings: readonly SourceMapEntry[]` (`[]` when unreadable); UI `sourceMappings?: readonly { serviceType: string; kind: string }[]`.

- [ ] **Step 1: Tests** (add to the existing files):
  - pack-settable: a fragment with `[sources]\nmap = ["readwise:highlight=note"]` is ok and `lists.get("sources.map")` equals that one string; `exclude = [...]` in a pack fragment is refused (not settable); `map = ["nimbus:capture=note"]` is refused.
  - pack-validate: `jira:issue=doc` → problem `[sources] map names built-in source "jira:issue"`; `gmail:email=message` → problem `[sources] map names personal source "gmail:email"`; `readwise:highlight=note` → no problem.
  - pack-layer-store `check()`: active pack A maps `readwise:highlight=note`, candidate B maps `readwise:highlight=doc` → `{ok:false, reason:"conflict"}` with problem `[sources] map readwise:highlight: pack A maps it to note`; B mapping `=note` → ok.
  - pack-prompt install: a pack mapping `readwise:highlight=note` renders a `Sources added:` section with the line `  readwise:highlight as note`; none → `  none`. Update prompt: `added: readwise:highlight as note` / `removed: …`.
  - pack-install `pack.list`: an installed pack's row has `sourceMappings: [{serviceType:"readwise:highlight", kind:"note"}]`.
  - config-explain: `nimbus config explain sources` lists each effective entry with its origin (`built-in`, `pack <id>`, `base`, `profile`), each exclusion, and the resolver's notes; `sources.map` and `sources.exclude` paths resolve to that section.
- [ ] **Step 2: Run** the touched test files → the new tests FAIL.
- [ ] **Step 3: Implement.** Validation runs before the prompt (existing order). The prompt's `Sources added:` section sits after `Visible agents:`, same `section()` helper. The UI type gains the optional field only (no UI change).
- [ ] **Step 4: Run** `bun test packages/gateway/src/packs packages/gateway/src/config` and `packages/ui` vitest for types (`cd packages/ui && bunx vitest run test/ipc` if a types test exists; otherwise `bun run typecheck`) → PASS.
- [ ] **Step 5: Commit** `feat(packs): packs can add decision sources with [sources] map`.

---

### Task 3: Schema V74

**Files:**
- Create: `packages/gateway/src/index/source-catchup-v74-sql.ts`, `packages/gateway/src/index/migrations/runner-v74.test.ts` (model: `runner-v73.test.ts`)
- Modify: `index/migrations/runner.ts` (a `simpleStep(73, 74, …)` after :671-676), `index/local-index.ts:284` (`CURRENT_SCHEMA_VERSION = 74`), `index/migrations/runner.test.ts:825-828` (expects 73 → 74), `docs/schema-reference.md` (after the V73 entry, :1139)

**Interfaces:**
- Produces: table `source_catchup_state (pass TEXT NOT NULL CHECK(pass IN ('decisions','glossary')), service_type TEXT NOT NULL, watermark_ms INTEGER NOT NULL DEFAULT 0, watermark_id TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)), PRIMARY KEY (pass, service_type))`; column `decision_record.scored_kind TEXT` (nullable, `CHECK (scored_kind IS NULL OR scored_kind IN ('message','doc','ticket','commit','note'))`).
- Backfill: `scored_kind` from the built-in table AS IT STANDS IN V74 — a literal `CASE (service || ':' || type)` over the 13 keys in a correlated subquery on `item`, inside the SQL constant (frozen; a later table change must not alter what V74 wrote). Rows with no item or a non-built-in type stay NULL. No seed rows in `source_catchup_state` (Task 4 handles built-ins in code).

- [ ] **Step 1: Write `runner-v74.test.ts`**: migrating a V73 db that holds a `jira:issue` item + decision, a `notion:page` item + decision, an orphan decision and a `nimbus:capture`-sourced agent decision → `scored_kind` is `ticket`, `doc`, NULL, NULL; `source_catchup_state` exists and is empty; the CHECKs reject `pass='x'` and `scored_kind='wiki'`; a test that the CASE's 13 keys equal `builtinSourceEntries()` today (so the frozen literal is born correct).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the constant and step. **Step 4: Run** `bun test packages/gateway/src/index` → PASS (runner.test.ts now expects 74). **Step 5: Commit** `feat(index): V74 source catch-up cursors and decision scored_kind`.

---

### Task 4: The decisions pass follows the mapping

**Files:**
- Modify: `decisions/decision-extract.ts` (`DecisionPassOptions` :56, `scanDelta` :111, `loadDecisionCandidates` :152, `commitBatch` :180, `discoverPhase` :234, `serviceTypeOf` :271, `corroboratePhase` :323, `runDecisionPass` :440, `rebuildDecisions` :496), `decisions/decision-store.ts` (`selectPendingByPriority` :161; a `scored_kind` write where confidence is stored), `decisions/decision-confidence.ts` (`sourceAuthority`, `computeConfidence`, `computePriority`, `explainConfidence` inputs), `decisions/decision-corroborate.ts` (ADR query), `decisions/decision-service-scope.ts` (`matchesTicketKey`, `matchesService`), `platform/assemble.ts` (:791-805 `runPass`), `demo/seed.ts:419`
- Create: `decisions/decision-catchup.ts` (+ test)
- Test: existing decision test files (ADD tests); existing call sites updated to pass `BUILTIN_SOURCE_MAPPING` where they construct options

**Interfaces:**
- Consumes: `SourceMapping`, `BUILTIN_SOURCE_MAPPING`, `sourceMappingFor`, `sourceFilterSql` (Task 1); V74 table/column (Task 3).
- Produces:
  - `DecisionPassOptions.mapping: SourceMapping` (REQUIRED — a caller that forgets it is a compile error).
  - `ConfidenceInput` / `PriorityInput` gain `mapping?: SourceMapping` (default `BUILTIN_SOURCE_MAPPING`); `sourceAuthority(serviceType: string, mapping: SourceMapping = BUILTIN_SOURCE_MAPPING): number`; `export function authorityOfKind(kind: SourceKind): number`.
  - `corroborate(db, input & { mapping?: SourceMapping })`, `matchesService(db, input & { mapping?: SourceMapping })` — default built-in.
  - `decision-catchup.ts`: `export function reconcileCatchupRows(db, pass: "decisions", effective: readonly string[], builtin: ReadonlySet<string>, mainCursor: {watermarkMs:number; watermarkId:string}): void` and `export function catchupTypes(db, pass: "decisions", effective: readonly string[]): readonly { serviceType: string; watermarkMs: number; watermarkId: string }[]`.

Rules (spec § 6, with the review fix):
- At run start, `reconcileCatchupRows`: an effective type with no row → insert (`done = 1`, cursor = main cursor) if built-in, else (`done = 0`, cursor 0/''). A row with `done = 1` whose type is no longer effective → `done = 0`, cursor = main cursor at this moment. A `done = 0` row whose type left the set is left alone.
- Catch-up runs BEFORE the delta scan, per type, in bounded batches sharing the run's `maxDiscoveryBatches`, scanning `service || ':' || type = ?` with its own composite cursor up to (and including) the main cursor captured at run start; it mines exactly like `commitBatch` but advances the catch-up row; an empty batch sets `done = 1`. It re-checks the effective set between batches (stop a type that left it).
- The delta scan uses `mapping.typesFor("decisions")` via `sourceFilterSql`.
- `selectPendingByPriority` gains the effective set: `LEFT JOIN item i … WHERE (i.id IS NULL OR <filter>)`, so excluded types' pending rows are not sent to the model (they stay `pending`).
- Confidence is computed with the mapping's kind and `scored_kind` is stored beside it (`mapping.kindOf(serviceType) ?? null`).
- ADR lookup uses `mapping.typesOfKind("doc")`; empty → no ADR query.
- Ticket matching uses `mapping.kindOf`.
- `assemble.ts` `runPass` builds `mapping: sourceMappingFor(paths.configDir)` on EVERY run (not at assemble time).
- Pack install/remove does NOT trigger a pass (Ruling, spec § 5 leaves it to the builder: reads reflect a mapping change immediately, and the next post-sync pass, or `nimbus decisions --refresh`, mines it — cost if wrong: new sources wait until the next sync; one `decisionsRefresher?.trigger()` call in the pack-install path would close it). `demo/seed.ts` passes `BUILTIN_SOURCE_MAPPING` (Ruling: the demo corpus is built-in sources only — cost if wrong: a demo pack mapping would not apply to the seeded pass).

- [ ] **Step 1: Tests** (`decision-catchup.test.ts` + additions to `decision-extract.test.ts`; use each file's existing real-SQLite helpers):
  - `a newly mapped type's existing items are mined` — items of `readwise:highlight` with a heading cue exist before the first pass; run once with the built-in mapping (no candidate for them), then with a mapping adding `readwise:highlight=note` → candidates for them exist.
  - `built-in types are not re-scanned on upgrade` — first run on an existing index inserts `done = 1` rows for built-ins at the main cursor; no extra scan (count `upsertCandidate` effects stay equal to a run without the table).
  - `re-adding a type catches up only the unmapped window` — mapped and fully mined; then unmapped for a run; an item of that type modified now; then re-mapped → the new item is mined, an item mined before removal is NOT re-upserted (its `updated_at` unchanged).
  - `exclude stops mining and model calls` — with `slack:message` excluded: no new Slack candidates; a pre-existing Slack `pending` row is not selected by `selectPendingByPriority`; the row still exists with `status = 'pending'`.
  - `re-kind changes authority for new scores` — `jira:issue=doc` mapping: a newly corroborated Jira decision stores `scored_kind = 'doc'` and its confidence uses authority 1.
  - `empty doc set skips the ADR lookup` — mapping excluding all three doc types: `corroborate` returns no `adr` evidence and does not throw.
  - `catch-up stops a type that left the set mid-run` — use a mapping provider that changes between batches (inject via the options), assert no further batches for it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (catch-up in `decision-catchup.ts`; keep `commitBatch`'s mining loop shared, not copied). **Step 4: Run** `bun test packages/gateway/src/decisions packages/gateway/src/demo packages/gateway/src/platform` → PASS; `bun run typecheck` clean. **Step 5: Commit** `feat(decisions): the pass mines the effective source mapping and catches up new types`.

---

### Task 5: Decisions reads hide unmapped rows

**Files:**
- Modify: `decisions/decision-store.ts` (`listDecisions` :272, `countByStatus` :287), `decisions/decision-extract.ts` (`loadDecisionCandidates` :152), `agents/decisions.ts` (`DecisionsContext` :15, `serviceTypeOf` :32, explain :57, :213/:220 calls, :236-251 loop, stale-score :260-273), `agents/negotiate.ts` (`laneDecisions` :697 — the three queries), `ipc/agents-rpc.ts` (~:1041 where the decisions context is built), `ipc/tour-rpc.ts` (~:84)
- Test: `decision-store.test.ts`, `agents/decisions.test.ts`, `agents/negotiate.test.ts` (ADD tests)

**Interfaces:**
- Consumes: Task 1, Task 3, Task 4's `authorityOfKind` and confidence `mapping` input.
- Produces: `listDecisions(db, opts & { mapping: SourceMapping })`, `countByStatus(db, mapping: SourceMapping)`, `loadDecisionCandidates(db, { sinceMs, mapping })`; `DecisionsContext.mapping: SourceMapping` (required; agents-rpc / tour-rpc build it with `sourceMappingFor(ctx.configDir)`); negotiate's context likewise.

Visibility rule (one SQL fragment, defined once in `decision-store.ts` and reused): a row is visible when `d.extraction_source = 'agent' OR i.id IS NULL OR <effective decisions filter on i>`, over `LEFT JOIN item i ON i.id = d.source_item_id`, projecting `d.*` only.

- [ ] **Step 1: Tests:**
  - `excluded type's rows are hidden from list and counts` — Slack and Jira extracted decisions; exclude `slack:message` → `listDecisions` returns only Jira; `countByStatus` counts only Jira; re-include → both again; row count in `decision_record` unchanged throughout.
  - `orphan decisions are shown` — a decision whose item was deleted appears with the built-in mapping and with an exclusion in force.
  - `agent decisions are never hidden` — an `insertAgentDecision` row (source `nimbus:capture` item) appears under every mapping.
  - `limit counts visible rows` — 3 hidden + 2 visible, `limit: 2` → the 2 visible.
  - `candidate totals follow the mapping` — `loadDecisionCandidates` excludes the excluded type.
  - `re-kind does not trip the stale-score check` — a row scored as `ticket` (scored_kind `ticket`) under a mapping that now says `jira:issue=doc` → `staleScoreCount` 0; a row with `scored_kind` NULL keeps today's recompute.
  - `negotiate excludes hidden decisions` — its counts and refs drop an excluded type's decisions.
  - Grep step: `git grep -n "FROM decision_record" -- packages/gateway/src ':!*.test.ts'` and list every read in the report; any read that surfaces rows to a user (not the pass's own bookkeeping, not `clearDecisions`) applies the visibility fragment.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Stale check: recompute with `authorityOfKind(scoredKind)` when `scored_kind` is set, else today's path (the mapping's kind). Explain uses the same kind as the stale check. **Step 4: Run** `bun test packages/gateway/src/decisions packages/gateway/src/agents packages/gateway/src/ipc` → PASS. **Step 5: Commit** `feat(decisions): nimbus decisions shows only currently mapped sources`.

---

### Task 6: Docs, verification, PR

**Files:**
- Modify: `docs/cli-reference.md` (a `[sources]` table beside `[agents]` at :547-583: `map` — pack or owner, grammar, add-only for packs, personal types refused for packs; `exclude` — owner only; profile beats base; exclude beats map in one layer; **decisions only until the glossary follows in a later release**), `docs/CHANGELOG.md` (entry under today), `docs/architecture.md` (§ Source kinds: the resolver, liveness, catch-up and the V74 rows), `.claude/commands/nimbus-implicit-knowledge-extraction.md` (the source-types section and the "Existing rows are not re-scanned" checklist step 5, which is now false for decisions)

- [ ] **Step 1: Edit the docs.** Re-grep restatements: `git grep -n "re-scanned\|--rebuild" -- .claude/commands/nimbus-implicit-knowledge-extraction.md docs/cli-reference.md` and fix any that a catch-up makes false for decisions (glossary statements stay true until 2b).
- [ ] **Step 2: Verify:** `bun run preflight:fast` PASSED; `bun run typecheck:tests` 0 new; `bun test packages/gateway/src` 0 fail; `bun test packages/cli` 0 fail (CLI renders `config explain`); `bunx vitest run` in `packages/ui` green; `bash scripts/coverage-floor/build-lcov.sh && bun run audit:coverage-floor` if the script runs locally (otherwise Docker `bun run verify:docker --full`), recording which; `git diff origin/main --stat -- docs/superpowers` empty.
- [ ] **Step 3: Commit, push, `gh pr create`** with the Global Constraints title; body states the glossary is unchanged until PR 2b, the rulings, and the attribution line. Check CodeRabbit threads after each push.
