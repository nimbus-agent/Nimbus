# Review & Feedback: Phase 6 Slice 9 — W1: GitOps + ML HITL Writes Plan Review

**Review Date:** 2026-06-20  
**Plan Document Reviewed:** [2026-06-20-slice9-w1-gitops-ml-writes.md](./2026-06-20-slice9-w1-gitops-ml-writes.md)  
**Status:** Plan Feedback / Suggestions / Improvements

---

## 1. Aligning MLflow Promote Default with Design Review (Task 11)

### Context
In **Task 11 (MLflow) Step 4**, the plan sets the default value of `archive_existing_versions` to `false` for both tools:
```ts
archive_existing_versions: p.archiveExisting ?? false,
```

### Suggestion
- In the corresponding design review, we recommended defaulting `archive_existing_versions` to `true` specifically for the `mlflow_model_promote` tool (which is designed as a direct model promotion action) to prevent multiple versions from being active in `Production` at the same time.
- **Recommendation:** If the design review recommendation is adopted, change the default for `mlflow_model_promote` to `true`:
  ```ts
  archive_existing_versions: p.archiveExisting ?? true,
  ```
  But keep it `false` (or optional) for `mlflow_model_transition_stage` to allow more flexible manual stage management.

---

## 2. Kubernetes / Flux Kind Constants Verification (Task 10)

### Context
In **Task 10 (Flux) Step 4**, the plan instructs to call `fluxReconcile`:
```ts
/* Kustomization kind const */ KIND_KUSTOMIZATION
/* HelmRelease kind const */ KIND_HELMRELEASE
```

### Suggestion
- In the actual Flux connector, these constants might be defined as properties on an enum or a custom mapping rather than standalone variables (e.g. `FluxKind.Kustomization` or `KIND_MAP.Kustomization`).
- **Recommendation:** Add a pre-check note in Task 10 to inspect `packages/mcp-connectors/flux/src/server.ts` first to identify the exact symbol names or import locations for the Kustomization and HelmRelease kind strings, avoiding compilation errors.

---

## 3. Double-Checking Injection Sites for Federated Writes (Task 7)

### Context
In **Task 7 Step 4**, the plan says:
> In `packages/gateway/src/ipc/federation-rpc.ts`: change the import `import { isWarehouseWriteToolId } from "../connectors/warehouse-write-tools.ts";` → `import { isConnectorWriteToolId } from "../connectors/connector-write-registry.ts";` and the injection (~line 495) `isWriteForbiddenToolId: isWarehouseWriteToolId,` → `isWriteForbiddenToolId: isConnectorWriteToolId,`.

### Suggestion
- While `federation-rpc.ts` exposes federation methods, the canonical preflight check and grant checking for queries and invokes occurs inside `packages/gateway/src/platform/assemble.ts` and `packages/gateway/src/federation/invoke-gate.ts`.
- **Recommendation:** Ensure that the developer verifies all places where `isWarehouseWriteToolId` is injected or referenced across the entire `packages/gateway/src/` hierarchy to guarantee no federated invocation route is missed. Running `git grep "isWarehouseWriteToolId"` right before Task 7 Step 4 is highly recommended.
