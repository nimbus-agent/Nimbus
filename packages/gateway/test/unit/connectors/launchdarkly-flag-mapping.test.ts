import { describe, expect, test } from "bun:test";

import {
  flagUrl,
  mapLaunchDarklyFlagToItem,
} from "../../../src/connectors/launchdarkly-flag-mapping.ts";

function makeFlag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "enable-new-checkout",
    name: "Enable new checkout",
    kind: "boolean",
    description: "Rolls out the redesigned checkout flow.",
    tags: ["checkout", "frontend"],
    temporary: true,
    archived: false,
    creationDate: 1_700_000_000_000,
    maintainerId: "user-123",
    _maintainer: { email: "dev@acme.com", firstName: "Dev", lastName: "Eloper" },
    variations: [{ value: true }, { value: false }],
    environments: {
      production: { on: true, lastModified: 1_700_000_500_000 },
      staging: { on: false, lastModified: 1_700_000_200_000 },
    },
    ...over,
  };
}

const NOW = 1_700_009_999_999;
const BASE = "https://app.launchdarkly.com";

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapLaunchDarklyFlagToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapLaunchDarklyFlagToItem(null, { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
    expect(mapLaunchDarklyFlagToItem("nope", { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
  });

  test("returns null when key is missing or empty", () => {
    const noKey = makeFlag();
    delete (noKey as Record<string, unknown>)["key"];
    expect(mapLaunchDarklyFlagToItem(noKey, { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
    expect(mapLaunchDarklyFlagToItem(makeFlag({ key: "" }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is <projectKey>:<flagKey>", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("launchdarkly");
    expect(row.type).toBe("feature_flag");
    expect(row.externalId).toBe("default:enable-new-checkout");
  });

  test("title from name; falls back to key", () => {
    const withName = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (withName === null) throw new Error("expected mapping to succeed");
    expect(withName.title).toBe("Enable new checkout");

    const noName = makeFlag();
    delete (noName as Record<string, unknown>)["name"];
    const row = mapLaunchDarklyFlagToItem(noName, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("enable-new-checkout");
  });

  test("bodyPreview from description; falls back to title", () => {
    const noDesc = makeFlag();
    delete (noDesc as Record<string, unknown>)["description"];
    const row = mapLaunchDarklyFlagToItem(noDesc, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Enable new checkout");
  });

  test("kind accepts boolean/multivariate; unknown → null", () => {
    for (const k of ["boolean", "multivariate"]) {
      const row = mapLaunchDarklyFlagToItem(makeFlag({ kind: k }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
      if (row === null) throw new Error("expected mapping to succeed");
      expect(meta(row)["kind"]).toBe(k);
    }
    const garbage = mapLaunchDarklyFlagToItem(makeFlag({ kind: "rollout" }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect(meta(garbage)["kind"]).toBeNull();
  });

  test("flag metadata flows through", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["key"]).toBe("enable-new-checkout");
    expect(m["project_key"]).toBe("default");
    expect(m["tags"]).toEqual(["checkout", "frontend"]);
    expect(m["temporary"]).toBe(true);
    expect(m["archived"]).toBe(false);
    expect(m["maintainer"]).toBe("dev@acme.com");
    expect(m["maintainer_id"]).toBe("user-123");
    expect(m["variation_count"]).toBe(2);
    expect(m["created_at"]).toBe(1_700_000_000_000);
  });

  test("environments list + env_states on/off map are derived", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["environments"]).toEqual(["production", "staging"]);
    expect(meta(row)["env_states"]).toEqual({ production: true, staging: false });
  });

  test("modifiedAt = max env lastModified; falls back to creationDate then syncedAt", () => {
    const withEnvs = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (withEnvs === null) throw new Error("expected mapping to succeed");
    expect(withEnvs.modifiedAt).toBe(1_700_000_500_000);

    const noEnvMod = makeFlag({ environments: { production: { on: true } } });
    const createdOnly = mapLaunchDarklyFlagToItem(noEnvMod, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (createdOnly === null) throw new Error("expected mapping to succeed");
    expect(createdOnly.modifiedAt).toBe(1_700_000_000_000);

    const noDates = makeFlag({ environments: {} });
    delete (noDates as Record<string, unknown>)["creationDate"];
    const fallback = mapLaunchDarklyFlagToItem(noDates, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("url === canonicalUrl and points at the project flag page", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://app.launchdarkly.com/projects/default/flags/enable-new-checkout");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("flagUrl", () => {
  test("builds the project flag URL from the base host", () => {
    expect(flagUrl("https://app.launchdarkly.com", "default", "my-flag")).toBe(
      "https://app.launchdarkly.com/projects/default/flags/my-flag",
    );
  });

  test("strips a trailing slash on the base url", () => {
    expect(flagUrl("https://app.launchdarkly.com/", "p", "f")).toBe(
      "https://app.launchdarkly.com/projects/p/flags/f",
    );
  });

  test("percent-encodes project and flag keys", () => {
    expect(flagUrl("https://app.launchdarkly.com", "a/b", "c d")).toContain(
      `${encodeURIComponent("a/b")}/flags/${encodeURIComponent("c d")}`,
    );
  });
});
