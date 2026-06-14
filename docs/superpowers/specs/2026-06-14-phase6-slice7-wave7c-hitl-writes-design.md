# Phase 6 Slice 7 — Wave 7c: HITL-gated WRITE actions for the data-warehouse/BI connectors

**Date:** 2026-06-14
**Branch:** `dev/asafgolombek/phase6-slice7-wave7c` (off main `8e42e0ed`, includes Wave 7b #617)
**Status:** Design — approved for plan-writing

---

## 1. Summary

The six warehouse/BI connectors (Snowflake, Tableau, Looker, Power BI, Monte Carlo, Bigeye)
are read-only today: Wave 7a added metadata indexing + cross-warehouse lineage, Wave 7b added an
optional team-credentialed paginated **read** (`_list`) transport. Wave 7c adds **HITL-gated WRITE
actions** — two per connector, twelve total — that execute **only** behind the local owner's I2
consent gate, and reuse the Wave 7b spawn transport for both the personal and team credential paths.

A new structural invariant **I26 (static D20)** confines the write tool ids so the federated peer
invoke gate (I19 `answerFederatedInvoke`) **fail-closed rejects** them — a peer can never trigger a
warehouse write. This closes the bypass that would otherwise exist: `answerFederatedInvoke` today
runs any granted `toolId` with no HITL, which is safe only while every team-invokable tool is a read.

Two Wave 7b deferred follow-ups are folded in: a cross-gateway audit **identity-subject** refinement,
and **live-API cursor-contract** verification (as a shape contract test + a manual checklist, since
live credentials are unavailable in CI).

No new connector credentials, no new SQLite migration (stays **V40**).

---

## 2. Non-negotiables honored

- **HITL is structural (executor, not prompt).** All twelve write action types are added to the
  frozen `HITL_REQUIRED_BACKING` set in `engine/executor.ts`; the I2 test asserts every member
  triggers the consent channel. Writes cannot be configured away.
- **No peer-triggered writes without local consent.** I26 fail-closed rejects write tool ids on the
  federated path; the only write path is the locally-I2-gated executor dispatch.
- **No plaintext credentials.** No new secrets; team-credential sourcing stays inside the I19 gate;
  the write transport injects secrets into the subprocess env exactly as Wave 7b's read transport.
- **MCP as connector standard.** Writes are real MCP tools on the connector servers; the gateway
  never calls a cloud API directly.
- **No `any`.** External payloads typed `unknown`; strict mode.

---

## 3. Write surface (the twelve actions)

Themed: governance (Snowflake), refresh (Tableau / Power BI / Looker), incident lifecycle
(Monte Carlo / Bigeye). One MCP tool + one HITL `action.type` per row.

| Connector | `action.type` | MCP tool id | API call |
|---|---|---|---|
| Snowflake | `snowflake.tag.set` | `snowflake_tag_set` | `POST /api/v2/statements` → `ALTER TABLE <t> SET TAG <tag> = '<v>'` (unset when value omitted) |
| Snowflake | `snowflake.comment.set` | `snowflake_comment_set` | `POST /api/v2/statements` → `COMMENT ON TABLE/COLUMN <t> IS '<text>'` |
| Tableau | `tableau.datasource.refresh` | `tableau_datasource_refresh` | `POST /sites/{site}/datasources/{id}/refresh` |
| Tableau | `tableau.workbook.refresh` | `tableau_workbook_refresh` | `POST /sites/{site}/workbooks/{id}/refresh` |
| Looker | `looker.datagroup.trigger` | `looker_datagroup_trigger` | `PATCH /datagroups/{id}` (invalidate: set `stale_before`/`trigger_check_at`) |
| Looker | `looker.schedule.run_once` | `looker_schedule_run_once` | `POST /scheduled_plans/run_once` |
| Power BI | `powerbi.dataset.refresh` | `powerbi_dataset_refresh` | `POST /groups/{g}/datasets/{id}/refreshes` |
| Power BI | `powerbi.dataflow.refresh` | `powerbi_dataflow_refresh` | `POST /groups/{g}/dataflows/{id}/refreshes` |
| Monte Carlo | `montecarlo.incident.acknowledge` | `montecarlo_incident_acknowledge` | GraphQL incident-feedback mutation (status → acknowledged) |
| Monte Carlo | `montecarlo.incident.resolve` | `montecarlo_incident_resolve` | GraphQL incident-status mutation (status → resolved, with resolution) |
| Bigeye | `bigeye.issue.acknowledge` | `bigeye_issue_acknowledge` | `PUT` issue status → `ACKNOWLEDGED` |
| Bigeye | `bigeye.issue.resolve` | `bigeye_issue_resolve` | `PUT` issue status → `RESOLVED`/closed |

**Out of scope (deliberate):** Snowflake arbitrary SQL execute (writes bounded to governance
metadata to limit blast radius); any `delete`/drop/destructive write; monitor mute/silence.

Each tool id (the `<service>_<verb>` column) is reference-API-pinned: the exact request shape is
fixed in the plan from the connector's existing `*-sync.ts` read code + the vendor REST/GraphQL docs
before any handler is written (the #595 reference-impl lesson).

**Scoping-id args (review §3).** Write-arg Zod schemas validate the container ids each endpoint
requires, and the agent sources them from indexed metadata:

- *Power BI* needs the **group GUID** (`/groups/{g}/...`). Wave 7a indexes only the workspace
  *display name* (`workspace`), not the GUID — so `powerbi-dashboard-mapping.ts` is extended to also
  index `groupId` (GUID) alongside the existing `datasetId`. The refresh schemas require
  `groupId` + (`datasetId`|`dataflowId`).
- *Tableau* site is connector-scoped (resolved from the connector's own auth/env inside the
  subprocess), so writes need only the workbook/datasource **luid** — already the `externalId`.
- *Snowflake* fully-qualified object name is the `data_model` key; *Looker*/*Monte Carlo*/*Bigeye*
  ids are the indexed item native ids. A plan task verifies each write's required ids are retrievable
  from indexed metadata and adds any missing field (mirroring the Power BI `groupId` extension).

**Async write output shape (review §2).** Refresh writes (Tableau/Power BI) return `202 Accepted`
with a job/run id. Each such tool's result (through the I11 `wrapToolOutput` envelope) returns the
job/run id and an explicit `status: "queued"` marker, so the agent does not treat the refresh as
synchronously complete. Verification of completion is via the next scheduled metadata sync
(Tableau already indexes `extractRefreshStatus`); a dedicated poll tool is **out of scope** (§8).

**Error surfacing (review §5).** API errors from a write (rate-limit `429` / refresh-quota,
privilege/role `403`/object-not-found) are propagated with provider status + message through the
I11 envelope rather than swallowed, so the agent/user can diagnose. Bespoke per-error suggestion
templating is **out of scope** (§8) — the raw provider message (e.g. Snowflake's) is already
actionable.

---

## 4. Architecture

### 4.1 Connector write tools (server-side)

Each connector's `src/server.ts` gains its two write tools through the existing
`register<Svc>Tools(reg: ZodToolRegistrar)` export (the same surface the Wave 7b `_list` pagination
refactor introduced). Tools are thin API callers reading credentials from `process.env` only; real
stdio transport stays guarded by `if (import.meta.main)`. Per the connector contract each write tool
calls `server.assertHitlRequired()` at the top of its handler and is listed in the manifest
`hitlRequired` array, but the **authoritative** gate is gateway-side (I2). Server tools are
unit-tested via the inline-registrar `captureTools()` pattern with a `globalThis.fetch` stub —
no subprocess spawn.

### 4.2 Local write flow — the only write path (reuses I2, no new gate file)

```text
LLM agent plans a write action:
  { type: "tableau.datasource.refresh",
    payload: { mcpToolId: "tableau_datasource_refresh",
               credential: "personal" | "team", entry?: "<team-entry>",
               ...validated params } }
        │
executor.execute(action) → gate()  ── I2 HITL consent (local owner) ──►  reject | proceed
        │ proceed
connectors.dispatch(action)
        │  (action.type ∈ WAREHOUSE_BI write set → credential-aware route)
        ▼
invokeConnectorWrite(ctx, { service, writeToolId, args, credential, entry })
        ├─ personal → withConnectorSession(createServiceScopedVaultView(vault, service))
        │                 → session.call(writeToolId, args)
        └─ team     → answerLocalOperatorInvoke (NEW, I19 local-operator single-tool variant)
                          → withConnectorSession(teamVaultView) → session.call(writeToolId, args)
```

- **HITL:** the twelve action types are added to `HITL_REQUIRED_BACKING` in `engine/executor.ts`.
  The existing I2 test (`security-invariants.test.ts`) asserts every member of the set triggers the
  consent channel, so each local write is gated automatically. **No separate local write-gate file**
  — the executor's `gate()` is the local HITL gate.
- **Transport:** new `connectors/warehouse-write-transport.ts` mirrors `warehouse-sync-transport.ts`:
  `invokeConnectorWrite(ctx, { service, writeToolId, args, credential, entry })`, personal/team
  branch, the same `withConnectorSession` spawn-once transport, the same E2E sink seam
  (`NIMBUS_WAREHOUSE_E2E_SINK_DIR`, writing a recorded-call fixture instead of spawning), and a
  `__setPersonalInvokeForTest` DI seam mirroring `__setPersonalDrainForTest`.
- **Team-credentialed local write:** add `answerLocalOperatorInvoke` to `federation/invoke-gate.ts`,
  a single-tool sibling of the existing `answerLocalOperatorList` (entry/service validation →
  `runTool` with injected secret → audit). Keeps I19 the sole team-credential-consuming path. The
  twelve write tool ids must be invocable here (local owner) yet rejected on the peer path — see I26.
- **Confinement of the local write path (review §1).** `answerLocalOperatorInvoke` and
  `invokeConnectorWrite` are strictly internal to the gateway connector-execution layer. They are
  **not** IPC methods, **not** in the Tauri `ALLOWED_METHODS` allowlist (I7), **not** LAN-reachable
  (I5), and **not** HTTP write routes (I13). The *only* trigger is `connectors.dispatch` →
  `invokeConnectorWrite`, reached only after `executor.gate()` returns `proceed` — so the I2 HITL
  check is structurally upstream of every write, and no local IPC client (CLI/UI) can reach the
  team-credentialed write without clearing I2. D20 statically asserts neither symbol is imported
  under `packages/gateway/src/ipc/` or `packages/ui/src-tauri/`.

### 4.3 Single source of truth for the write surface

New `connectors/warehouse-write-tools.ts` exports the canonical mapping:

```ts
export interface WarehouseWrite {
  readonly actionType: string; // "tableau.datasource.refresh"
  readonly toolId: string;     // "tableau_datasource_refresh"
  readonly service: string;    // "tableau"
}
export const WAREHOUSE_BI_WRITES: readonly WarehouseWrite[] = [ /* 12 rows */ ];
export const WAREHOUSE_BI_WRITE_TOOL_IDS: ReadonlySet<string> = /* frozen set of the 12 tool ids */;
export function isWarehouseWriteToolId(toolId: string): boolean;
export function warehouseWriteByActionType(type: string): WarehouseWrite | undefined;
```

This module drives: the dispatch routing (4.2), the I26 predicate (4.4), and a drift test that the
twelve `actionType`s are all present in `HITL_REQUIRED` and the twelve `toolId`s are all registered
by their connector servers. The HITL strings themselves are still hand-declared in `executor.ts`
(per the invariant rule "added by editing the static source declaration only"); the drift test ties
the two lists together so neither can silently diverge.

### 4.4 NEW invariant I26 / static D20 — federated write confinement

**Statement.** Warehouse/BI write tool ids execute only behind the **local owner's** executor I2 HITL
gate. The federated peer invoke gate (`federation/invoke-gate.ts` `answerFederatedInvoke`, I19)
fail-closed **rejects** any write-classified tool id before grant/quorum resolution.

**Wiring.** `InvokeGateCtx` gains `isWriteForbiddenToolId?: (toolId: string) => boolean`.
`answerFederatedInvoke` checks it first; on a match it audits a new `write_forbidden`
`TeamVaultDecision` and returns the opaque `{ kind: "error", error: "no_grant" }` (no leak of why).
Wired at the `assemble.ts` federation-invoke construction site with
`isWriteForbiddenToolId: isWarehouseWriteToolId`. `answerLocalOperatorInvoke` does **not** receive
this predicate (local owner is allowed to write).

**Triple rule — all in the same commit:**

1. *Wiring:* the `answerFederatedInvoke` rejection + its `assemble.ts` injection.
2. *Docs:* the I26 row in `docs/SECURITY-INVARIANTS.md` (+ invariant-count prose laggards:
   architecture.md, hardening, schema-ref, tauri-allowlist, this skill's doc set per the
   doc-status-drift surfaces).
3. *Test:* `security-invariants.test.ts` — a peer with a valid grant for a write tool id over
   `answerFederatedInvoke` returns an error and **`runTool` is never called** (also assert
   `answerLocalOperatorInvoke` DOES call `runTool` for the same tool id).
4. *Static:* **D20** in `scripts/structure-audit/check-nimbus-invariants.ts` — asserts
   `invoke-gate.ts` consults `isWriteForbiddenToolId` in `answerFederatedInvoke`; that the
   write tool id literals are confined to `warehouse-write-tools.ts` + the connector servers +
   the dispatch/transport sites (no other module references them); and (review §1) that
   `answerLocalOperatorInvoke` / `invokeConnectorWrite` are **not** imported under
   `packages/gateway/src/ipc/` or `packages/ui/src-tauri/`. Runs before the test suite.

`CURRENT_INVARIANT_COUNT`-style assertions and the security-invariants test count bump from 25→26.

### 4.5 Folded-in Wave 7b deferrals

- **Audit identity-subject refinement.** `teamvault/team-vault-audit.ts` audit rows gain an optional
  `identitySubject?: string`, recorded at every audit site in `invoke-gate.ts`
  (`answerFederatedInvoke`, `answerLocalOperatorList`, `answerLocalOperatorInvoke`). The audit is
  serialized as JSON into the existing audit-chain (`federationJson`), **not** a table column — so
  this needs **no migration** (verified against `team-vault-audit.ts`). Fallback semantics
  (review §4): when identity is **enabled**, the field carries the resolved verifier subject; when
  identity is **disabled**, the field is **omitted** rather than set to a sentinel, because
  `principal.kind` (`peer`/`localOperator`) already disambiguates who acted, and emitting a synthetic
  `"local-owner"` subject could be misread as a *verified* identity in the tamper-evident trail.
  (This is a deliberate, narrow divergence from the review's sentinel suggestion.)
- **Live-API cursor-contract verification.** (a) A **shape** contract test enumerating the documented
  paged-response shapes each connector's read path parses (the `{ items, nextCursor }` envelope +
  each vendor's native cursor field) and asserting `drainPagedList` + the per-connector parse handle
  them. (b) A **manual** live-verification checklist appended to this spec (§7) — cannot be
  automated; no live credentials in CI.

---

## 5. Files touched (per-connector sequential commits)

Shared gateway scaffolding (one commit, lands first):

- `connectors/warehouse-write-tools.ts` (new) + test
- `connectors/warehouse-write-transport.ts` (new) + test
- `federation/invoke-gate.ts` — `answerLocalOperatorInvoke` + I26 `isWriteForbiddenToolId` rejection
- `engine/executor.ts` — twelve types into `HITL_REQUIRED_BACKING`
- `connectors/registry.ts` (dispatch) — route warehouse-write action types to `invokeConnectorWrite`
- `teamvault/team-vault-audit.ts` — `identitySubject`
- `platform/assemble.ts` — wire `isWriteForbiddenToolId` + the write transport ctx
- I26 triple: `docs/SECURITY-INVARIANTS.md`, `security-invariants.test.ts`,
  `scripts/structure-audit/check-nimbus-invariants.ts` (D20) — **same commit as the wiring**

Then one commit **per connector** (the subagent-death lesson — connectors sharing registration files
run sequentially, commit per connector):

- `mcp-connectors/<svc>/src/server.ts` — two write tools + `assertHitlRequired`
- `mcp-connectors/<svc>/nimbus.extension.json` — `hitlRequired` includes the write permission
- gateway-side parse/shape helper for the write args if the connector needs one
- any scoping-id metadata the write needs but 7a does not index (e.g. Power BI `groupId` GUID in
  `powerbi-dashboard-mapping.ts`) — extended in the same per-connector commit (review §3)
- the connector's server-tool test + a transport/dispatch test for its two action types

No change to: `CONNECTOR_VAULT_SECRET_KEYS`, `TEAM_SECRET_ANYOF_GROUPS`, rate-limiter providers,
`FIRST_PARTY_MANIFESTS`, the V40 schema (no new credentials, no new item types, no migration).

---

## 6. Testing & ship-readiness

- **TDD per task.** Red → green → refactor for every handler, the transport, the gate variant, I26.
- **Coverage floor.** `baseline.json` is `{}` — every new file must clear ≥80% line+branch.
  `audit:coverage-floor` is CI-Linux-authoritative; run the Docker (`oven/bun:latest`) dry-run before
  the first push. New files: `warehouse-write-tools.ts`, `warehouse-write-transport.ts`, twelve
  server tools, the gate variant, the parse helpers — all ship with tests.
- **Invariant suite** count 25→26; static `check-nimbus-invariants` adds D20.
- **Contract tests** (`runContractTests`) green per connector; write tools listed in `hitlRequired`.
- **Ship-readiness before the FIRST push** (the #617 lesson — never push-and-see): full
  `bun run preflight`, the Docker coverage-floor dry-run, `bun run lint:markdown` on new docs, lychee
  on changed docs, whole-branch `/code-review`, then push + open PR. Add the CHANGELOG Wave 7c entry
  (connector-docs-changelog convention; do **not** edit the CLAUDE.md/GEMINI.md status line).

---

## 7. Manual live-verification checklist (Wave 7b cursor contract + Wave 7c writes)

Run once against a sandbox/staging account per connector before declaring the live contract verified
(documented here because it cannot run in CI):

- [ ] Snowflake: `tag.set` then read-back the tag; `comment.set` then read-back the comment.
- [ ] Tableau: `datasource.refresh` + `workbook.refresh` → job queued; paged `_list` cursor advances.
- [ ] Looker: `datagroup.trigger` invalidates; `schedule.run_once` returns a run id.
- [ ] Power BI: `dataset.refresh` + `dataflow.refresh` → 202 + refresh history entry.
- [ ] Monte Carlo: `incident.acknowledge` then `incident.resolve` reflected in the incident.
- [ ] Bigeye: `issue.acknowledge` then `issue.resolve` reflected in the issue.
- [ ] Each connector's read `_list` cursor pagination drains > 1 page against real data.

---

## 8. Out of scope / follow-ups

- Federated peer-requested writes behind local HITL (the I24-style option) — explicitly deferred;
  Wave 7c is local-owner-only by design.
- Snowflake arbitrary SQL execute; destructive (`delete`/drop) writes; monitor mute/silence.
- A dedicated "check refresh status" poll tool (review §2) — rely on the scheduled metadata sync.
- Bespoke per-error privilege-suggestion templating (review §5) — surface raw provider errors.
- Slice 8 (Share & Virality) and Slice 9 (deferred Phase 5 connectors) follow this wave.

---

## 9. Review responses (review doc 2026-06-14, fix/defer triage)

| # | Review point | Decision | Where |
|---|---|---|---|
| 1 | IPC/network isolation of `answerLocalOperatorInvoke` | **Fix** — confinement note + D20 static non-exposure assertion | §4.2, §4.4 |
| 2 | Async refresh job tracking / UX | **Fix (output shape) + Defer (poll tool)** — return job id + `status:"queued"`; no poll tool | §3, §8 |
| 3 | Scoping-id validation (Power BI group GUID / Tableau site) | **Fix** — index Power BI `groupId`; require ids in write schemas | §3, §5-files |
| 4 | Audit identity-subject fallback when identity disabled | **Fix (clarify)** — omit field (not sentinel); verified no-migration | §4.5 |
| 5 | Privilege/role mismatch UX | **Fix (surface errors) + Defer (suggestion templating)** | §3, §8 |

Verified during triage: team-vault audit is JSON-serialized (no migration for #4); Power BI 7a
metadata stores the workspace *name* not the group GUID (confirms the #3 gap); Tableau site is
connector-scoped so writes need only the workbook/datasource luid.
