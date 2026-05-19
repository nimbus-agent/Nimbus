import { describe, expect, it, mock } from "bun:test";

import { ExtensionAutoUpdater, type InstalledExtensionRow } from "./auto-update.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";

function fakeInstalled(): InstalledExtensionRow[] {
  return [
    {
      id: "com.example.a",
      version: "1.0.0",
      install_path: "/x/com.example.a/active",
      enabled: 1,
      manifest: {
        id: "com.example.a",
        version: "1.0.0",
        updateChannel: "stable",
        publisher: { id: "pub", key: "AAAA" },
        permissions: { network: ["a.com"], filesystem: { read: [], write: [] } },
      },
    },
  ];
}

describe("ExtensionAutoUpdater", () => {
  it("does not start in air-gap mode", async () => {
    const cache = new AutoUpdateCache();
    const fetchLatest = mock(async () => null);
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: fetchLatest,
      fetchManifest: async () => {
        throw new Error("not called");
      },
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => null,
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: true,
      now: () => 0,
      random: () => 0,
    });
    await updater.start();
    expect(updater.isRunning()).toBe(false);
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("skips polling when registry returns the installed version", async () => {
    const cache = new AutoUpdateCache();
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: async () => ({ version: "1.0.0", channel: "stable" }),
      fetchManifest: async () => {
        throw new Error("not called");
      },
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => null,
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.pollOnce();
    expect(cache.list()).toEqual([]);
  });

  it("caches a verified update when registry returns a newer version", async () => {
    const cache = new AutoUpdateCache();
    const audits: Array<{ type: string; payload: unknown }> = [];
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: async () => ({ version: "1.1.0", channel: "stable" }),
      fetchManifest: async () => ({
        manifest: {
          id: "com.example.a",
          version: "1.1.0",
          updateChannel: "stable",
          publisher: { id: "pub", key: "AAAA" },
          signature: "BBBB",
          permissions: {
            network: ["a.com", "b.com"],
            filesystem: { read: [], write: [] },
          },
        },
        manifestHash: "deadbeef".repeat(8),
        entryHash: "cafef00d".repeat(8),
        tarballUrl: "https://r/x.tar.gz",
      }),
      verifyManifestSignature: async () => {}, // resolve = verify passed
      lookupPublisherKey: async () => new Uint8Array(32),
      appendAudit: async (type, payload) => {
        audits.push({ type, payload });
      },
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 1_000_000,
      random: () => 0,
    });
    await updater.pollOnce();

    const cached = cache.get("com.example.a");
    expect(cached?.toVersion).toBe("1.1.0");
    expect(cached?.verificationStatus).toBe("verified");
    expect(cached?.permissionDiff.network.added).toEqual(["b.com"]);
    expect(audits[0]?.type).toBe("extension.autoUpdate.detected");
  });

  it("marks needs_sync when publisher key is missing", async () => {
    const cache = new AutoUpdateCache();
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: async () => ({ version: "1.1.0", channel: "stable" }),
      fetchManifest: async () => ({
        manifest: {
          id: "com.example.a",
          version: "1.1.0",
          updateChannel: "stable",
          publisher: { id: "pub-rotated", key: "ZZZZ" },
          signature: "BBBB",
          permissions: { network: ["a.com"], filesystem: { read: [], write: [] } },
        },
        manifestHash: "deadbeef".repeat(8),
        entryHash: "cafef00d".repeat(8),
        tarballUrl: "https://r/x.tar.gz",
      }),
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => null, // not in vault
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.pollOnce();
    expect(cache.get("com.example.a")?.verificationStatus).toBe("needs_sync");
  });

  it("marks signature_failed when verifyManifestSignature throws", async () => {
    const cache = new AutoUpdateCache();
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: async () => ({ version: "1.1.0", channel: "stable" }),
      fetchManifest: async () => ({
        manifest: {
          id: "com.example.a",
          version: "1.1.0",
          updateChannel: "stable",
          publisher: { id: "pub", key: "AAAA" },
          signature: "BBBB",
          permissions: { network: ["a.com"], filesystem: { read: [], write: [] } },
        },
        manifestHash: "deadbeef".repeat(8),
        entryHash: "cafef00d".repeat(8),
        tarballUrl: "https://r/x.tar.gz",
      }),
      verifyManifestSignature: async () => {
        throw new Error("signature_failed");
      },
      lookupPublisherKey: async () => new Uint8Array(32),
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.pollOnce();
    expect(cache.get("com.example.a")?.verificationStatus).toBe("signature_failed");
  });

  it("skips unsigned (no publisher) extensions", async () => {
    const installed = fakeInstalled();
    delete installed[0]!.manifest.publisher;
    const cache = new AutoUpdateCache();
    const fetchLatest = mock(async () => null);
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => installed,
      fetchLatestVersion: fetchLatest,
      fetchManifest: async () => {
        throw new Error("not called");
      },
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => null,
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.pollOnce();
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(cache.list()).toEqual([]);
  });

  it("dedupes detection audit on repeat poll for same (id, toVersion)", async () => {
    const cache = new AutoUpdateCache();
    const audits: string[] = [];
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => fakeInstalled(),
      fetchLatestVersion: async () => ({ version: "1.1.0", channel: "stable" }),
      fetchManifest: async () => ({
        manifest: {
          id: "com.example.a",
          version: "1.1.0",
          updateChannel: "stable",
          publisher: { id: "pub", key: "AAAA" },
          signature: "BBBB",
          permissions: { network: ["a.com"], filesystem: { read: [], write: [] } },
        },
        manifestHash: "deadbeef".repeat(8),
        entryHash: "cafef00d".repeat(8),
        tarballUrl: "https://r/x.tar.gz",
      }),
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => new Uint8Array(32),
      appendAudit: async (type) => {
        audits.push(type);
      },
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.pollOnce();
    await updater.pollOnce();
    const detected = audits.filter((a) => a === "extension.autoUpdate.detected");
    expect(detected).toHaveLength(1);
  });

  it("stop is idempotent and clears running flag when started", async () => {
    const cache = new AutoUpdateCache();
    const updater = new ExtensionAutoUpdater({
      cache,
      listInstalled: async () => [],
      fetchLatestVersion: async () => null,
      fetchManifest: async () => {
        throw new Error("not called");
      },
      verifyManifestSignature: async () => {},
      lookupPublisherKey: async () => null,
      appendAudit: async () => {},
      intervalHours: 24,
      enforceAirGap: false,
      now: () => 0,
      random: () => 0,
    });
    await updater.start();
    expect(updater.isRunning()).toBe(true);
    await updater.stop();
    expect(updater.isRunning()).toBe(false);
    await updater.stop(); // no-op
    expect(updater.isRunning()).toBe(false);
  });
});
