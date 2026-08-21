import { describe, expect, it } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { policyFromManifest } from "./sandbox-policy.ts";

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "com.nimbus.github",
    version: "1.0.0",
    permissions: {
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    },
    updateChannel: "stable",
    ...over,
  } as ExtensionManifest;
}

describe("policyFromManifest", () => {
  it("carries the manifest id through as the policy id", () => {
    expect(policyFromManifest(manifest()).id).toBe("com.nimbus.github");
  });

  it("carries permissions through unchanged", () => {
    expect(policyFromManifest(manifest()).permissions).toEqual({
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    });
  });

  it("sets no limits — a connector is long-lived and is never wall-clock bounded", () => {
    expect(policyFromManifest(manifest()).limits).toBeUndefined();
  });

  it("does not leak non-permission manifest fields into the policy", () => {
    expect(Object.keys(policyFromManifest(manifest())).sort()).toEqual(["id", "permissions"]);
  });
});
