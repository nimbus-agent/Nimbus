# Vertical Personas — "Nimbus for Security" (with "Nimbus for Data" as a templated repeat) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 — Scale & Surface, **Phase 18 (Vertical Personas)**; harvests S5 (Engineering-Excellence breadth) connectors already shipped. Per the 2026-06-17 resequence overlay, Phase 18 is opportunistic post-spine expansion, **not** a near-term-spine blocker.
**Scope:** `packages/gateway/src/agents/` (two new built-in read-only agents + a shared persona-bundle helper), `packages/gateway/src/ipc/agents-rpc.ts` (two new `agents.*` methods), `packages/gateway/src/config/profiles.ts` + a new `persona`/bundle config surface, `packages/cli/src/commands/` (new `secops.ts` + `dataeng.ts` + a `persona.ts` discovery command), `packages/sdk/src/` (two new `*Brief` types added to the agent-brief family), `packages/ui/src-tauri/src/gateway_bridge.rs` (allowlist two read-only methods). **No new connectors** — all data is already indexed. **No new migration.**

> **Reality-check correction to the grounding:** the grounding states the Security connectors are "stubs not wired." That is **wrong** as of `main`. Verified in-tree: `packages/gateway/src/connectors/snyk-sync.ts` + `snyk-issue-mapping.ts` (item type `vulnerability`), `sonarqube-sync.ts` + `sonarqube-issue-mapping.ts` (item type `code_issue`), `semgrep-sync.ts` + `semgrep-finding-mapping.ts` (item type `finding`), and `dependencytrack-sync.ts` + `dependencytrack-project-mapping.ts` (item type `project`) all exist with sync handlers and `*-mapping.test.ts` coverage. The data is **already indexed** — which is exactly what Phase 18 requires, and is why Security is the right first vertical (its connectors are demonstrably done, not stubbed).

---

## Motivation / Goal

Nimbus has ~80 connectors and a small family of built-in read-only agents (`expert`, `impact`, `catchup`, `huddle`, `ghost`, `conflicts`, `janitor`, `preflight` — all in `packages/gateway/src/agents/`). To a new user that surface reads as "a generic dev-tool framework." A **vertical** repackages that same machinery into a single category-defining wow query.

A vertical is concretely **three things, no new connectors**:

1. **A curated connector bundle** — a named set of already-shipped connectors the persona reads from (e.g. `security = [snyk, sonarqube, semgrep, dependencytrack]`).
2. **A built-in read-only persona agent** — following the exact shape of the existing agents (`runX(input, ctx)` → `Brief`, `emitXBrief(input, ctx)` → notification, `AgentCoordinator` parallel sub-agents, `synthesize()` to Markdown). Zero write tools, zero HITL, no new invariant.
3. **Tailored prompts/recipes + discovery** — a persona-scoped synthesis prompt, a `nimbus <persona>` convenience command, and `nimbus persona list/enable/configure` for onboarding.

The bet (from `docs/roadmap.md` Phase 18): a narrow audience with high willingness-to-pay and high evangelism gets a brief cloud agents structurally cannot produce, because the source data is private and cross-provider.

**This spec picks ONE vertical to spec in depth — "Nimbus for Security" (`nimbus secops`)** — and treats **"Nimbus for Data" (`nimbus dataeng`)** as a templated repeat (same skeleton, different bundle + sub-agents + brief type).

**Why Security first** (over the roadmap's founder/maintainer/academic list): its connectors are the only persona bundle that is **provably 100% shipped and indexed today** (snyk/sonarqube/semgrep/dependencytrack — verified above), so the persona is pure packaging with no connector dependency. Security buyers have high willingness-to-pay and the brief ("what's my exploitable-today risk across SAST + SCA + dep-licence, ranked, with owners") is one no cloud agent can assemble across four private security tools. **Data second** because its connectors also shipped (Phase 6 Slice 7 Wave 7a: snowflake/tableau/looker/powerbi/monte-carlo/bigeye) and the V40 cross-warehouse lineage graph is already populated but has **no built-in agent querying it** — a fast, high-value templated repeat.

---

## Where this fits (roadmap home + not-already-shipped evidence)

- **Roadmap home:** `docs/roadmap.md` lines 1952–1989 — Phase 18 "Vertical Personas", `Planned`, checkbox unchecked (line 77: `| Phase 18 | Vertical Personas | Planned |`). The 2026-06-17 Sequencing Spine (line 923) lists Vertical Personas [P18] under "Opportunistic expansion surfaces."
- **Not already shipped — verified:**
  - No `secops`, `dataeng`, `founder`, `maintainer`, `academic`, `persona` agent exists under `packages/gateway/src/agents/` (directory listing confirmed: only `expert/impact/catchup/conflicts/ghost/huddle/janitor/preflight`).
  - No `secops.ts`/`dataeng.ts`/`persona.ts` under `packages/cli/src/commands/` (listing confirmed).
  - `packages/cli/src/commands/security.ts` exists but is the Phase-5 `nimbus security scan` credential-hygiene command — **not** a persona agent; it is distinct and stays as-is (we add a sibling, not a replacement).
  - `[persona.<name>]` TOML is documented in the roadmap (line 1976–1979) but **not wired**: `config/profiles.ts` exists for Phase 3.5 profiles, but no persona/bundle block.
- **Reuse > rebuild — what we lean on, not rebuild:**
  - The agent skeleton: `packages/gateway/src/agents/expert.ts` (`runExpert`/`emitExpertBrief`/`AgentCoordinator`/`makeSubAgent`), `agents/_lib/synthesize.ts`, `agents/_lib/findings.ts`, `agents/_lib/gap-notes.ts`, `agents/engine/coordinator.ts`.
  - The IPC pattern: `ipc/agents-rpc.ts` `dispatchByMethod` registration + the `<agent>.briefReady` / `<agent>.briefError` notifications.
  - The CLI pattern: `cli/src/commands/catchup.ts` + `cli/src/lib/agent-brief-render.ts` (`awaitAgentBrief`/`renderAgentBrief`) + `cli/src/commands/_agent-brief-cli.ts`.
  - The already-indexed security data (`vulnerability`/`code_issue`/`finding`/`project` item types) and warehouse data (`data_model`/`dashboard`/`data_quality_test` + V40 lineage edges).

---

## Approaches considered

### Approach A — Two bespoke agents, one shared persona-bundle helper (RECOMMENDED)

Ship `agents/secops.ts` and `agents/dataeng.ts` as two ordinary built-in agents (exact `expert.ts` shape), each with its own `*Brief` type in the SDK. Factor the small amount of genuinely shared mechanics into `agents/_lib/persona-bundle.ts` (resolve which connectors in a named bundle are actually present/indexed → emit a `GapNote` for any missing one, via the existing `detectMissingConnector` in `gap-notes.ts`). Persona config + discovery is a thin `config/persona-bundles.ts` + `nimbus persona` command.

- **+** Each agent is independently testable, independently coverage-floored, matches every existing agent 1:1 — zero new architectural concept. The "templated repeat" is literally a second file with the same skeleton.
- **+** No new invariant, no migration, no write surface — lowest risk.
- **−** Two files of structurally similar code (mitigated: the shared resolver + the sub-agent factory are extracted; the sub-agent *queries* are genuinely different per vertical so duplication is shallow).

### Approach B — One generic, config-driven "persona engine" agent

A single `agents/persona.ts` that reads a `[persona.<name>]` TOML block declaring sub-queries (SQL-ish over the index) and renders a brief. `nimbus secops` and `nimbus dataeng` are just config presets.

- **+** Adding a third vertical is config-only, no code.
- **−** Requires a query DSL the codebase doesn't have; user-authored SQL over the index is an injection/footgun surface that would need a **new invariant** to constrain (violates "reuse > rebuild" and YAGNI). The existing agents hand-write parameterized `db.query(...).all(...)` precisely to avoid this. Over-engineered for two verticals. **Rejected.**

### Approach C — Persona = LLM system-prompt over the generic `nimbus ask` path

No new agent at all; `nimbus secops` is `nimbus ask` with a security-tuned system prompt + tool-scope.

- **+** Near-zero code.
- **−** Loses the value: the wow is a **structured, ranked, deterministic** brief (section-per-domain, evidence links, confidence buckets) assembled by parallel sub-agents over the index — not a freeform chat. It also wouldn't compose with the eval framework (Phase 9 Wave 5) or the `briefReady` notification surface. **Rejected** as the primary path (but the persona-scoped system prompt is still used *inside* the synthesizer in Approach A).

**Recommendation: Approach A.** It is the only option that (a) reuses the proven agent skeleton verbatim, (b) needs no new invariant/migration/write-surface, (c) keeps each vertical independently testable and coverage-floored, and (d) makes "the other vertical" a genuine templated repeat (a sibling file, not a config DSL). It respects YAGNI: the shared surface is exactly the bundle-presence resolver, nothing more.

---

## Design (recommended)

### Architecture & components

**New files (gateway):**

- `packages/gateway/src/agents/secops.ts` — `runSecops(input, ctx): Promise<SecopsBrief>` + `emitSecopsBrief(input, ctx): { sessionId }`. Mirrors `agents/expert.ts` exactly: builds an `AgentCoordinator`, fans out parallel sub-agents, ranks, returns a `SecopsBrief`, and `emit*` synthesizes + fires `secops.briefReady`.
  - Sub-agents (each a parameterized read query over the already-indexed data, returning evidence or a `GapNote` from `detectMissingConnector`):
    - `subCriticalVulns` — `item` rows `WHERE type = 'vulnerability' AND service = 'snyk'`, ranked by severity + recency (read from the indexed `vulnerability` mapping).
    - `subSastFindings` — `WHERE type = 'finding' AND service = 'semgrep'` (+ `WHERE type = 'code_issue' AND service = 'sonarqube'`).
    - `subDepRisk` — `WHERE type = 'project' AND service = 'dependencytrack'` (vulnerable-dependency + policy-violation projects).
    - `subOwners` — joins findings to the **people graph** (same `JOIN person p ON p.id = i.author_id` / `graph_relation` pattern `expert.ts` already uses) to attribute "who owns the affected file/service," so the brief recommends a remediation owner — purely read, no write.
  - Brief sections: **Exploitable Now** (critical/high open vulns), **Code Hotspots** (SAST + sonar), **Dependency Risk** (DT projects), **Owners** (people-graph attribution).
- `packages/gateway/src/agents/dataeng.ts` — `runDataeng`/`emitDataengBrief`/`DataengBrief`. **Templated repeat** of `secops.ts`. **Its headline capability is cross-warehouse lineage-impact tracking over the V40 graph** — the cross-source differentiation Nimbus uniquely has: a failing `data_model` in one warehouse (e.g. Snowflake) is traced, via the already-populated V40 `derived_from`/`upstream_refs`/`monitors` edges and `normalizeDataModelKey` convergence, to **every** downstream `dashboard` (Tableau/Looker/Power BI) it breaks — a blast radius no single-tool cloud agent can compute because the source data spans four private warehouses. The roadmap calls this graph out as "indexed but not yet queried by a built-in agent"; `dataeng` is the first agent to query it.
  - Sub-agents over the Slice-7 data: `subLineageImpact` (**the headline** — downstream `dashboard`s of a failing `data_model`, traversed across warehouses via the **V40 `derived_from`/`upstream_refs`/`monitors` lineage edges** already populated, reusing `normalizeDataModelKey` for cross-source key convergence), `subBrokenDashboards` (`dashboard` rows whose upstream `data_model` failed a test), `subFreshness` (`data_quality_test` failures from monte-carlo/bigeye, supporting detail).
  - Brief sections: **Lineage Impact** (headline — cross-warehouse downstream blast radius), **Broken Dashboards**, **Data Health** (freshness/test failures), **Owners**.
- `packages/gateway/src/agents/_lib/persona-bundle.ts` — the **only** genuinely shared new code: `resolveBundlePresence(db, bundleName): { present: string[]; missing: GapNote[] }` over the existing `detectMissingConnector` helper, so each persona surfaces "you haven't connected SonarQube yet" as a structured gap (matching how `expert.ts` emits gaps). Also exports the named bundle constants (`SECURITY_BUNDLE`, `DATA_BUNDLE`) as readonly `as const` arrays — the single source of truth for which connectors a vertical reads.

**New SDK types** (`packages/sdk/src/` — added to the agent-brief family in `_lib/findings.ts`'s upstream, mirroring `ExpertFinding`/`ImpactFinding`):

```ts
export type SecopsFinding = { itemId: string; service: string; severity: "critical"|"high"|"medium"|"low"; title: string; ownerPersonId: string|null; modifiedAt: number; confidence: "high"|"medium"|"low" };
export type SecopsBrief = AgentBriefBase & { kind: "secops"; query: { scope: string }; sections: { exploitableNow: SecopsFinding[]; codeHotspots: SecopsFinding[]; dependencyRisk: SecopsFinding[] } };
export type DataengBrief = AgentBriefBase & { kind: "dataeng"; query: { scope: string }; sections: { lineageImpact: DataengFinding[]; brokenDashboards: DataengFinding[]; dataHealth: DataengFinding[] } };
```text

Add `isSecopsBrief`/`isDataengBrief` type-guards in `agents/_lib/findings.ts` next to the existing `isExpertBrief` etc., and extend the `AgentBrief` union. (The guard + union extension is the established pattern; CLI re-uses it via `cli/src/types/agents.ts`.)

**New config** (`packages/gateway/src/config/persona-bundles.ts` + a `[persona.<name>]` reader composed into the Phase-3.5 `config/profiles.ts`):

```toml
[persona.secops]
enabled = true
bundle  = "security"          # resolves to SECURITY_BUNDLE
sections = ["exploitableNow", "codeHotspots", "dependencyRisk", "owners"]
[persona.dataeng]
bundle  = "data"
```text

Persona config is **read-only metadata** (which sections to render, which bundle) — it never carries credentials and never enables a write tool.

**IPC** (`packages/gateway/src/ipc/agents-rpc.ts`): register two methods in the existing `dispatchByMethod` table:

- `agents.secops` → `requireSecopsParams` (validate `{ scope?: string, limit?: number }` with the same MIN/MAX trim guards already in the file) → `emitSecopsBrief`.
- `agents.dataeng` → analogous.
Plus `persona.list` (returns the static built-in persona registry + each bundle's present/missing connectors) — a pure read, no agent run.

**CLI** (`packages/cli/src/commands/`):

- `secops.ts` + `dataeng.ts` — copy the `catchup.ts` skeleton: parse args, `awaitAgentBrief(client, "secops", isSecopsBrief, …)`, `client.call("agents.secops", …)`, `renderAgentBrief`. Convenience commands `nimbus secops` / `nimbus dataeng`.
- `persona.ts` — `nimbus persona list` (calls `persona.list`), `nimbus persona enable <name>` (writes `enabled = true` to the `[persona.<name>]` block via the existing config writer), `nimbus persona configure <name>` (opens the TOML block in `$EDITOR`).

**Tauri** (`packages/ui/src-tauri/src/gateway_bridge.rs`): add `agents.secops`, `agents.dataeng`, `persona.list` to `ALLOWED_METHODS` (keeping the array alphabetized — the file has an `ALLOWED_METHODS must be alphabetized` test). All three are read-only brief/list methods — same class as `agents.expert`/`agents.catchup` which are already allowlisted — so no RCE-class exposure (I7 satisfied). Adding three entries moves the count from the current **95** to **98**, so the count assertion `assert_eq!(ALLOWED_METHODS.len(), 95)` at `gateway_bridge.rs:501` must be bumped to `98`, and the matching JS-mirror allowlist count updated.

### Data flow

```text
nimbus secops [--scope <service|all>] [--json]
  → CLI awaitAgentBrief + client.call("agents.secops", {scope})
  → agents-rpc dispatchByMethod → emitSecopsBrief(input, ctx)
      → runSecops: AgentCoordinator fans out subCriticalVulns / subSastFindings / subDepRisk / subOwners
          (each a parameterized db.query over already-indexed item rows — NO connector/cloud call)
      → resolveBundlePresence emits GapNotes for any unconnected security tool
      → rank → SecopsBrief
      → synthesize(brief, {llm}) → Markdown (persona-scoped synthesis prompt)
      → ctx.notify("secops.briefReady", { sessionId, brief: markdown, findings: SecopsBrief })
  → CLI renderAgentBrief(brief, findings, json)
```text

No step touches a cloud API or an MCP connector at run time — the brief is assembled purely from the local SQLite index (the index was populated earlier by the normal connector sync path). This is the same flow `expert.ts`/`catchup.ts` use.

### IPC / CLI surface

| Surface | Name |
| --- | --- |
| IPC method | `agents.secops`, `agents.dataeng`, `persona.list` |
| Notification | `secops.briefReady` / `secops.briefError`, `dataeng.briefReady` / `dataeng.briefError` |
| CLI | `nimbus secops [--scope <id>] [--json]`, `nimbus dataeng [--scope <id>] [--json]`, `nimbus persona list \| enable <name> \| configure <name>` |
| Tauri allowlist | `agents.secops`, `agents.dataeng`, `persona.list` (read-only) |

### Security: check against the 7 Non-Negotiables + invariant/schema impact

1. **Local-first** — ✅ The brief is assembled only from the local SQLite index; zero outbound calls at run time. The persona is a *view* over already-synced data. No regression.
2. **HITL is structural** — ✅ Both personas are **read-only**: no write tools, no `action.type` reaches `executor.gate()`, so I2/I3/I4 are untouched and trivially satisfied. Concretely, **no entry is added to the `HITL_REQUIRED_BACKING` frozen set in `packages/gateway/src/engine/executor.ts` (declared at line 17; the gate consumes it)** — verifiable by diffing that file (it stays byte-identical). The persona-config surface explicitly cannot enable a write tool. (If a future "remediate"/"suppress-finding" wave is wanted, that is a separate spec needing a new invariant — see Non-goals.)
3. **No plaintext credentials** — ✅ Personas read item rows, never credentials. Persona-config TOML carries only section/bundle metadata. The underlying connectors already enforce Vault-only creds (I12). No new credential surface.
4. **MCP as connector standard** — ✅ No new connectors; no direct cloud API calls. The agent reads the index the MCP sync already populated.
5. **Platform equality** — ✅ Pure query + Markdown synthesis; no OS-specific code. Runs identically on Win/macOS/Linux.
6. **AGPL-3.0 core / MIT sdk** — ✅ Agents + IPC + CLI ship in gateway/cli (AGPL-3.0); only the `*Brief` type definitions go in the MIT SDK (matching where `ExpertFinding`/`ImpactFinding` already live). No license-field change.
7. **No `any`** — ✅ Follows the strict-typed agent pattern; external data typed as the explicit row shapes (`as Array<{…}>` after a parameterized query, exactly like `expert.ts`); type-guards return `x is SecopsBrief`.

**Invariant impact:**

- **No new invariant required.** Read-only personas add no gating surface. Reuse: I2/I3/I4 (untouched — no write path), I11 (`wrapToolOutput` — only relevant if a persona sub-agent ever feeds raw results to the LLM; the synthesis path already runs through `synthesize()`, which operates on the structured `Brief`, not raw tool output, so I11 is not newly engaged — but **if** a sub-agent is later given an LLM tool, `wrapToolOutput` must wrap it).
- **Federation guard (I17) — one real check.** The new `secops`/`dataeng` `*Brief` shapes must **not** leak into a federated namespace export by accident. Security findings and warehouse/lineage data are production-adjacent and carry governance risk. **Action:** add a contract test asserting `vulnerability`/`code_issue`/`finding`/`project` and `data_model`/`dashboard`/`data_quality_test` item types fail the federated-namespace shape validator unless explicitly opted into a namespace policy — extending the existing pattern in `security-invariants.test.ts` (same shape as the roadmap's `health.*` exclusion test, line 1988). This reuses I17's leak-proof contract; it does **not** create a new invariant. **(The current invariant ceiling on `main` is `I27` — verified at `docs/SECURITY-INVARIANTS.md:3` "Current ceiling: invariants I1–I27" and `CLAUDE.md`. The `## I28 — Sub-agent tool scope enforcement` text in `docs/SECURITY-INVARIANTS.md` is the doc's hypothetical "How a new invariant is added" worked example, not a shipped invariant: `packages/gateway/src/engine/sub-agent.ts` has no `dispatchToolCall`/`scope.has(toolId)` wiring. This design adds no invariant at all. **Numbering note:** `I28` is reserved for the MCP-server owner-sink (branch `dev/asafgolombek/phase7-mcp-gateway-server`); any I29/D22/V44-style numbers cited by sibling specs follow the *proposed* global sequence in `2026-06-20-superpowers-specs-consolidated-review.md` §1 — those family ideas are mutually exclusive, so the actual number is the next-free at each spec's own merge time, reconciled by build order. This spec slots into none of that sequence: it carries no invariant/D/migration.)**
- **Schema:** **No V44 migration.** Both personas query already-existing item types and the already-populated V40 lineage edges. Persona config lives in TOML, not the DB. Zero migration burden.

**Fail-closed behavior:** if a bundle connector is absent/unindexed, `resolveBundlePresence` emits a `GapNote` and the corresponding section renders "not connected" rather than fabricating data (mirrors `detectMissingConnector`). If the brief run throws, `emit*` fires `secops.briefError` and the CLI exits non-zero — never a partial/silent success. An empty index yields a `detectEmptyIndex` gap, exactly as `runExpert` does today.

### Testing (which layer + coverage)

- **Integration (gateway, real `bun:sqlite`, fresh temp dir):** `agents/secops.test.ts` + `agents/dataeng.test.ts` — seed a synthetic index with `vulnerability`/`code_issue`/`finding`/`project` rows (and warehouse rows for dataeng), run `runSecops`/`runDataeng`, assert section ranking, owner attribution via the people graph, and `GapNote` emission when a connector is absent. Use real SQLite (no DB-layer mocks), per `nimbus-testing`.
- **IPC contract:** extend `ipc/agents-rpc.test.ts` — `agents.secops`/`agents.dataeng` param validation (reject bad `scope`/`limit`), `persona.list` shape.
- **e2e-CLI:** `cli/src/commands/secops.test.ts` + `dataeng.test.ts` + `persona.test.ts` — real Gateway subprocess + seeded index, assert Markdown + `--json` shapes (the `catchup.test.ts` pattern).
- **Invariant/contract (I17 reuse):** a namespace-shape test asserting the new item types fail federated export by default (in `security-invariants.test.ts` or a sibling).
- **Coverage-floor ≥80% line+branch per file** (CI-Linux-authoritative). New files are pure logic over an injectable `Database` + DI'd `llm`/`notify` — straightforward to floor, like every existing agent. The brief type-guards get direct positive/negative tests (matching `isExpertBrief`).

---

## Non-goals (YAGNI)

- **No write/remediation actions** — no `nimbus secops --remediate`, no auto-suppress, no Jira-ticket creation. Those need a HITL gate + a reversibility-classification invariant and are explicitly out of scope. This recommended read-only slice needs no new invariant in this read-only slice; a future remediation/write variant would take the next free number at that time (I28 is reserved for the MCP-server owner-sink; the proposed family sequence is in 2026-06-20-superpowers-specs-consolidated-review.md §1). Such a variant — "persona write-actions classified by reversibility; irreversible actions gated by a dedicated HITL action type" — is a separate spec.
- **No new connectors** — Security & Data both reuse shipped connectors. The roadmap's `creator`/`taxes`/`health` personas (which *do* imply new connectors / filesystem-export / a self-verifying ZIP) are **out of scope for this slice.**
- **No persona query DSL / user-authored SQL** (rejected Approach B).
- **No daily-watcher / scheduled-push** in this slice — the roadmap's "daily watcher variant" and "route output to Slack DM / mobile push" compose later with the existing watcher + ChatOps reply-dispatcher (I23) and the mobile companion (Phase 13.5). Ship the on-demand brief first.
- **No marketplace/community-persona plugin loading** (Phase 9.5 dependency) — the first-party set is bounded to these two.
- **No eval `*.yaml` suite execution** — author the eval fixtures (so they exist), but the eval *framework* is Phase 9 Wave 5 and not yet shipped; the suite is consumed when that lands.

## Resolved decisions (settled in requirements — not open)

- **`nimbus secops` vs the Phase-5 `nimbus security scan` — both ship, no rename.** They are distinct surfaces: `packages/cli/src/commands/security.ts` is the local credential-hygiene scan; `nimbus secops` is a findings brief over the indexed SAST/SCA data. Verified in-tree that `security.ts` is unrelated to persona briefs. **Decision:** keep `nimbus secops` as the persona command (parallel to `nimbus expert`/`nimbus catchup`) and keep `nimbus security scan` unchanged; document the difference in `docs/cli-reference.md`. The two namespaces (`secops` the persona, `security` the hygiene scan) coexist deliberately — no `nimbus security brief` aliasing.

## Open questions

1. **Single slice or two PRs?** Recommendation: ship the **shared skeleton + `secops` + persona discovery** as the first sub-slice (the in-depth vertical), then `dataeng` as a fast follow-on PR reusing the now-proven `persona-bundle.ts`. This de-risks the templated repeat.
2. ~~**`nimbus dataeng` headline — lineage or freshness?**~~ **RESOLVED:** cross-warehouse **lineage-impact tracking over the V40 graph is the headline capability** — the cross-source differentiation Nimbus uniquely has (downstream-dashboard blast radius of a failing `data_model`, traversed across four private warehouses via the V40 `derived_from`/`upstream_refs`/`monitors` edges nobody queries yet). Data-health/freshness is supporting detail. Reflected in `dataeng.ts` sub-agent ordering, the `DataengBrief` section order, and the acceptance criteria.
3. **Persona config home** — a new top-level `[persona.<name>]` block vs nesting under `[profile.<name>.persona]` (Phase 7 Wave 6). Recommendation: top-level `[persona.<name>]` for the *bundle/sections* (this slice) and let the Phase-7 `[profile.<name>.persona]` *tone* block compose later — they are orthogonal (what-to-show vs how-to-phrase).
4. **Owner attribution confidence** — should low-confidence owner guesses be suppressed or shown with a caveat? Recommendation: show with the existing `confidence` bucket, matching `expert.ts`.

## Acceptance criteria

- `nimbus secops` against a seeded synthetic index (snyk `vulnerability` + semgrep `finding` + sonarqube `code_issue` + dependencytrack `project` rows) produces a Markdown brief with **Exploitable Now / Code Hotspots / Dependency Risk / Owners** sections, ranked by severity×recency, with evidence item links and a people-graph owner per finding, in under 15 s on a mid-range laptop, with **no live API call** beyond the local index.
- When a bundle connector (e.g. SonarQube) is not connected, its section renders a structured "not connected" `GapNote` rather than empty/fabricated output.
- `nimbus dataeng` against a seeded warehouse index leads with its headline **cross-warehouse lineage-impact** section: it correctly traverses the **V40 lineage edges** (`derived_from`/`upstream_refs`/`monitors`, via `normalizeDataModelKey`) to name **every** downstream dashboard — across distinct warehouses (e.g. a Snowflake `data_model` → Tableau + Looker dashboards) — of a failing `data_model` (verified against a labeled cross-source fixture), and surfaces failing `data_quality_test`s as supporting detail.
- `nimbus persona list` shows both personas with their bundle's present/missing connectors; `nimbus persona enable secops` flips `enabled = true` in `[persona.secops]`.
- **Privacy contract:** a federated-namespace export of `vulnerability`/`code_issue`/`finding`/`project`/`data_model`/`dashboard`/`data_quality_test` item types **fails** the namespace-shape validator by default — verified by a contract test (reusing the I17 pattern).
- Each persona file clears the **≥80% line+branch** coverage floor (CI-Linux-authoritative); the brief type-guards have positive+negative tests.
- `bun run preflight` (full CI parity) passes — types, Biome, static invariant audit (`check-nimbus-invariants.ts` unchanged: no new static rule needed), tests, coverage-floor.
- The two new agents add **no** new entry to the `HITL_REQUIRED_BACKING` frozen set in `packages/gateway/src/engine/executor.ts` (read-only — that file stays byte-identical), **no** new migration (schema stays V43; next free is V44), and **no** new invariant row (the `main` ceiling remains `I27`).
