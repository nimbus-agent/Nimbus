// The feature-flag connectors' sandbox policies (`flag-manifests.ts`) and the Unleash and Split
// spawners (`phase3-delivery.ts`, connectors 0.22.0): the fixed vendor hosts, Unleash's empty list
// with the owner's host added at spawn, and the env each spawn injects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMockVault } from "../../vault/mock.ts";
import { FIRST_PARTY_MANIFESTS, manifestForFirstParty } from "./first-party-manifests.ts";
import { FLAG_FIRST_PARTY_MANIFESTS } from "./flag-manifests.ts";
import { phase3AddSplitMcp, phase3AddUnleashMcp } from "./phase3-config.ts";
import type { ServerSpec } from "./slot.ts";

const wildcards = (net: readonly string[]): string[] => net.filter((h) => h.includes("*"));

function policyOf(spec: ServerSpec): {
  permissions: { network: string[] };
  ownerConfiguredNetwork?: string[];
} {
  const raw = spec.env?.["NIMBUS_SANDBOX_POLICY_JSON"];
  if (raw === undefined) throw new Error("not sandboxed");
  return JSON.parse(raw) as {
    permissions: { network: string[] };
    ownerConfiguredNetwork?: string[];
  };
}

let SANDBOX_CWD: string;
beforeAll(() => {
  SANDBOX_CWD = mkdtempSync(join(tmpdir(), "nimbus-flag-manifests-test-"));
});
afterAll(() => {
  if (SANDBOX_CWD) rmSync(SANDBOX_CWD, { recursive: true, force: true });
});

describe("the flag connectors' manifests", () => {
  test("launchdarkly, flagsmith and split: their fixed API host, no wildcard, no filesystem", () => {
    for (const [id, host] of [
      ["launchdarkly", "app.launchdarkly.com"],
      ["flagsmith", "api.flagsmith.com"],
      ["split", "api.split.io"],
    ] as const) {
      const m = manifestForFirstParty(id);
      expect(m.permissions.network, id).toEqual([host]);
      expect(wildcards(m.permissions.network), id).toEqual([]);
      expect(m.firstPartyWildcardHosts ?? [], id).toEqual([]);
      expect(m.permissions.filesystem, id).toEqual({ read: [], write: [] });
    }
  });

  test("unleash is self-hosted: no network in the static policy", () => {
    const m = manifestForFirstParty("unleash");
    expect(m.id).toBe("com.nimbus.unleash");
    expect(m.permissions.network).toEqual([]);
    expect(m.firstPartyWildcardHosts ?? []).toEqual([]);
  });

  test("each is spread into FIRST_PARTY_MANIFESTS as is", () => {
    for (const [id, m] of Object.entries(FLAG_FIRST_PARTY_MANIFESTS)) {
      expect(FIRST_PARTY_MANIFESTS[id], id).toBe(m);
    }
  });
});

describe("phase3AddUnleashMcp", () => {
  test("no-op unless both the URL and the token are stored (blank counts as unset)", async () => {
    for (const secrets of [
      {},
      { "unleash.api_url": "https://unleash.example.com" },
      { "unleash.token": "fake-unleash-token" },
      { "unleash.api_url": "  ", "unleash.token": "  " },
    ]) {
      const vault = createMockVault();
      for (const [k, v] of Object.entries(secrets)) await vault.set(k, v);
      const servers: Record<string, ServerSpec> = {};
      await phase3AddUnleashMcp(vault, servers, SANDBOX_CWD);
      expect(servers["unleash"], JSON.stringify(secrets)).toBeUndefined();
    }
  });

  test("spawns with UNLEASH_API_URL / UNLEASH_API_TOKEN and the URL's host as the owner's", async () => {
    const vault = createMockVault();
    await vault.set("unleash.api_url", " https://unleash.example.com/api ");
    await vault.set("unleash.token", "fake-unleash-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddUnleashMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["unleash"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["UNLEASH_API_URL"]).toBe("https://unleash.example.com/api");
    expect(spec.env?.["UNLEASH_API_TOKEN"]).toBe("fake-unleash-token");
    const policy = policyOf(spec);
    expect(policy.permissions.network).toEqual(["unleash.example.com"]);
    expect(policy.ownerConfiguredNetwork).toEqual(["unleash.example.com"]);
  });
});

describe("phase3AddSplitMcp", () => {
  test("no-op without split.api_key", async () => {
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSplitMcp(createMockVault(), servers, SANDBOX_CWD);
    expect(servers["split"]).toBeUndefined();
  });

  test("spawns with SPLIT_ADMIN_API_KEY and api.split.io only", async () => {
    const vault = createMockVault();
    await vault.set("split.api_key", "fake-split-key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSplitMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["split"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["SPLIT_ADMIN_API_KEY"]).toBe("fake-split-key");
    expect(policyOf(spec).permissions.network).toEqual(["api.split.io"]);
  });
});
