import { afterEach, describe, expect, test } from "bun:test";

import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { perServiceOAuthVaultKey } from "../connector-vault.ts";
import {
  isServiceCredentialConfigured,
  SERVICE_CREDENTIAL_SERVICES,
} from "./service-credential.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A refresh-shaped token: an expired access token that a refresh WOULD try to exchange. */
const EXPIRED = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1 });

/** A vault whose only working method is `get`: a predicate that writes (a refresh would) throws. */
function readOnly(inner: NimbusVault): NimbusVault {
  const refuse = (): never => {
    throw new Error("a credential predicate must only read");
  };
  return {
    get: (k) => inner.get(k),
    set: refuse,
    delete: refuse,
    listKeys: refuse,
  };
}

async function vaultWith(secrets: Record<string, string>): Promise<NimbusVault> {
  const v = createMockVault();
  for (const [k, val] of Object.entries(secrets)) await v.set(k, val);
  return readOnly(v);
}

const ALL_CONFIGURED: Record<string, string> = {
  "google.oauth": EXPIRED,
  "microsoft.oauth": EXPIRED,
  "github.pat": "p",
  "gitlab.pat": "p",
  "slack.oauth": EXPIRED,
  "linear.api_key": "k",
  "notion.oauth": EXPIRED,
  "jira.api_token": "t",
  "jira.email": "e",
  "jira.base_url": "u",
  "confluence.api_token": "t",
  "confluence.email": "e",
  "confluence.base_url": "u",
  "discord.enabled": "1",
  "discord.bot_token": "b",
  "apple.icloud_email": "e",
  "apple.icloud_app_password": "p",
  "pagerduty.api_token": "t",
  "pagerduty.from_email": "oncall@example.com",
  "bitbucket.username": "u",
  "bitbucket.app_password": "p",
  "jenkins.base_url": "https://ci.example.com",
  "jenkins.username": "u",
  "jenkins.api_token": "t",
  "circleci.api_token": "t",
  "kubernetes.kubeconfig": "/home/me/.kube/config",
};

describe("isServiceCredentialConfigured", () => {
  test("every service reads stored keys only: true when configured, with no network and no write", async () => {
    let fetches = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      throw new Error("no network");
    }) as unknown as typeof fetch;
    const vault = await vaultWith(ALL_CONFIGURED);
    for (const s of SERVICE_CREDENTIAL_SERVICES) {
      expect(await isServiceCredentialConfigured(vault, s, { obsidianVaultPaths: ["/v"] }), s).toBe(
        true,
      );
    }
    expect(fetches).toBe(0);
  });

  test("an empty vault configures nothing", async () => {
    const vault = await vaultWith({});
    for (const s of SERVICE_CREDENTIAL_SERVICES) {
      expect(await isServiceCredentialConfigured(vault, s, {}), s).toBe(false);
    }
  });

  test("Google is per SERVICE: a drive-only key configures google_drive, not gmail", async () => {
    const key = perServiceOAuthVaultKey("google_drive") ?? "";
    const vault = await vaultWith({ [key]: EXPIRED });
    expect(await isServiceCredentialConfigured(vault, "google_drive", {})).toBe(true);
    expect(await isServiceCredentialConfigured(vault, "gmail", {})).toBe(false);
  });

  test("discord needs the opt-in flag; jira, confluence and apple need every key", async () => {
    const v1 = await vaultWith({ "discord.bot_token": "b", "discord.enabled": "0" });
    expect(await isServiceCredentialConfigured(v1, "discord", {})).toBe(false);
    const v2 = await vaultWith({ "jira.api_token": "t", "jira.email": "e", "jira.base_url": "" });
    expect(await isServiceCredentialConfigured(v2, "jira", {})).toBe(false);
    const v3 = await vaultWith({ "confluence.api_token": "t", "confluence.base_url": "u" });
    expect(await isServiceCredentialConfigured(v3, "confluence", {})).toBe(false);
    const v4 = await vaultWith({ "apple.icloud_app_password": "p" });
    expect(await isServiceCredentialConfigured(v4, "apple", {})).toBe(false);
  });

  test("kubernetes is configured by a non-blank kubeconfig path, never by reading the file (D3a)", async () => {
    expect(
      await isServiceCredentialConfigured(
        await vaultWith({ "kubernetes.kubeconfig": "/k/config" }),
        "kubernetes",
        {},
      ),
    ).toBe(true);
    for (const v of [{}, { "kubernetes.kubeconfig": "   " }]) {
      expect(await isServiceCredentialConfigured(await vaultWith(v), "kubernetes", {})).toBe(false);
    }
  });

  test("onedrive rides the shared Microsoft OAuth key, like outlook and teams", async () => {
    const without = await vaultWith({ "github.pat": "p" });
    expect(await isServiceCredentialConfigured(without, "onedrive", {})).toBe(false);
    const withMs = await vaultWith({ "microsoft.oauth": EXPIRED });
    for (const s of ["onedrive", "outlook", "teams"]) {
      expect(await isServiceCredentialConfigured(withMs, s, {}), s).toBe(true);
    }
  });

  test("pagerduty needs the API token AND a well-formed from_email (the model door writes)", async () => {
    const both = await vaultWith({ "pagerduty.api_token": "t", "pagerduty.from_email": "a@b.co" });
    expect(await isServiceCredentialConfigured(both, "pagerduty", {})).toBe(true);
    const cases: Record<string, Record<string, string>> = {
      "token only": { "pagerduty.api_token": "t" },
      "email only": { "pagerduty.from_email": "a@b.co" },
      "blank token": { "pagerduty.api_token": "  ", "pagerduty.from_email": "a@b.co" },
      "blank email": { "pagerduty.api_token": "t", "pagerduty.from_email": "   " },
      "no at sign": { "pagerduty.api_token": "t", "pagerduty.from_email": "ab.co" },
      "no domain dot": { "pagerduty.api_token": "t", "pagerduty.from_email": "a@bco" },
      "inner space": { "pagerduty.api_token": "t", "pagerduty.from_email": "a b@c.co" },
      "two ats": { "pagerduty.api_token": "t", "pagerduty.from_email": "a@@b.co" },
    };
    for (const [label, secrets] of Object.entries(cases)) {
      const vault = await vaultWith(secrets);
      expect(await isServiceCredentialConfigured(vault, "pagerduty", {}), label).toBe(false);
    }
  });

  test("bitbucket needs the username AND the app password; jenkins needs the base URL, username AND token; circleci needs its token", async () => {
    const need: Record<string, string[]> = {
      bitbucket: ["bitbucket.username", "bitbucket.app_password"],
      jenkins: ["jenkins.base_url", "jenkins.username", "jenkins.api_token"],
      circleci: ["circleci.api_token"],
    };
    for (const [service, keys] of Object.entries(need)) {
      const all = Object.fromEntries(keys.map((k) => [k, "x"]));
      expect(await isServiceCredentialConfigured(await vaultWith(all), service, {}), service).toBe(
        true,
      );
      for (const missing of keys) {
        const some = Object.fromEntries(keys.filter((k) => k !== missing).map((k) => [k, "x"]));
        expect(
          await isServiceCredentialConfigured(await vaultWith(some), service, {}),
          `${service} without ${missing}`,
        ).toBe(false);
        const blank = { ...all, [missing]: "   " };
        expect(
          await isServiceCredentialConfigured(await vaultWith(blank), service, {}),
          `${service} blank ${missing}`,
        ).toBe(false);
      }
    }
  });

  test("github_actions rides the GitHub PAT (it runs in the github slot) and nothing else", async () => {
    expect(
      await isServiceCredentialConfigured(
        await vaultWith({ "github.pat": "p" }),
        "github_actions",
        {},
      ),
    ).toBe(true);
    expect(
      await isServiceCredentialConfigured(
        await vaultWith({ "github.pat": "  " }),
        "github_actions",
        {},
      ),
    ).toBe(false);
    expect(
      await isServiceCredentialConfigured(
        await vaultWith({ "gitlab.pat": "p" }),
        "github_actions",
        {},
      ),
    ).toBe(false);
  });

  test("unknown services and prototype names fail closed", async () => {
    const vault = await vaultWith(ALL_CONFIGURED);
    for (const s of ["argocd", "", "__proto__", "constructor", "toString"]) {
      expect(await isServiceCredentialConfigured(vault, s, { obsidianVaultPaths: ["/v"] }), s).toBe(
        false,
      );
    }
  });
});
