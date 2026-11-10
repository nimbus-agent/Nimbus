// packages/gateway/src/connectors/connector-writes/k8s-bound.ts
// The bound declaration of the plan-bound Kubernetes apply (Phase 9.7 D3a, invariant I54): the
// sixth bound row. It is bound to the identity of the plan its PREPARE tool (`k8s_manifest_plan`)
// made, but never to what that tool SAYS about it: the row names the `k8s-manifest` settle tag, and
// the gateway's settler (`engine/k8s-settle.ts`, reached through the dispatcher's
// `boundWriteCapabilities`) computes both hashes itself from the input it shows (the plan hash over
// context, namespace and manifest; the diff hash over the diff text it renders) after its own parse
// of the manifest agrees with the connector's scan. The `from` readers below are therefore only the
// SHAPE check of the connector's reply (a row's binds must name the settler's value keys,
// `SETTLE_VALUE_KEYS`); the values bound are the settler's.
//
// The connector's plan reply (installed 0.11.0, `connectors/kubernetes/src/tools.ts`):
// `{planSha256, diffSha256, namespace, objects, scanned, diff, hasDifferences}`. Imported BY
// `cloud-infra.ts`; imports nothing from the row table or the executor.

import { NO_REPLY_FACTS, replyString } from "./iac-bound.ts";
import { K8S_INPUT_KEYS, K8S_LIMITS } from "./k8s-limits.ts";
import { k8sInputRefusal } from "./k8s-manifest.ts";
import type { BoundWrite } from "./types.ts";

/**
 * `k8s_manifest_apply`: bound to the plan `k8s_manifest_plan` made for exactly this context,
 * namespace and manifest. The prepare read takes the write's own keys (`context`, `namespace`,
 * `manifest`) and nothing else; `planSha256` and `diffSha256` are the gateway's.
 */
export const K8S_APPLY_BOUND: BoundWrite = {
  prepare: {
    tool: "k8s_manifest_plan",
    argKeys: K8S_INPUT_KEYS,
    args: (input) => {
      const out: Record<string, unknown> = {};
      for (const key of K8S_INPUT_KEYS) {
        const v = input[key];
        if (typeof v !== "string") return undefined;
        out[key] = v;
      }
      return out;
    },
    select: NO_REPLY_FACTS,
    settle: "k8s-manifest",
    preflight: "kubernetes",
    budgetMs: K8S_LIMITS.bound.budgetMs,
    maxInputBytes: K8S_LIMITS.bound.maxInputChars,
    maxReplyBytes: K8S_LIMITS.bound.maxReplyChars,
    inputRefusal: k8sInputRefusal,
  },
  binds: [
    { field: "planSha256", from: replyString("planSha256") },
    { field: "diffSha256", from: replyString("diffSha256") },
  ],
};
