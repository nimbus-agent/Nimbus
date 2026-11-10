/**
 * V86 — the owner's approved Kubernetes scope (Phase 9.7 D3a, invariant I54).
 *
 * `connector_write_k8s_grant`: what `nimbus connector writes enable kubernetes --grant
 * <namespace>@<context>` approved, one row per (context, namespace) pair. Each row pins the
 * context to the API server `host:port` and the credential FORM (never a value) it had in the
 * owner's kubeconfig at approval time; a later spawn whose kubeconfig no longer matches is refused.
 * Written only by the HITL-gated `connector.writes.enable` handler, which replaces the whole set;
 * `disable kubernetes` drops it. The runner reads it fresh for every child it starts.
 *
 * Backfill: none. Nothing was approved before this version, so no namespace is writable.
 */
export const CONNECTOR_WRITE_K8S_V86_SQL = [
  `CREATE TABLE IF NOT EXISTS connector_write_k8s_grant (
  context TEXT NOT NULL,
  namespace TEXT NOT NULL,
  server TEXT NOT NULL,
  credential_form TEXT NOT NULL CHECK (credential_form IN ('client-certificate', 'token')),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (context, namespace)
)`,
] as const;
