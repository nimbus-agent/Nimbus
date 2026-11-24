import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConnectorConfigured } from "../../sync/connector-configured.ts";
import { createMockVault } from "../../vault/mock.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { buildPhase3Servers, phase3AddKubecostMcp, phase3AddOpencostMcp } from "./phase3-config.ts";
import type { ServerSpec } from "./slot.ts";

let SANDBOX_CWD: string;
beforeAll(() => {
  SANDBOX_CWD = mkdtempSync(join(tmpdir(), "nimbus-phase3-finops-test-"));
});
afterAll(() => {
  rmSync(SANDBOX_CWD, { recursive: true, force: true });
});

function policyOf(spec: ServerSpec): {
  permissions: { network: string[]; filesystem: { read: string[]; write: string[] } };
  ownerConfiguredNetwork?: string[];
} {
  return JSON.parse(spec.env?.["NIMBUS_SANDBOX_POLICY_JSON"] ?? "{}");
}

const CASES = [
  { id: "opencost", add: phase3AddOpencostMcp, prefix: "OPENCOST" },
  { id: "kubecost", add: phase3AddKubecostMcp, prefix: "KUBECOST" },
] as const;

for (const { id, add, prefix } of CASES) {
  describe(`${id} manifest`, () => {
    test("no static host, no wildcard, no filesystem, nothing owner-configured by itself", () => {
      const m = manifestForFirstParty(id);
      expect(m.id).toBe(`com.nimbus.${id}`);
      expect(m.permissions.network).toEqual([]);
      expect(m.permissions.filesystem).toEqual({ read: [], write: [] });
      expect(m.firstPartyWildcardHosts ?? []).toEqual([]);
      expect(m.ownerConfiguredNetwork ?? []).toEqual([]);
    });
  });

  describe(`phase3Add${id}Mcp`, () => {
    test("no-op without a URL, even with a token", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.token`, "t");
      const servers: Record<string, ServerSpec> = {};
      await add(vault, servers, SANDBOX_CWD);
      expect(servers[id]).toBeUndefined();
    });

    test("no-op for a whitespace URL", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, "   ");
      const servers: Record<string, ServerSpec> = {};
      await add(vault, servers, SANDBOX_CWD);
      expect(servers[id]).toBeUndefined();
    });

    test("spawns sandboxed to exactly the stored host and port, with no token env when none is stored", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, `http://${id}.${id}.svc:9003/`);
      const servers: Record<string, ServerSpec> = {};
      await add(vault, servers, SANDBOX_CWD);
      const spec = servers[id];
      expect(spec).toBeDefined();
      if (spec === undefined) return;
      expect(spec.command).toBe(process.execPath);
      expect(spec.env?.[`${prefix}_URL`]).toBe(`http://${id}.${id}.svc:9003/`);
      expect(spec.env?.[`${prefix}_TOKEN`]).toBeUndefined();
      const policy = policyOf(spec);
      expect(policy.permissions.network).toEqual([`${id}.${id}.svc:9003`]);
      expect(policy.permissions.filesystem).toEqual({ read: [], write: [] });
    });

    test("the token reaches the child only when stored, and never the sandbox policy", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, "https://cost.example.com");
      await vault.set(`${id}.token`, "tok-secret-in-policy");
      const servers: Record<string, ServerSpec> = {};
      await add(vault, servers, SANDBOX_CWD);
      const spec = servers[id];
      expect(spec?.env?.[`${prefix}_TOKEN`]).toBe("tok-secret-in-policy");
      expect(spec?.env?.["NIMBUS_SANDBOX_POLICY_JSON"]).not.toContain("tok-secret-in-policy");
      expect(policyOf(spec as ServerSpec).permissions.network).toEqual(["cost.example.com"]);
    });

    test("a URL that yields no host (an IPv6 literal) grants no network", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, "http://[::1]:9003");
      const servers: Record<string, ServerSpec> = {};
      await add(vault, servers, SANDBOX_CWD);
      expect(policyOf(servers[id] as ServerSpec).permissions.network).toEqual([]);
    });

    test("buildPhase3Servers registers it", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, "http://h.svc:9003");
      const servers = await buildPhase3Servers(vault, SANDBOX_CWD);
      expect(servers[id]).toBeDefined();
    });
  });

  describe(`${id} is configured by its URL alone`, () => {
    test("a lone token, cluster label or aggregate is NOT configured", async () => {
      for (const key of ["token", "cluster", "aggregate"]) {
        const vault = createMockVault();
        await vault.set(`${id}.${key}`, "x");
        expect(await isConnectorConfigured(vault, id)).toBe(false);
      }
    });

    test("the URL configures it", async () => {
      const vault = createMockVault();
      await vault.set(`${id}.url`, "http://h.svc:9003");
      expect(await isConnectorConfigured(vault, id)).toBe(true);
    });
  });
}
