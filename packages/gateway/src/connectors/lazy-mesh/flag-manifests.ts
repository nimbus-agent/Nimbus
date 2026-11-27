import type { ExtensionManifest } from "../../extensions/manifest.ts";

// The feature-flag connectors' sandbox policies, spread into `FIRST_PARTY_MANIFESTS`. None of them
// writes to the filesystem. LaunchDarkly, Flagsmith and Split each have one fixed vendor host
// (Flagsmith's stored `api_base`, when set, is added at spawn time). Unleash is self-hosted and has
// no default, so its network list is empty here and the host of the owner's stored `unleash.api_url`
// is added at spawn time as an owner-configured entry (`phase3-delivery.ts`, as for Argo CD).

function manifest(id: string, network: string[]): ExtensionManifest {
  return {
    id,
    version: "1.0.0",
    permissions: { network, filesystem: { read: [], write: [] } },
    updateChannel: "stable",
  };
}

export const FLAG_FIRST_PARTY_MANIFESTS: Record<string, ExtensionManifest> = {
  launchdarkly: manifest("com.nimbus.launchdarkly", ["app.launchdarkly.com"]),
  flagsmith: manifest("com.nimbus.flagsmith", ["api.flagsmith.com"]),
  unleash: manifest("com.nimbus.unleash", []),
  split: manifest("com.nimbus.split", ["api.split.io"]),
};
