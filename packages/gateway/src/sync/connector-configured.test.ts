// packages/gateway/src/sync/connector-configured.test.ts
import { describe, expect, test } from "bun:test";

import { isConnectorConfigured } from "./connector-configured.ts";

/** `vault.get` calls the FULL key — the same shape `connector-secrets-manifest.ts` lists. */
function fakeVault(secrets: Record<string, string>) {
  return {
    async get(fullKey: string): Promise<string | null> {
      return secrets[fullKey] ?? null;
    },
  } as unknown as Parameters<typeof isConnectorConfigured>[0];
}

describe("isConnectorConfigured", () => {
  test("a service with none of its manifest keys set is not configured", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "github")).toBe(false);
  });

  test("a service with its manifest key set is configured", async () => {
    expect(await isConnectorConfigured(fakeVault({ "github.pat": "t" }), "github")).toBe(true);
  });

  test("a blank (whitespace-only) secret is treated as absent", async () => {
    expect(await isConnectorConfigured(fakeVault({ "github.pat": "   " }), "github")).toBe(false);
  });

  test("a multi-key service is configured when ANY one of its keys is set", async () => {
    // slack: ["slack.oauth", "slack.bot_token", "slack.app_token"] — only one need be present.
    expect(await isConnectorConfigured(fakeVault({ "slack.bot_token": "t" }), "slack")).toBe(true);
  });

  test("a multi-key service with none of its keys set is not configured", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "slack")).toBe(false);
  });

  test("a service with an EMPTY manifest key list (OAuth-managed, e.g. google_drive) is always configured", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "google_drive")).toBe(true);
  });

  test("a service id absent from the manifest entirely is treated as configured (no signal, no gate)", async () => {
    expect(await isConnectorConfigured(fakeVault({}), "filesystem")).toBe(true);
  });

  test("notion is configured via its single oauth key", async () => {
    expect(await isConnectorConfigured(fakeVault({ "notion.oauth": "t" }), "notion")).toBe(true);
    expect(await isConnectorConfigured(fakeVault({}), "notion")).toBe(false);
  });
});
