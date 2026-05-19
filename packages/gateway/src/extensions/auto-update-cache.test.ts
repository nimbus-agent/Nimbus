import { describe, expect, it } from "bun:test";

import { AutoUpdateCache } from "./auto-update-cache.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";

function mk(id: string, toVersion: string, detectedAt = 1_000_000): AvailableUpdate {
  return {
    id,
    displayName: id,
    fromVersion: "1.0.0",
    toVersion,
    channel: "stable",
    changelog: "",
    publisherStatus: "verified",
    manifestHash: "0".repeat(64),
    signatureB64: "AA==",
    entryHash: "0".repeat(64),
    tarballUrl: "https://r/x",
    permissionDiff: {
      network: { added: [], removed: [] },
      filesystem: {
        read: { added: [], removed: [] },
        write: { added: [], removed: [] },
      },
    },
    verificationStatus: "verified",
    detectedAt,
  };
}

describe("AutoUpdateCache", () => {
  it("starts empty", () => {
    const c = new AutoUpdateCache();
    expect(c.list()).toEqual([]);
    expect(c.get("any")).toBeUndefined();
  });

  it("upsert replaces the entry for a given id", () => {
    const c = new AutoUpdateCache();
    c.upsert(mk("a", "1.1.0"));
    c.upsert(mk("a", "1.2.0"));
    expect(c.get("a")?.toVersion).toBe("1.2.0");
    expect(c.list()).toHaveLength(1);
  });

  it("isNewDetection true for first detection of (id, toVersion)", () => {
    const c = new AutoUpdateCache();
    const u = mk("a", "1.1.0");
    expect(c.isNewDetection(u)).toBe(true);
    c.upsert(u);
    expect(c.isNewDetection(u)).toBe(false);
  });

  it("isNewDetection true again when toVersion changes for the same id", () => {
    const c = new AutoUpdateCache();
    c.upsert(mk("a", "1.1.0"));
    expect(c.isNewDetection(mk("a", "1.2.0"))).toBe(true);
  });

  it("remove deletes the entry", () => {
    const c = new AutoUpdateCache();
    c.upsert(mk("a", "1.1.0"));
    c.remove("a");
    expect(c.get("a")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const c = new AutoUpdateCache();
    c.upsert(mk("a", "1.1.0"));
    c.upsert(mk("b", "2.0.0"));
    c.clear();
    expect(c.list()).toEqual([]);
  });

  it("list returns a defensive shallow copy", () => {
    const c = new AutoUpdateCache();
    c.upsert(mk("a", "1.1.0"));
    const snap = c.list();
    snap.push(mk("b", "2.0.0"));
    expect(c.list()).toHaveLength(1);
  });
});
