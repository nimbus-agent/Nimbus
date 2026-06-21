# Review & Feedback: Phase 6 Slice 9 — W1: GitOps + ML writes (ArgoCD / Flux / MLflow)

**Review Date:** 2026-06-20  
**Design Document Reviewed:** [2026-06-20-slice9-w1-gitops-ml-writes-design.md](./2026-06-20-slice9-w1-gitops-ml-writes-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. Flux RBAC & Kubernetes API Permissions

### Context

In **§3** (Write surface) and **§4.1**, the Flux connector performs Kustomization and HelmRelease reconciliation by directly patching custom resources (`reconcile.fluxcd.io/requestedAt` annotation) via the Kubernetes API server using `flux.token` (ServiceAccount Bearer token).

### Suggestions / Open Questions

1. **Required Permissions Update:**
   - A standard read-only Flux setup using Nimbus only requires `get`, `list`, and `watch` permissions. Writing/Patching requires the `patch` verb on both Kustomizations (`kustomize.toolkit.fluxcd.io`) and HelmReleases (`helm.toolkit.fluxcd.io`).
   - **Recommendation:** Document explicitly in the user-facing setup guide or tool errors that the ServiceAccount used for `flux.token` must be bound to a Role/ClusterRole with `patch` permissions.
2. **Error Diagnosis for Read-Only Tokens:**
   - If a user triggers a Flux reconcile and the token lacks `patch` permissions, the Kubernetes API server will respond with `403 Forbidden`.
   - **Recommendation:** Ensure the error handling in `flux_kustomization_reconcile` and `flux_helmrelease_reconcile` cleanly catches `403 Forbidden` errors and suggests upgrading the ServiceAccount RBAC permissions to include `patch`.

---

## 2. MLflow Transition Defaults (`archive_existing_versions`)

### Context

For `mlflow.model.promote` and `mlflow.model.transition_stage`, the API calls transition model versions to new stages (e.g., `Production`).

### Suggestions / Open Questions

1. **Defaulting `archive_existing_versions`:**
   - In MLflow, transitioning a version to `Production` can optionally archive existing versions in that stage (`archive_existing_versions: true` or `false`).
   - If not handled explicitly, MLflow might keep multiple versions active in `Production` or automatically archive them depending on server configurations.
   - **Recommendation:** Explicitly define the default behavior in the design. We suggest default-setting `archive_existing_versions` to `true` (or exposing it as an explicit parameter with a safe default) to match the expected behavior of a model promotion flow.

---

## 3. Asynchronous Execution and Verification UX

### Context

In **§3** (Write surface), ArgoCD sync and Flux reconcile are described as asynchronous operations (convergence occurs later). A dedicated poll tool is kept out of scope to avoid busy loops.

### Suggestions / Open Questions

1. **Agent Coordination on Async Writes:**
   - When an LLM agent executes `argocd.app.sync` or `flux.kustomization.reconcile`, it expects to verify the action has finished before taking downstream actions (e.g., verifying a deployment succeeded). Without a poll tool, the agent may check the local database immediately and find stale state.
   - **Recommendation:** Guide the agent in its system instructions or tool description to inform the user that the operation has been requested but is asynchronous. The agent can recommend using the `/schedule` command to verify success after a short interval (e.g., 2–5 minutes) when the next metadata sync runs, or manually triggering a metadata sync if one is available.

---

## 4. Drift Test Robustness

### Context

In **§4.3**, a drift test is planned to tie `actionType` in `HITL_REQUIRED` with the registered tool IDs.

### Suggestions

1. **Assert Invariant Completeness:**
   - Ensure the drift test in `packages/gateway/src/security-invariants.test.ts` or `scripts/structure-audit/check-nimbus-invariants.ts` programmatically checks that all connector-write tool IDs returned by `isConnectorWriteToolId` are explicitly listed in `HITL_REQUIRED_BACKING` in `engine/executor.ts`.
   - This ensures that adding any new write action in the future automatically triggers a test failure if the developer forgets to add it to the HITL gate, maintaining the integrity of I26/I2.
