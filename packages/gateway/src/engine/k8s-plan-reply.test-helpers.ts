// packages/gateway/src/engine/k8s-plan-reply.test-helpers.ts
// TEST-ONLY. The connector's `k8s_manifest_plan` reply for a manifest whose objects are all new,
// BUILT FROM the installed connector's own functions (the order its handler uses them), never typed
// by hand: a connector that changes its reply shape or its diff text fails the tests that use this.
import { join } from "node:path";
import { k8sPlanHash } from "../connectors/connector-writes/k8s-manifest.ts";
import { installedConnectorsPackageRoot } from "../connectors/testing/connector-write-registrations.ts";

type Obj = Record<string, unknown>;
const kubeDir = join(installedConnectorsPackageRoot(), "connectors", "kubernetes", "src");
const diffMod = (await import(join(kubeDir, "manifest-diff.ts"))) as {
  unpackKubeJson: (data: unknown) => Map<string, Obj>;
  planDiff: (planned: Map<string, Obj>, live: Map<string, Obj>) => string;
  diffSha256: (diff: string) => string;
};
const scanMod = (await import(join(kubeDir, "manifest-scan.ts"))) as {
  scanNamespacedManifest: (text: string, ns: string) => unknown[];
};
const yamlMod = (await import("js-yaml")) as { loadAll: (text: string) => unknown[] };

export function planReply(manifest: string, namespace: string, context: string): Obj {
  const docs = yamlMod.loadAll(manifest) as Obj[];
  const items = docs.map((d) => ({ ...d, metadata: { ...(d["metadata"] as Obj), namespace } }));
  const planned = diffMod.unpackKubeJson({ kind: "List", items });
  const diff = diffMod.planDiff(planned, diffMod.unpackKubeJson(null));
  return {
    planSha256: k8sPlanHash(context, namespace, manifest),
    diffSha256: diffMod.diffSha256(diff),
    namespace,
    objects: [...planned.keys()],
    scanned: scanMod.scanNamespacedManifest(manifest, namespace),
    diff,
    hasDifferences: diff !== "",
  };
}
