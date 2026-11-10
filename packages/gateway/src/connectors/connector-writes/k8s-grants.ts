// packages/gateway/src/connectors/connector-writes/k8s-grants.ts
// The owner's approved Kubernetes scope (Phase 9.7 D3a, invariant I54, V86
// `connector_write_k8s_grant`): one row per approved (context, namespace) pair, each pinning its
// context to the API server `host:port` and the credential form the kubeconfig had at approval.
// Written only by the HITL-gated `connector.writes.enable kubernetes` handler (it replaces the whole
// set, never merges); read fresh by the runner for every child it starts.
import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { KUBE_CREDENTIAL_FORMS, type KubeCredentialForm } from "./kubeconfig-facts.ts";

export interface K8sGrant {
  readonly context: string;
  readonly namespace: string;
  /** The context's API server as `host:port`. */
  readonly server: string;
  readonly credentialForm: KubeCredentialForm;
}

function isForm(v: string): v is KubeCredentialForm {
  return (KUBE_CREDENTIAL_FORMS as readonly string[]).includes(v);
}

function order(a: K8sGrant, b: K8sGrant): number {
  if (a.context !== b.context) return a.context < b.context ? -1 : 1;
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  return 0;
}

/** The stored grants, in (context, namespace) code-unit order. A row with a form no longer accepted is dropped: fail closed. */
export function getK8sGrants(db: Database): K8sGrant[] {
  const rows = db
    .query("SELECT context, namespace, server, credential_form FROM connector_write_k8s_grant")
    .all() as Array<{
    context: string;
    namespace: string;
    server: string;
    credential_form: string;
  }>;
  return rows
    .filter((r) => isForm(r.credential_form))
    .map((r) => ({
      context: r.context,
      namespace: r.namespace,
      server: r.server,
      credentialForm: r.credential_form as KubeCredentialForm,
    }))
    .sort(order);
}

/** Replaces the whole stored set (re-enabling replaces, it never merges). A repeated pair keeps its last entry. */
export function setK8sGrants(db: Database, grants: readonly K8sGrant[], now: number): void {
  const byPair = new Map<string, K8sGrant>();
  for (const g of grants) byPair.set(JSON.stringify([g.context, g.namespace]), g);
  db.transaction(() => {
    dbRun(db, "DELETE FROM connector_write_k8s_grant");
    for (const g of [...byPair.values()].sort(order)) {
      dbRun(
        db,
        "INSERT INTO connector_write_k8s_grant (context, namespace, server, credential_form, approved_at) VALUES (?, ?, ?, ?, ?)",
        [g.context, g.namespace, g.server, g.credentialForm, now],
      );
    }
  })();
}

/** Drops every grant (narrowing needs no approval). True when something was stored. */
export function removeK8sGrants(db: Database): boolean {
  return dbRun(db, "DELETE FROM connector_write_k8s_grant").changes > 0;
}

/** The grant for exactly this (context, namespace) pair, or `undefined`. */
export function k8sGrantFor(
  grants: readonly K8sGrant[],
  context: string,
  namespace: string,
): K8sGrant | undefined {
  return grants.find((g) => g.context === context && g.namespace === namespace);
}
