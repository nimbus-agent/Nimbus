import { describe, expect, it } from "bun:test";

import { liveExtensionIds, reapWith } from "./win32-reap.ts";

describe("liveExtensionIds", () => {
  it("includes every first-party manifest id", () => {
    const ids = liveExtensionIds({ query: () => ({ all: () => [] }) } as never);
    expect(ids.has("com.nimbus.github")).toBe(true);
  });

  it("includes installed extension ids from the extension table", () => {
    const db = { query: () => ({ all: () => [{ id: "com.acme.custom" }] }) };
    expect(liveExtensionIds(db as never).has("com.acme.custom")).toBe(true);
  });
});

describe("reapWith", () => {
  it("deletes a nimbus profile whose extension is gone", async () => {
    const deleted: string[] = [];
    const reaped = await reapWith({
      enumProfiles: async () => ["nimbus-ext-com.acme.gone", "nimbus-ext-com.nimbus.github"],
      deleteProfile: async (n) => {
        deleted.push(n);
      },
      liveExtensionIds: new Set(["com.nimbus.github"]),
    });
    expect(deleted).toEqual(["nimbus-ext-com.acme.gone"]);
    expect(reaped).toEqual(["nimbus-ext-com.acme.gone"]);
  });

  it("leaves a profile outside the nimbus-ext namespace alone", async () => {
    const deleted: string[] = [];
    await reapWith({
      enumProfiles: async () => ["some-other-app"],
      deleteProfile: async (n) => {
        deleted.push(n);
      },
      liveExtensionIds: new Set(),
    });
    expect(deleted).toEqual([]);
  });
});
