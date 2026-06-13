# Phase 6 Slice 7 — Data Warehouse & BI connectors (design review)

**Date:** 2026-06-13
**Reviews:** `2026-06-13-phase6-slice7-data-warehouse-bi-design.md`
**Method:** verified the design's load-bearing technical claims against the worktree codebase
(`graph/graph-populator.ts`, `graph/relationship-graph.ts`, `federation/invoke-gate.ts`,
`agents/impact.ts`).

**Verdict:** design is directionally sound (6 connectors, existing item types, three waves, no new
invariant), but **three claims about the lineage + credential mechanics were wrong or
over-stated**. Four findings are fixed in the design doc now; the rest are deferred to the plan.

---

## Findings

### F1 — Lineage needs new graph-populator handlers, not just a constant + a migration. **[FIX NOW]**

**Claim reviewed (§4/§7):** "adding the types to `ITEM_LINKED_ENTITY_TYPES` + V40 relation-type
seed is enough."

**Reality:** `syncGraphFromIndexedItem` (`graph/graph-populator.ts:297`) is a per-type dispatch with
handlers for exactly `pr / issue / message / git_commit / dependency / api_endpoint / code_symbol /
obsidian_note`. There is **no** `data_model` / `dashboard` / `data_quality_test` handler — and the
graph entity *type* strings are not always the item type (`code_symbol`→`symbol`,
`dependency`→`package`). So Slice 7 must **write three new populator functions**
(`syncDataModelGraph`, `syncDashboardGraph`, `syncDataQualityTestGraph`) that upsert the entity and
emit the lineage edges, and register them in the dispatch — in addition to the constant +
migration. This is real gateway work, not connector boilerplate.

**Fix:** §4 and §7 updated to list the three populator handlers as Wave-7a deliverables.

### F2 — The full 6-hop chain does NOT compose from "already-shipped" edges. **[FIX NOW — rescope acceptance]**

**Claim reviewed (§1/§4/§8):** the `<500ms` Tableau→Looker→dbt→Snowflake→Airflow→PR chain "reuses
the already-shipped dbt/Airflow/Snowflake-side edges."

**Reality:** those edges **don't exist** — dbt `data_model` items and Airflow DAGs are *not*
graph-participating today (same gap as F1; in fact `agents/impact.ts:339` calls
`detectMissingEntityType(db, "dashboard")` and emits a gap note precisely because dashboards aren't
in the graph yet). The middle hops (dbt-model node, Airflow-DAG node, and their edges to PRs/CI) are
unbuilt. Delivering the full 6-hop chain in Slice 7 would require also making the **dbt and Airflow**
connectors graph-participating — a scope expansion the design hid.

**Decision (recommended (b)):**

- **(a)** Expand 7a to also add dbt-`data_model` + Airflow-DAG graph participation → full chain
  achievable, but ~2 extra connectors' worth of graph work bleeds into a "warehouse/BI" slice.
- **(b) [chosen]** Scope the gating acceptance to the hops **Slice 7 owns**: Tableau→Snowflake,
  Looker→dbt-model-*item*, dashboard→data_model, data_quality_test→data_model. The full
  Tableau→…→PR chain becomes a **documented stretch / Phase-7 follow-up**, contingent on dbt+Airflow
  graph participation. Keeps the slice bounded and honest.

**Fix:** §1/§4/§8 reworded; the flagship acceptance is now the Slice-7-owned sub-chain, with the
full chain explicitly marked stretch and its dependency named.

### F3 — I19 reuse for *local* team credentials is not a drop-in. **[FIX NOW (soften) + DEFER mechanism]**

**Claim reviewed (§1/§5):** team-credentialed ops "flow through the existing I19 invoke-gate, no new
gate."

**Reality:** `answerFederatedInvoke` (`federation/invoke-gate.ts:69`) takes an
`InboundInvoke { peerId, … }`, resolves a **per-peer** RBAC grant, runs quorum, and gates on
`identity.isOperatorValid()` — it is built for an **inbound peer** consuming a team tool. A *local*
connector sourcing a team secret has **no peer and no per-peer grant**. Reuse therefore needs a
deliberate adapter (a local-operator pseudo-principal feeding the same identity→grant→quorum→
inject-secret machinery), or a small dedicated local path — *not* a literal call into the federated
entry point.

**Fix:** §1/§5 softened to "reuses I19's team-vault-secret *machinery* (identity → grant → quorum →
secret-injected-in-callback, leak-proof, audited); the local-invocation adapter is designed in the
plan." The exact adapter shape is an explicit plan open-item. Invariant count still unchanged
(we're not adding a *new* gating concept — we're feeding the I19 one from a local caller).

### F4 — Reconcile relation-type names with what `impact.ts` already expects. **[FIX NOW]**

**Reality:** `agents/impact.ts:356` already summarizes a path as `… → upstream_refs → dashboard`,
i.e. the traversal layer already anticipates an `upstream_refs`-style edge into dashboards. Inventing
`feeds` / `derived_from` / `monitors` in isolation risks a second vocabulary the impact agent won't
traverse.

**Fix:** §4 now requires reconciling the seeded relation-type names with the names `impact.ts` (and
any other `traverseGraph` consumer) already queries — tentatively `upstream_refs` for
`data_model → dashboard` — verified against impact's queries during the plan, before the V40 seed is
finalized.

### F5 — `data_quality_test` graph participation is part of F1. **[FIX NOW — folded into F1]**

The `monitors` edge needs the DQ entity in the graph; covered by the new `syncDataQualityTestGraph`
handler listed in the F1 fix.

### F6 — Snowflake Key-Pair auth stores a private key, not a token. **[DEFER to plan]**

Key-Pair auth means a PEM private key in Vault — larger and shaped differently from the OAuth tokens
the existing data-BI connectors store. Confirm the Vault value-size + the connector's key-loading
path in the plan. Low risk (Vault is opaque-blob), but call it out so it isn't discovered at
implementation time.

### F7 — "No IPC namespace change" needs verification for the write actions. **[DEFER to plan]**

The 7 write actions run through the engine/executor action path (HITL-gated), which is the existing
mechanism — but confirm no new `*-rpc.ts` entry point or Tauri-allowlist change is needed to *trigger*
a connector write from the CLI. Likely true; verify in the plan rather than assert in the spec.

### F8 — Per-connector API scope (admin vs user) changes visibility. **[DEFER — already in §9]**

PowerBI admin API vs user scope, Tableau REST vs Metadata API, Snowflake `INFORMATION_SCHEMA` vs SQL
API. Already listed as a §9 plan open-item; no spec change.

---

## Net effect on the design

- **Wave 7a grew** the most honest amount: it now explicitly owns three graph-populator handlers +
  the `ITEM_LINKED_ENTITY_TYPES` change + V40 relation-type seed + the `normalizeDataModelKey()`
  helper. Still one wave, still bounded — but no longer mis-sold as "connector boilerplate."
- **The flagship acceptance shrank** to the Slice-7-owned sub-chain; the 6-hop cross-warehouse chain
  is a named stretch dependent on dbt+Airflow graph participation.
- **Wave 7b** keeps "personal default / team opt-in," but the team path is "I19 machinery via a
  local adapter (designed in plan)," not "call the federated entry point."
- **Invariant count unchanged** — still no new invariant; the security-invariants test stays an exit
  criterion.

No finding invalidates the slice or its wave structure; they tighten scope and correct two
mechanism claims. Cleared to proceed to the implementation plan after the design-doc edits below.
