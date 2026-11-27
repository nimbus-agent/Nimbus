import { describe, expect, test } from "bun:test";
import { registerFlagSyncables } from "../../../src/connectors/flag-syncables.ts";
import { mapSplitToItem } from "../../../src/connectors/split-flag-mapping.ts";
import { mapUnleashFeatureToItem } from "../../../src/connectors/unleash-feature-mapping.ts";
import { unleashSyncRoot } from "../../../src/connectors/unleash-sync.ts";
import type { Syncable } from "../../../src/sync/types.ts";

const UCTX = {
  root: "https://unleash.example.com",
  projectId: "web",
  projectName: "Web",
  syncedAt: 42,
};
const SCTX = { workspaceId: "ws-1", workspaceName: "Default", syncedAt: 42 };

describe("mapUnleashFeatureToItem", () => {
  test("a minimal flag: defaults, no tags, modifiedAt falls back to the sync time", () => {
    const row = mapUnleashFeatureToItem({ name: "a b" }, UCTX);
    expect(row?.externalId).toBe("web:a b");
    expect(row?.bodyPreview).toBe("a b");
    expect(row?.modifiedAt).toBe(42);
    expect(row?.url).toBe("https://unleash.example.com/projects/web/features/a%20b");
    expect(row?.metadata).toMatchObject({
      type: null,
      description: null,
      tags: [],
      stale: false,
      archived: false,
      impression_data: false,
      created_at: null,
      last_seen_at: null,
    });
  });

  test("tags as type:value (sorted, untyped ones bare, empty ones dropped), archive and timestamps", () => {
    const row = mapUnleashFeatureToItem(
      {
        name: "f",
        tags: [{ type: "simple", value: "z" }, { value: "a" }, { type: "t", value: "" }, null],
        archivedAt: "2026-02-01T00:00:00Z",
        impressionData: true,
        lastSeenAt: "2026-03-01T00:00:00Z",
        createdAt: "not a date",
      },
      UCTX,
    );
    expect(row?.metadata["tags"]).toEqual(["a", "simple:z"]);
    expect(row?.metadata["archived"]).toBe(true);
    expect(row?.metadata["impression_data"]).toBe(true);
    expect(row?.metadata["last_seen_at"]).toBe(Date.parse("2026-03-01T00:00:00Z"));
    expect(row?.metadata["created_at"]).toBeNull();
    expect(mapUnleashFeatureToItem({ name: "f", tags: "x" }, UCTX)?.metadata["tags"]).toEqual([]);
  });

  test("a row without a name, or not an object, is skipped", () => {
    expect(mapUnleashFeatureToItem({ name: "" }, UCTX)).toBeNull();
    expect(mapUnleashFeatureToItem({ type: "release" }, UCTX)).toBeNull();
    expect(mapUnleashFeatureToItem("x", UCTX)).toBeNull();
  });
});

describe("mapSplitToItem", () => {
  test("a minimal split: nulls, no URL, modifiedAt falls back to the sync time", () => {
    const row = mapSplitToItem({ name: "s" }, SCTX);
    expect(row?.externalId).toBe("ws-1:s");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.modifiedAt).toBe(42);
    expect(row?.metadata).toMatchObject({
      split_id: null,
      description: null,
      traffic_type: null,
      rollout_status: null,
      tags: [],
      created_at: null,
    });
  });

  test("odd tag and traffic-type shapes are dropped; a row without a name is skipped", () => {
    const row = mapSplitToItem(
      { name: "s", tags: [{ name: "" }, "x", { name: "b" }], trafficType: "user", tags2: 1 },
      SCTX,
    );
    expect(row?.metadata["tags"]).toEqual(["b"]);
    expect(row?.metadata["traffic_type"]).toBeNull();
    expect(mapSplitToItem({ name: "s", tags: {} }, SCTX)?.metadata["tags"]).toEqual([]);
    expect(mapSplitToItem({ description: "d" }, SCTX)).toBeNull();
    expect(mapSplitToItem(null, SCTX)).toBeNull();
  });
});

describe("unleashSyncRoot (the connector's URL rule)", () => {
  test("https, loopback http, a sub-path and a trailing /api", () => {
    expect(unleashSyncRoot("https://u.example.com/")).toBe("https://u.example.com");
    expect(unleashSyncRoot("https://u.example.com/unleash/api/")).toBe(
      "https://u.example.com/unleash",
    );
    expect(unleashSyncRoot("http://localhost:4242")).toBe("http://localhost:4242");
    expect(unleashSyncRoot("http://[::1]:4242/api")).toBe("http://[::1]:4242");
  });

  test("refuses clear text to another host, credentials, a query, a fragment and junk", () => {
    for (const bad of [
      "http://u.example.com",
      "ftp://u.example.com",
      "https://user:pw@u.example.com",
      "https://u.example.com/?x=1",
      "https://u.example.com/#x",
      "https://u.example.com/?",
      "not a url",
    ]) {
      expect(unleashSyncRoot(bad), bad).toBeNull();
    }
  });
});

describe("registerFlagSyncables", () => {
  test("registers the four flag syncables, each ensuring the phase-3 bundle", () => {
    const got: Syncable[] = [];
    registerFlagSyncables({ register: (s) => got.push(s) }, async () => {});
    expect(got.map((s) => s.serviceId)).toEqual(["launchdarkly", "flagsmith", "unleash", "split"]);
  });
});
