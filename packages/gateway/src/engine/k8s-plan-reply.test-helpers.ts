// packages/gateway/src/engine/k8s-plan-reply.test-helpers.ts
// TEST-ONLY. The connector's `k8s_manifest_plan` reply for a manifest whose objects are all new,
// BUILT FROM the installed connector's own functions (the order its handler uses them), never typed
// by hand: a connector that changes its reply shape or its diff text fails the tests that use this.
import { createRequire } from "node:module";
import { join } from "node:path";
import { k8sPlanHash } from "../connectors/connector-writes/k8s-manifest.ts";
import { installedConnectorsPackageRoot } from "../connectors/testing/connector-write-registrations.ts";

type Obj = Record<string, unknown>;
const kubeDir = join(installedConnectorsPackageRoot(), "connectors", "kubernetes", "src");
// Synchronous loads, not a top-level dynamic import: under `--parallel` a second test file that
// imports this helper could read a binding before the first file's top-level await settled
// ("Cannot access 'yamlMod' before initialization").
const load = createRequire(import.meta.url);
const diffMod = load(join(kubeDir, "manifest-diff.ts")) as {
  unpackKubeJson: (data: unknown) => Map<string, Obj>;
  planDiff: (planned: Map<string, Obj>, live: Map<string, Obj>) => string;
  diffSha256: (diff: string) => string;
};
const scanMod = load(join(kubeDir, "manifest-scan.ts")) as {
  scanNamespacedManifest: (text: string, ns: string) => unknown[];
};
const yamlMod = load("js-yaml") as { loadAll: (text: string) => unknown[] };

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
