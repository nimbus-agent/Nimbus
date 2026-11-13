import { describe, expect, mock, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { CONNECTOR_SERVICE_IDS } from "./connector-catalog.ts";
import {
  CONNECTOR_VAULT_SECRET_KEYS,
  clearConnectorVaultSecretKeys,
  requiredSecretKeysFor,
  TEAM_SECRET_ANYOF_GROUPS,
} from "./connector-secrets-manifest.ts";

describe("CONNECTOR_VAULT_SECRET_KEYS", () => {
  test("lists every connector service id", () => {
    for (const id of CONNECTOR_SERVICE_IDS) {
      expect(Array.isArray(CONNECTOR_VAULT_SECRET_KEYS[id])).toBe(true);
    }
  });
});

describe("TEAM_SECRET_ANYOF_GROUPS", () => {
  test("argocd/flux/mlflow tokens are team-vault enrollable (W1 GitOps/ML writes)", () => {
    expect(TEAM_SECRET_ANYOF_GROUPS.argocd).toEqual([["argocd.token"]]);
    expect(TEAM_SECRET_ANYOF_GROUPS.flux).toEqual([["flux.token"]]);
    expect(TEAM_SECRET_ANYOF_GROUPS.mlflow).toEqual([["mlflow.token"]]);
  });

  test("every grouped key is a real CONNECTOR_VAULT_SECRET_KEYS entry for its service", () => {
    for (const [service, groups] of Object.entries(TEAM_SECRET_ANYOF_GROUPS)) {
      const known = new Set<string>(
        CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
      );
      for (const key of (groups ?? []).flat()) {
        expect(known.has(key)).toBe(true);
      }
    }
  });
});

test("workday declares only the oauth vault key", () => {
  expect(CONNECTOR_VAULT_SECRET_KEYS.workday).toEqual(["workday.oauth"]);
});

describe("clearConnectorVaultSecretKeys", () => {
  test("deletes all keys for github, including the optional api_base", async () => {
    const deleted: string[] = [];
    const vault: NimbusVault = {
      get: mock(async () => null),
      set: mock(async () => {
        /* noop */
      }),
      delete: mock(async (k: string) => {
        deleted.push(k);
      }),
      listKeys: mock(async () => []),
    };
    const keys = await clearConnectorVaultSecretKeys(vault, "github");
    expect(keys).toEqual(["github.pat", "github.api_base"]);
    expect(deleted).toEqual(["github.pat", "github.api_base"]);
  });
});

test("jira declares its three credentials and the optional cloud id (so connector.remove clears it)", () => {
  expect(CONNECTOR_VAULT_SECRET_KEYS.jira).toEqual([
    "jira.api_token",
    "jira.email",
    "jira.base_url",
    "jira.cloud_id",
  ]);
});

describe("vantage (Phase 10 FO2)", () => {
  test("declares the token and the three options, but only the token is required", () => {
    expect(CONNECTOR_VAULT_SECRET_KEYS.vantage).toEqual([
      "vantage.api_token",
      "vantage.cost_report_token",
      "vantage.workspace_token",
      "vantage.group_by",
    ]);
    expect(requiredSecretKeysFor("vantage")).toEqual(["vantage.api_token"]);
  });

  test("connector.remove clears all four keys", async () => {
    const deleted: string[] = [];
    const vault: NimbusVault = {
      get: mock(async () => null),
      set: mock(async () => {
        /* noop */
      }),
      delete: mock(async (k: string) => {
        deleted.push(k);
      }),
      listKeys: mock(async () => []),
    };
    await clearConnectorVaultSecretKeys(vault, "vantage");
    expect(deleted).toEqual([
      "vantage.api_token",
      "vantage.cost_report_token",
      "vantage.workspace_token",
      "vantage.group_by",
    ]);
  });
});
