// packages/gateway/src/connectors/connector-writes/k8s-row.test-helpers.ts
// TEST-ONLY. A synthetic bound Kubernetes apply row (the shape the production row declares in
// D3a A7), for the confirm and declaration tests that need one before the production row exists.
import { K8S_INPUT_KEYS, K8S_LIMITS } from "./k8s-limits.ts";
import { k8sInputRefusal } from "./k8s-manifest.ts";
import {
  type BoundWrite,
  type ConnectorWriteRow,
  row,
  textField,
  withBound,
  withConfirm,
  withPreview,
} from "./types.ts";

export const K8S_TEST_BOUND: BoundWrite = {
  prepare: {
    tool: "k8s_manifest_plan",
    argKeys: K8S_INPUT_KEYS,
    args: (input) => {
      const out: Record<string, unknown> = {};
      for (const key of K8S_INPUT_KEYS) out[key] = input[key];
      return out;
    },
    select: () => [],
    settle: "k8s-manifest",
    preflight: "kubernetes",
    budgetMs: K8S_LIMITS.bound.budgetMs,
    maxInputBytes: K8S_LIMITS.bound.maxInputChars,
    maxReplyBytes: K8S_LIMITS.bound.maxReplyChars,
    inputRefusal: k8sInputRefusal,
  },
  binds: [
    { field: "planSha256", from: () => undefined },
    { field: "diffSha256", from: () => undefined },
  ],
};

/** The synthetic row, preview first, then bound, then the confirm that derives `{target}`. */
export function k8sTestRow(): ConnectorWriteRow {
  const previewed = withPreview(row("k8s_manifest_apply", "kubernetes.manifest.apply", "mesh", 4), {
    target: "{context}/{namespace}",
    summary: "Apply the manifest below to namespace {namespace} of context {context}",
    fields: [textField("context"), textField("namespace"), textField("manifest", "Manifest")],
  });
  return withConfirm(withBound(previewed, K8S_TEST_BOUND), {
    template: "apply {target}",
    derive: "k8s-target",
  });
}
