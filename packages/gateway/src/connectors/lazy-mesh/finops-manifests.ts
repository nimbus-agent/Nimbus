import type { ExtensionManifest } from "../../extensions/manifest.ts";

// The FinOps connectors' sandbox policies (Phase 10), spread into `FIRST_PARTY_MANIFESTS`. None of them
// writes to the filesystem. Vantage has one fixed vendor host; OpenCost and Kubecost run in the owner's
// own cluster, so their network list is empty here and the one host the owner stored is added at
// spawn time as an owner-configured entry (`phase3-finops.ts`, as for Argo CD).

function manifest(id: string, network: string[]): ExtensionManifest {
  return {
    id,
    version: "1.0.0",
    permissions: { network, filesystem: { read: [], write: [] } },
    updateChannel: "stable",
  };
}

export const FINOPS_FIRST_PARTY_MANIFESTS: Record<string, ExtensionManifest> = {
  vantage: manifest("com.nimbus.vantage", ["api.vantage.sh"]),
  opencost: manifest("com.nimbus.opencost", []),
  kubecost: manifest("com.nimbus.kubecost", []),
};
