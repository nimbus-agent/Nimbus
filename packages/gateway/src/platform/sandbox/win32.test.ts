import { describe, expect, it } from "bun:test";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { capabilitiesForManifest, profileNameFor } from "./win32.ts";

function manifest(perms: Partial<ExtensionManifest["permissions"]> = {}): ExtensionManifest {
  return {
    id: "com.nimbus.test",
    version: "1.0.0",
    entrypoint: "x.js",
    runtime: "bun",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
    updateChannel: "stable",
  } as ExtensionManifest;
}

describe.skipIf(process.platform !== "win32")("win32 sandbox", () => {
  it("derives the profile name from the extension id", () => {
    expect(profileNameFor({ id: "com.nimbus.github" })).toBe("nimbus-ext-com.nimbus.github");
  });

  it("returns internetClient capability when permissions.network is non-empty", () => {
    const caps = capabilitiesForManifest(manifest({ network: ["api.github.com"] }));
    expect(caps).toContain("internetClient");
  });

  it("returns empty capability list when permissions.network is empty", () => {
    const caps = capabilitiesForManifest(manifest());
    expect(caps).toEqual([]);
  });
});
