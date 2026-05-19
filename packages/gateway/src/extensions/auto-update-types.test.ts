import { describe, expect, it } from "bun:test";
import {
  ACTION_TYPE_AUTO_UPDATE,
  ACTION_TYPE_DOWNGRADE,
  type AvailableUpdate,
  type PermissionDiff,
} from "./auto-update-types.ts";

describe("auto-update-types", () => {
  it("exposes the two HITL action-type literals", () => {
    expect(ACTION_TYPE_AUTO_UPDATE).toBe("extension.autoUpdate");
    expect(ACTION_TYPE_DOWNGRADE).toBe("extension.downgrade");
  });

  it("permission-diff shape is symmetric (added + removed) for every axis", () => {
    const empty: PermissionDiff = {
      network: { added: [], removed: [] },
      filesystem: {
        read: { added: [], removed: [] },
        write: { added: [], removed: [] },
      },
    };
    expect(empty.network.added).toEqual([]);
    expect(empty.filesystem.read.added).toEqual([]);
    expect(empty.filesystem.write.removed).toEqual([]);
  });

  it("AvailableUpdate type compiles", () => {
    const u: AvailableUpdate = {
      id: "com.example.test",
      displayName: "Test",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "verified",
      manifestHash: "0".repeat(64),
      signatureB64: "AA==",
      entryHash: "0".repeat(64),
      tarballUrl: "https://registry.example/ext.tar.gz",
      permissionDiff: {
        network: { added: [], removed: [] },
        filesystem: {
          read: { added: [], removed: [] },
          write: { added: [], removed: [] },
        },
      },
      verificationStatus: "verified",
      detectedAt: 0,
    };
    expect(u.id).toBe("com.example.test");
  });
});
