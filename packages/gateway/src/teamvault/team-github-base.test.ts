/**
 * A team github entry and the optional `github.api_base` (I19): a PAT-only entry is complete and
 * spawns against github.com, a PAT plus a valid GHES base spawns against THAT host with the team PAT,
 * and a PAT plus an invalid base fails closed (no child, so the team PAT never reaches api.github.com).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import {
  requiredSecretKeysFor,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../connectors/connector-secrets-manifest.ts";
import { ensureGithubMcp } from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import { createMockVault } from "../vault/mock.ts";
import { invokeTeamTool, TeamToolError, type TeamToolSpawnRequest } from "./team-tool-invoke.ts";

type SpawnSpec = { env?: Record<string, string> };

async function teamRun(entries: Record<string, string>): Promise<{
  spawnedEnvs: Array<Record<string, string> | undefined>;
  error?: unknown;
}> {
  const vault = createMockVault();
  for (const [k, v] of Object.entries(entries)) await vault.set(`teamvault.prod.${k}`, v);
  const created: MCPClient[] = [];
  const spawnedEnvs: Array<Record<string, string> | undefined> = [];
  try {
    await invokeTeamTool(
      {
        vault,
        sandboxCwd: join(import.meta.dir, "sandbox-root-not-created"),
        requiredSecretKeysFor,
        anyOfSecretGroupsFor: (s) =>
          TEAM_SECRET_ANYOF_GROUPS[s as keyof typeof TEAM_SECRET_ANYOF_GROUPS],
        spawnAndCall: async (req: TeamToolSpawnRequest) => {
          const ctx: MeshSpawnContext = {
            vault: req.vaultView,
            sandboxCwd: req.sandboxCwd,
            clearLazyIdle: () => {},
            getLazyClient: () => undefined,
            setLazyClient: (_k, c) => {
              created.push(c);
            },
            bumpToolsEpoch: () => {},
            scheduleLazyDisconnect: () => {},
          };
          await ensureGithubMcp(ctx);
          for (const c of created) {
            // Real MCPClient: `serverConfigs`; the shared canonical mock (--no-isolate runs): `servers`.
            const cc = c as unknown as {
              serverConfigs?: Record<string, SpawnSpec>;
              servers?: Record<string, SpawnSpec>;
            };
            const cfgs = cc.serverConfigs ?? cc.servers;
            if (cfgs === undefined)
              throw new Error("the spawned MCP client exposes no server specs");
            spawnedEnvs.push(cfgs["github"]?.env);
          }
          return { ok: true };
        },
      },
      { entry: "prod", service: "github", toolId: "github_issue_create", args: {} },
    );
  } catch (error) {
    return { spawnedEnvs, error };
  }
  return { spawnedEnvs };
}

describe("a team github entry", () => {
  test("a PAT-only entry is complete and spawns against github.com", async () => {
    const r = await teamRun({ "github.pat": "TEAMPAT" });
    expect(r.error).toBeUndefined();
    expect(r.spawnedEnvs).toHaveLength(1);
    expect(r.spawnedEnvs[0]?.["GITHUB_PAT"]).toBe("TEAMPAT");
    expect(Object.hasOwn(r.spawnedEnvs[0] ?? {}, "GITHUB_API_BASE_URL")).toBe(false);
  });

  test("a PAT plus a valid GHES base spawns against that GHES", async () => {
    const r = await teamRun({
      "github.pat": "TEAMPAT",
      "github.api_base": "https://ghe.example.com",
    });
    expect(r.error).toBeUndefined();
    expect(r.spawnedEnvs[0]?.["GITHUB_API_BASE_URL"]).toBe("https://ghe.example.com/api/v3");
    expect(r.spawnedEnvs[0]?.["GITHUB_PAT"]).toBe("TEAMPAT");
  });

  test("a PAT plus an invalid base fails closed: no child is spawned", async () => {
    const r = await teamRun({
      "github.pat": "TEAMPAT",
      "github.api_base": "http://ghe.example.com",
    });
    expect(r.spawnedEnvs).toEqual([]);
  });

  test("a missing PAT is still team_secret_missing", async () => {
    const r = await teamRun({ "github.api_base": "https://ghe.example.com" });
    expect(r.error).toBeInstanceOf(TeamToolError);
    expect((r.error as TeamToolError).code).toBe("team_secret_missing");
  });
});
