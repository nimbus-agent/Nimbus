# Phase 6 Slice 9 — W1: HITL-gated WRITE actions for the GitOps + ML connectors (ArgoCD / Flux / MLflow)

**Date:** 2026-06-20
**Branch:** `worktree-phase6-slice9-wrapup` (off origin/main `e0d30544`, release 0.13.1; invariants I1–I27)
**Status:** Design — approved for plan-writing
**Slice 9 wrapup unit:** W1 (of W1–W5). Roadmap items: GitOps writes (C) + the REST subset of ML writes (D).

---

## 1. Summary

The ArgoCD, Flux, and MLflow connectors are **read-only** today (Phase 5 Tier 1; metadata indexing
+ three read tools each, `hitlRequired: []`). W1 adds **HITL-gated WRITE actions** — six total — that
execute **only** behind the local owner's I2 consent gate, with a **personal _and_ team-credential**
path for all three (discrete-token connectors fit the team-vault model cleanly).

W1 is a near-exact replay of **Wave 7c (warehouse/BI writes, I26)**: the same single-source-of-truth
write-tools mapping, the same `HITL_REQUIRED_BACKING` frozen-set addition, the same already-generic
write transport, and the same `answerLocalOperatorInvoke` team-write rail. The one structural change
is **generalizing invariant I26** from "warehouse/BI write tool ids" to **"connector write tool ids"**
so the federated peer invoke gate fail-closed rejects GitOps/ML writes too — **with no new invariant
number** (which sidesteps the in-flight I28/I29 numbering collision on the unmerged
MCP-server + egress-ledger branches).

**No new SQLite migration; no new item types.** The only credential change is enrolling the three
connectors' existing tokens in `TEAM_SECRET_ANYOF_GROUPS`.

### 1.1 Explicitly excluded / deferred (kept honest in the roadmap)

- **SageMaker writes** (`endpoint.update` / `endpoint.delete` / `job.stop`) and **Vertex AI writes**
  (`endpoint.update` / `pipeline.cancel`) — **remain deferred.** These are Tier-3 "no-row-data"
  connectors that shell the **aws / gcloud CLI** against the local provider credential chain
  (`CONNECTOR_VAULT_SECRET_KEYS` is empty for both). They have no discrete token, so they fit
  neither the team-vault credential model nor the discrete-token write transport cleanly, and sharing
  a cloud-provider CLI credential through team-vault is a real security-surface expansion, not just
  more code. They are also S5-demoted ("commodity, API-fakeable → not a moat") by the Phase 7+
  re-sequence. Revisit only if/when a discrete-token credential path exists for them. The roadmap
  rows are updated to record this.
- **Any destructive write** (`delete` / drop / endpoint teardown) — out of scope, matching the
  Wave 7c safety posture. W1 writes are all idempotent-ish operational actions (sync / reconcile /
  stage-transition). The destructive `ml.endpoint.delete` the roadmap listed for SageMaker is dropped
  with the SageMaker deferral above.

---

## 2. Non-negotiables honored

- **HITL is structural (executor, not prompt).** All six write action types are added to the frozen
  `HITL_REQUIRED_BACKING` set in `engine/executor.ts`; the I2 test asserts every member triggers the
  consent channel. Writes cannot be configured away.
- **No peer-triggered writes without local consent.** The generalized I26 fail-closed rejects every
  connector write tool id on the federated path; the only write path is the locally-I2-gated executor
  dispatch (peer or not).
- **No plaintext credentials.** No new secret keys; the three tokens already live in Vault. Team
  sourcing stays inside the I19 gate; the write transport injects secrets into the subprocess env
  exactly as the read transport does.
- **MCP as connector standard.** Writes are real MCP tools on the connector servers; the gateway
  never calls a cloud API directly.
- **No `any`.** External payloads typed `unknown`; strict mode. Write-arg schemas are Zod-validated.

---

## 3. Write surface (the six actions)

Themed: deploy lifecycle (ArgoCD), reconcile (Flux), model-stage governance (MLflow). One MCP tool +
one **service-prefixed** HITL `action.type` per row. (Service-prefixing is mandatory: I3 keys the
HITL gate on `action.type` alone, and the SSoT maps `actionType → {toolId, service}` 1:1 — generic
families like `gitops.*` / `ml.endpoint.update` would collide. The roadmap's generic names are
realized as the service-specific types below.)

| Connector | `action.type` | MCP tool id | API call (reference-pinned in the plan) |
|---|---|---|---|
| ArgoCD | `argocd.app.sync` | `argocd_app_sync` | `POST /api/v1/applications/{name}/sync` (optional `prune`, `revision`) |
| ArgoCD | `argocd.app.rollback` | `argocd_app_rollback` | `POST /api/v1/applications/{name}/rollback` (`id` = target history id) |
| Flux | `flux.kustomization.reconcile` | `flux_kustomization_reconcile` | `PATCH` the Kustomization CR: set `metadata.annotations["reconcile.fluxcd.io/requestedAt"]` = RFC3339 now |
| Flux | `flux.helmrelease.reconcile` | `flux_helmrelease_reconcile` | `PATCH` the HelmRelease CR: same `reconcile.fluxcd.io/requestedAt` annotation |
| MLflow | `mlflow.model.promote` | `mlflow_model_promote` | `POST /api/2.0/mlflow/model-versions/transition-stage` → `stage: "Production"` (`archive_existing_versions` optional) |
| MLflow | `mlflow.model.transition_stage` | `mlflow_model_transition_stage` | `POST /api/2.0/mlflow/model-versions/transition-stage` → caller-supplied `stage` (Staging/Production/Archived) |

**Reference-API pinning (the #595 lesson).** Each request shape — auth header, base URL resolution,
path params, body — is fixed in the **plan** from the connector's existing `*-sync.ts` read code +
the vendor docs **before** any handler is written. Two items need explicit verification in the plan:

- **Flux reconcile is a Kubernetes-CR PATCH, not a Flux endpoint.** The read connector reads via
  `flux.api_url` + `flux.token` (SA Bearer); reconcile is performed by annotating the custom resource
  (`reconcile.fluxcd.io/requestedAt`) through the kube-apiserver path. The plan pins the exact
  `apiVersion`/`kind`/`namespace`/`name` → URL mapping for Kustomization
  (`kustomize.toolkit.fluxcd.io`) and HelmRelease (`helm.toolkit.fluxcd.io`) from the read connector's
  resource model, and confirms `flux.api_url` reaches a PATCH-capable apiserver path. If the
  read connector's `api_url` is a read-only proxy, this becomes a plan-time blocker to resolve
  (fail the plan, don't guess).
- **`mlflow.model.promote` is a thin alias** over transition-stage with `stage` pinned to
  `Production` — kept as a distinct action type for a cleaner HITL prompt ("promote to Production")
  and a tighter arg schema (no free `stage`).

**Scoping-id args.** Write-arg Zod schemas validate the ids each endpoint requires, sourced by the
agent from indexed metadata: ArgoCD `name` (the `argocd:application` external id); Flux
`kind`/`namespace`/`name` (the `flux:resource` model already carries these); MLflow model `name` +
`version` (the `ml_model` metadata carries name + latest_version). A plan task verifies each write's
required ids are retrievable from indexed metadata and adds any missing field before the handler.

**Async output shape.** ArgoCD sync and Flux reconcile are asynchronous (the action is *requested*;
convergence happens later). Each such tool's result (through the I11 `wrapToolOutput` envelope)
returns the operation/sync id (ArgoCD) or `status: "requested"` (Flux) with an explicit non-complete
marker, so the agent does not treat it as synchronously done. Verification is via the next scheduled
metadata sync (ArgoCD already indexes `sync_status`/`health_status`; Flux indexes Ready conditions).
A dedicated poll tool is out of scope (§8).

**Error surfacing.** Provider errors (ArgoCD `403`/sync-in-progress `409`, Flux RBAC `403`, MLflow
`RESOURCE_DOES_NOT_EXIST` / stage-permission) are propagated with provider status + message through
the I11 envelope, not swallowed.

---

## 4. Architecture

### 4.1 Connector write tools (server-side)

Each connector's `src/server.ts` gains its two write tools (ArgoCD/MLflow) or two write tools (Flux)
through the existing `register<Svc>Tools(reg: ZodToolRegistrar)` export. Tools are thin API callers
reading credentials from `process.env` only; real stdio transport stays guarded by
`if (import.meta.main)`. Per the connector contract each write tool calls
`server.assertHitlRequired()` at the top of its handler and is listed in the manifest `hitlRequired`
array, but the **authoritative** gate is gateway-side (I2). Server tools are unit-tested via the
inline-registrar `captureTools()` pattern with a `globalThis.fetch` stub — no subprocess spawn.

### 4.2 Local write flow — the only write path (reuses I2, no new gate file)

```text
LLM agent plans a write action:
  { type: "argocd.app.sync",
    payload: { mcpToolId: "argocd_app_sync",
               credential: "personal" | "team", entry?: "<team-entry>",
               ...validated params } }
        │
executor.execute(action) → gate()  ── I2 HITL consent (local owner) ──►  reject | proceed
        │ proceed
connectors.dispatch(action)
        │  (action.type ∈ connector-write set → credential-aware route)
        ▼
invokeConnectorWrite(ctx, { service, writeToolId, args })   ← already generic (Wave 7c)
        ├─ personal → withConnectorSession(serviceScopedVaultView) → session.call(writeToolId, args)
        └─ team     → answerLocalOperatorInvoke (existing I19 local-operator single-tool variant)
```

- **HITL:** the six action types are added to `HITL_REQUIRED_BACKING` in `engine/executor.ts`. The
  existing I2 test asserts every member triggers the consent channel, so each local write is gated
  automatically. **No separate local write-gate file** — the executor's `gate()` is the local HITL
  gate, structurally upstream of `connectors.dispatch`.
- **Transport reuse (improve-the-code-you're-in).** The Wave 7c transport `invokeConnectorWrite` is
  **already service-agnostic** (it takes `service`/`writeToolId`/`args` and branches personal/team).
  W1 **renames** `connectors/warehouse-write-transport.ts` → `connectors/connector-write-transport.ts`
  and `WarehouseWriteContext` → `ConnectorWriteContext` (no logic change), and reuses it for all
  connector writes. The E2E sink seam and the `__setPersonalInvokeForTest` DI seam are retained.
- **Team-credentialed write:** reuses the existing `answerLocalOperatorInvoke` (added by 7c) — no new
  gate code. The three connectors' tokens are enrolled in `TEAM_SECRET_ANYOF_GROUPS`
  (`argocd: [["argocd.token"]]`, `flux: [["flux.token"]]`, `mlflow: [["mlflow.token"]]`).
- **Confinement of the local write path.** `answerLocalOperatorInvoke` and `invokeConnectorWrite`
  remain strictly internal to the gateway connector-execution layer: not IPC methods, not in the
  Tauri `ALLOWED_METHODS` (I7), not LAN-reachable (I5), not HTTP write routes (I13). The only trigger
  is `connectors.dispatch` reached after `executor.gate()` returns `proceed`. D20's existing
  non-exposure assertion (no import under `ipc/` or `ui/src-tauri/`) already covers the renamed
  transport symbol.

### 4.3 Single source of truth — per-group module + a union registry

New `connectors/gitops-ml-write-tools.ts` mirrors `warehouse-write-tools.ts` exactly (same
`{ actionType, toolId, service }` shape, same compact builder):

```ts
export const GITOPS_ML_WRITES: readonly ConnectorWrite[] = [
  w("argocd.app.sync",                 "argocd_app_sync",                 "argocd"),
  w("argocd.app.rollback",             "argocd_app_rollback",             "argocd"),
  w("flux.kustomization.reconcile",    "flux_kustomization_reconcile",    "flux"),
  w("flux.helmrelease.reconcile",      "flux_helmrelease_reconcile",      "flux"),
  w("mlflow.model.promote",            "mlflow_model_promote",            "mlflow"),
  w("mlflow.model.transition_stage",   "mlflow_model_transition_stage",   "mlflow"),
];
export const GITOPS_ML_WRITE_TOOL_IDS: ReadonlySet<string>;
export function isGitopsMlWriteToolId(toolId: string): boolean;
export function gitopsMlWriteByActionType(type: string): ConnectorWrite | undefined;
```

The shared `ConnectorWrite` interface + the `w()` builder are **hoisted** out of
`warehouse-write-tools.ts` into a small shared module (`connectors/connector-write.ts`) so the two
group modules don't duplicate the type (keeps the jscpd gate green). A thin union registry
(`connectors/connector-write-registry.ts`) exposes:

```ts
export function isConnectorWriteToolId(id: string): boolean;   // warehouse ∪ gitops-ml
export function connectorWriteByActionType(type: string): ConnectorWrite | undefined;  // union map
```

This module drives: the dispatch routing (4.2), the generalized I26 predicate (4.4), and a **drift
test** asserting (a) every `actionType` is present in `HITL_REQUIRED`, and (b) every `toolId` is
registered by its connector server. The HITL strings stay hand-declared in `executor.ts` (per the
invariant rule); the drift test ties the lists so neither silently diverges.

### 4.4 Generalized invariant I26 / static D20 — federated write confinement (no new number)

**Statement (generalized).** *Connector* write tool ids (warehouse/BI ∪ GitOps/ML) execute only
behind the local owner's executor I2 HITL gate. The federated peer invoke gate
(`federation/invoke-gate.ts` `answerFederatedInvoke`, I19) fail-closed **rejects** any
write-classified tool id before grant/quorum resolution.

**Wiring change.** The `assemble.ts` federation-invoke construction site changes its injected
predicate from `isWriteForbiddenToolId: isWarehouseWriteToolId` to
`isWriteForbiddenToolId: isConnectorWriteToolId` (the union). `answerFederatedInvoke` is unchanged —
it already consults the predicate and audits `write_forbidden`. `answerLocalOperatorInvoke` still does
**not** receive the predicate (local owner is allowed to write).

**Triple rule — all in the same commit:**

1. *Wiring:* the `assemble.ts` predicate swap to the union.
2. *Docs:* the I26 row in `docs/SECURITY-INVARIANTS.md` is **reworded** from "warehouse/BI write tool
   ids" to "connector write tool ids." **No new invariant id is added or removed** — I26 is
   generalized in place, so the invariant roster (and any per-block count) is unchanged; only I26's
   wording (and its examples) update. No invariant-count prose laggard needs a number bump.
3. *Test:* `security-invariants.test.ts` — extend the existing I26 test so a peer with a valid grant
   for a **GitOps/ML** write tool id over `answerFederatedInvoke` returns an error and `runTool` is
   never called (and `answerLocalOperatorInvoke` DOES call `runTool` for the same id). Keep the
   warehouse assertions.
4. *Static:* **D20** in `scripts/structure-audit/check-nimbus-invariants.ts` — extend the literal
   confinement to also confine the GitOps/ML write tool id literals to `gitops-ml-write-tools.ts` +
   the three connector servers + the dispatch/transport sites, and assert `assemble.ts` injects the
   **union** predicate. The non-exposure (no `ipc/`/`ui` import) assertion now covers the renamed
   `connector-write-transport.ts`.

**No `CURRENT_INVARIANT_COUNT` bump** — W1 generalizes I26 rather than adding I28/I29/I30, deliberately
avoiding the in-flight MCP-server (I28) + egress-ledger (I29) numbering collision on other branches.

---

## 5. Files touched

Shared gateway scaffolding (one commit, lands first):

- `connectors/connector-write.ts` (new) — hoisted `ConnectorWrite` type + `w()` builder + test
- `connectors/warehouse-write-tools.ts` — import the hoisted type/builder (no behavior change)
- `connectors/gitops-ml-write-tools.ts` (new) — the six rows + predicate + by-action-type + test
- `connectors/connector-write-registry.ts` (new) — union predicate + union map + test
- `connectors/warehouse-write-transport.ts` → **rename** `connector-write-transport.ts`
  (`WarehouseWriteContext` → `ConnectorWriteContext`); update importers
- `engine/executor.ts` — six types into `HITL_REQUIRED_BACKING`
- `connectors/registry.ts` (dispatch) — route connector-write action types via the union map to
  `invokeConnectorWrite`
- `connectors/connector-secrets-manifest.ts` — enroll `argocd`/`flux`/`mlflow` in
  `TEAM_SECRET_ANYOF_GROUPS`
- `platform/assemble.ts` — swap `isWriteForbiddenToolId` to `isConnectorWriteToolId`
- I26 generalization triple: `docs/SECURITY-INVARIANTS.md`, `security-invariants.test.ts`,
  `scripts/structure-audit/check-nimbus-invariants.ts` (D20) — **same commit as the wiring**

Then one commit **per connector** (the subagent-death lesson — files shared across connectors run
sequentially, commit per connector):

- `mcp-connectors/<svc>/src/server.ts` — two write tools + `assertHitlRequired`
- `mcp-connectors/<svc>/nimbus.extension.json` — `hitlRequired` includes the write permission(s)
- gateway-side parse/shape helper for the write args if the connector needs one
- any scoping-id metadata the write needs but Phase 5 read does not index (verified per §3)
- the connector's server-tool test + a transport/dispatch test for its two action types

No change to: `CONNECTOR_VAULT_SECRET_KEYS` (no new secrets), rate-limiter providers,
`FIRST_PARTY_MANIFESTS`, the schema (no migration — stays V43), the item types.

---

## 6. Testing & ship-readiness

- **TDD per task.** Red → green → refactor for every handler, the union registry, the generalized
  I26 test, the drift test.
- **Coverage floor.** Every new file (`connector-write.ts`, `gitops-ml-write-tools.ts`,
  `connector-write-registry.ts`, six server tools, parse helpers) must clear ≥80% line+branch.
  `audit:coverage-floor` is CI-Linux-authoritative; run the Docker (`oven/bun:latest`) dry-run
  before the first push.
- **Invariant suite**: no invariant added/removed (I26 generalized in place); static
  `check-nimbus-invariants` D20 broadened (not a new D).
- **Contract tests** (`runContractTests`) green per connector; write tools listed in `hitlRequired`.
- **Ship-readiness before the FIRST push** (never push-and-see): full `bun run preflight`, the Docker
  coverage-floor dry-run, `bun run lint:markdown` on new docs, `lychee` on changed docs, whole-branch
  `/code-review`, then push + open PR. Add the CHANGELOG W1 entry (connector-docs-changelog
  convention; do **not** edit the CLAUDE.md/GEMINI.md status line). Roadmap rows updated: the three
  GitOps/MLflow write items checked off; the SageMaker/Vertex write rows annotated "remains deferred —
  CLI-credential connectors, no discrete-token path".

---

## 7. Manual live-verification checklist

Run once against a sandbox/staging account per connector before declaring the live contract verified
(cannot run in CI — no live credentials):

- [ ] ArgoCD: `app.sync` returns a sync/operation id; `sync_status` reflects on next metadata sync.
      `app.rollback` to a prior history id succeeds.
- [ ] Flux: `kustomization.reconcile` + `helmrelease.reconcile` update `reconcile.fluxcd.io/requestedAt`
      and trigger a reconcile (Ready condition `lastHandledReconcileAt` advances).
- [ ] MLflow: `model.promote` moves the version to `Production`; `model.transition_stage` to an
      explicit stage; read-back via the registry reflects the new stage.
- [ ] Team path: with a connector's token stored in a team-vault entry and `credential = "team"`, the
      same write succeeds through `answerLocalOperatorInvoke` and is audited.

---

## 8. Out of scope / follow-ups

- **SageMaker / Vertex AI writes** — deferred (CLI-credential connectors; §1.1). The roadmap rows
  record the reason.
- **Federated peer-requested writes behind local HITL** (the I24-style option) — deferred; W1 is
  local-owner-triggered only.
- **Destructive writes** (`delete`/drop/endpoint teardown) — out of scope.
- **A "check status" poll tool** for the async ArgoCD/Flux operations — rely on scheduled metadata sync.
- Slice 9 W2 (Workday) → W3 (Apple Mail + macOS Calendar) → W4 (Web clipper) → W5 (Marketplace
  monetization, best-effort) follow this unit, each its own spec → plan.
