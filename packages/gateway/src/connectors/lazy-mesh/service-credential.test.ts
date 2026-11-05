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

  test("unknown services and prototype names fail closed", async () => {
    const vault = await vaultWith(ALL_CONFIGURED);
    for (const s of [
      "onedrive",
      "bitbucket",
      "argocd",
      "",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(await isServiceCredentialConfigured(vault, s, { obsidianVaultPaths: ["/v"] }), s).toBe(
        false,
      );
    }
  });
});
