/**
 * `ensureGithubMcp` and a GitHub Enterprise Server base: the child gets GITHUB_API_BASE_URL only for
 * a valid stored base, both servers carry the GHES host in their sandbox network (additively, never
 * a wildcard), the env stays inside `extensionProcessEnv` (I1), and a stored but INVALID base
 * FAILS CLOSED: no spawn, so the enterprise PAT can never be sent to api.github.com.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ensureGithubMcp } from "./connector-spawns.ts";
import { LAZY_MESH } from "./keys.ts";
import type { MeshSpawnContext } from "./slot.ts";

type SpawnSpec = { env?: Record<string, string> };
type SandboxPolicyJson = {
  permissions: { network: string[] };
  ownerConfiguredNetwork?: string[];
  firstPartyWildcardHosts?: string[];
};

const warnings: Array<{ fields: unknown; msg: string }> = [];
const created: MCPClient[] = [];

afterEach(() => {
  warnings.length = 0;
  created.length = 0;
});

function spawnCtx(vault: NimbusVault): MeshSpawnContext {
  return {
    vault,
    sandboxCwd: join(import.meta.dir, "sandbox-root-not-created"),
    logger: {
      warn: (fields: unknown, msg: string) => warnings.push({ fields, msg }),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as MeshSpawnContext["logger"],
    clearLazyIdle: () => {},
    getLazyClient: () => undefined,
    setLazyClient: (_key, client) => {
      created.push(client);
    },
    bumpToolsEpoch: () => {},
    scheduleLazyDisconnect: () => {},
  };
}

async function vaultWith(entries: Record<string, string>): Promise<NimbusVault> {
  const vault = createMockVault();
  for (const [k, v] of Object.entries(entries)) await vault.set(k, v);
  return vault;
}

function servers(): Record<string, SpawnSpec> {
  expect(created).toHaveLength(1);
  return (created[0] as unknown as { serverConfigs: Record<string, SpawnSpec> }).serverConfigs;
}

function policyOf(spec: SpawnSpec): SandboxPolicyJson {
  return JSON.parse(spec.env?.[SANDBOX_POLICY_ENV] ?? "{}") as SandboxPolicyJson;
}

describe("ensureGithubMcp records the instance it spawned with", () => {
  async function recorded(entries: Record<string, string>): Promise<Array<string | null>> {
    const seen: Array<string | null> = [];
    await ensureGithubMcp({
      ...spawnCtx(await vaultWith(entries)),
      recordGithubInstance: (host) => seen.push(host),
    });
    return seen;
  }

  test("a GHES base records its host[:port]", async () => {
    expect(
      await recorded({ "github.pat": "ghp_x", "github.api_base": "https://ghe.example.com:8443" }),
    ).toEqual(["ghe.example.com:8443"]);
  });

  test("github.com records null", async () => {
    expect(await recorded({ "github.pat": "ghp_x" })).toEqual([null]);
  });

  test("a spawn that does not happen (invalid base, or no PAT) records nothing", async () => {
    expect(
      await recorded({ "github.pat": "ghp_x", "github.api_base": "http://ghe.example.com" }),
    ).toEqual([]);
    expect(await recorded({})).toEqual([]);
  });
});

describe("ensureGithubMcp", () => {
  test("github child env has no GITHUB_API_BASE_URL when none is stored", async () => {
    await ensureGithubMcp(spawnCtx(await vaultWith({ "github.pat": "ghp_x" })));
    for (const spec of Object.values(servers())) {
      expect(spec.env?.["GITHUB_PAT"]).toBe("ghp_x");
      expect(Object.hasOwn(spec.env ?? {}, "GITHUB_API_BASE_URL")).toBe(false);
    }
  });

  test("both children carry GITHUB_API_BASE_URL=<normalised base> and GITHUB_PAT", async () => {
    await ensureGithubMcp(
      spawnCtx(
        await vaultWith({
          "github.pat": "ghp_x",
          "github.api_base": "https://ghe.example.com/api/v3",
        }),
      ),
    );
    const s = servers();
    expect(Object.keys(s).sort()).toEqual(["github", "github_actions"]);
    for (const spec of Object.values(s)) {
      expect(spec.env?.["GITHUB_API_BASE_URL"]).toBe("https://ghe.example.com/api/v3");
      expect(spec.env?.["GITHUB_PAT"]).toBe("ghp_x");
    }
  });

  test("the sandbox network keeps api.github.com AND gains the GHES host (host:port too), for both children", async () => {
    await ensureGithubMcp(
      spawnCtx(
        await vaultWith({
          "github.pat": "ghp_x",
          "github.api_base": "https://ghe.example.com:8443/api/v3",
        }),
      ),
    );
    for (const [id, spec] of Object.entries(servers())) {
      const policy = policyOf(spec);
      expect(policy.permissions.network, id).toContain("api.github.com");
      expect(policy.permissions.network, id).toContain("ghe.example.com:8443");
      // The entry is the owner's: the consent surfaces label it so.
      expect(policy.ownerConfiguredNetwork, id).toContain("ghe.example.com:8443");
    }
  });

  test("no wildcard reaches a GHES github child; github_actions keeps only its first-party blob wildcard", async () => {
    await ensureGithubMcp(
      spawnCtx(
        await vaultWith({ "github.pat": "ghp_x", "github.api_base": "https://ghe.example.com" }),
      ),
    );
    const s = servers();
    const github = policyOf(s["github"] as SpawnSpec);
    expect(github.permissions.network.some((h) => h.includes("*"))).toBe(false);
    expect(github.firstPartyWildcardHosts ?? []).toEqual([]);
    const actions = policyOf(s["github_actions"] as SpawnSpec);
    expect(actions.firstPartyWildcardHosts).toEqual(["*.blob.core.windows.net"]);
    // The GHES host itself is concrete, never part of the wildcard set.
    expect(actions.permissions.network).toContain("ghe.example.com");
  });

  test("with no stored base the network is unchanged (no GHES host)", async () => {
    await ensureGithubMcp(spawnCtx(await vaultWith({ "github.pat": "ghp_x" })));
    const policy = policyOf(servers()["github"] as SpawnSpec);
    expect(policy.permissions.network).toEqual([
      "api.github.com",
      "uploads.github.com",
      "raw.githubusercontent.com",
    ]);
    expect(policy.ownerConfiguredNetwork).toBeUndefined();
  });

  test("a stored invalid api_base fails closed: NO spawn, a service-named warning, and the value is not logged", async () => {
    for (const bad of [
      "http://ghe.secret-host.example.com",
      "https://user:pw@ghe.secret-host.example.com",
      "https://ghe.secret-host.example.com/api/v4",
      "",
      "junk",
    ]) {
      created.length = 0;
      warnings.length = 0;
      await ensureGithubMcp(
        spawnCtx(await vaultWith({ "github.pat": "ghp_x", "github.api_base": bad })),
      );
      expect(created, bad).toHaveLength(0);
      expect(warnings, bad).toHaveLength(1);
      expect(JSON.stringify(warnings), bad).not.toContain("secret-host");
      expect(JSON.stringify(warnings), bad).toContain("github");
    }
  });

  test("without a PAT nothing spawns, even with a valid base", async () => {
    await ensureGithubMcp(
      spawnCtx(await vaultWith({ "github.api_base": "https://ghe.example.com" })),
    );
    expect(created).toHaveLength(0);
  });

  test("source: env goes through extensionProcessEnv only (I1), uses readGithubCredentialPair and wrapServerSpec/manifestWithConfiguredHost for both children", () => {
    const src = stripComments(readFileSync(join(import.meta.dir, "connector-spawns.ts"), "utf8"));
    const body = src.slice(src.indexOf("export async function ensureGithubMcp"));
    const fn = body.slice(0, body.indexOf("export async function", 10));
    expect(fn).toMatch(/const githubEnv = extensionProcessEnv\(/);
    expect(fn).toMatch(/readGithubCredentialPair\(/);
    expect(fn).not.toContain("normaliseGithubApiBase");
    expect(fn).toMatch(/manifestWithConfiguredHost\("github", ghesRoot\)/);
    expect(fn).toMatch(/manifestWithConfiguredHost\("github_actions", ghesRoot\)/);
    expect(fn).not.toMatch(/\bwrap\(/);
    const keys = [...fn.matchAll(/\bGITHUB_[A-Z_]+/g)].map((m) => m[0]);
    expect(new Set(keys)).toEqual(new Set(["GITHUB_PAT", "GITHUB_API_BASE_URL"]));
    // The slot key both servers share.
    expect(LAZY_MESH.github).toBeDefined();
  });
});
