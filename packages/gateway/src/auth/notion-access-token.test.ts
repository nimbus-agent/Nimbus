import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidNotionAccessToken } from "./notion-access-token.ts";

// Config is not Object.freeze-d at runtime — cast to allow temporary mutation in tests.
const mutableConfig = Config as {
  oauthNotionClientId: string;
  oauthNotionClientSecret: string;
};

const originalFetch = globalThis.fetch;

describe("getValidNotionAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    // Restore env-driven Config fields to empty by default so each test has a clean slate.
    mutableConfig.oauthNotionClientId = "";
    mutableConfig.oauthNotionClientSecret = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore Config after each test.
    mutableConfig.oauthNotionClientId = "";
    mutableConfig.oauthNotionClientSecret = "";
  });

  it("throws when notion.oauth vault key is absent (vault-miss path)", async () => {
    // vault is empty — readConnectorSecret("notion", "oauth") returns null.
    await expect(getValidNotionAccessToken(vault)).rejects.toThrow("Notion OAuth not configured");
  });

  it("throws when notion.oauth vault key is an empty string", async () => {
    await vault.set("notion.oauth", "");
    await expect(getValidNotionAccessToken(vault)).rejects.toThrow("Notion OAuth not configured");
  });

  it("returns cached token immediately when expiresAt is well in the future (cache-hit path)", async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000; // 24 h ahead
    await vault.set(
      "notion.oauth",
      JSON.stringify({
        accessToken: "cached-notion-access",
        refreshToken: "r-notion",
        expiresAt: farFuture,
      }),
    );

    // Ensure fetch is NOT called — a cache hit must not hit the network.
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called on a cache hit");
    }) as typeof fetch;

    const tok = await getValidNotionAccessToken(vault);
    expect(tok).toBe("cached-notion-access");
    expect(fetchCalled).toBe(false);
  });

  it("throws when token is expired but NIMBUS_OAUTH_NOTION_CLIENT_ID/SECRET are not set", async () => {
    // expiresAt in the past — forces the refresh branch; client id/secret empty → throws.
    await vault.set(
      "notion.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );

    // Config fields are already empty from beforeEach.
    await expect(getValidNotionAccessToken(vault)).rejects.toThrow("NIMBUS_OAUTH_NOTION_CLIENT_ID");
  });

  it("calls refreshNotionToken and returns new access token when token is expired (refresh-success path)", async () => {
    // Token expired: expiresAt in the past.
    await vault.set(
      "notion.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-notion-refresh",
        expiresAt: Date.now() - 60_000,
      }),
    );

    mutableConfig.oauthNotionClientId = "notion-client-id";
    mutableConfig.oauthNotionClientSecret = "notion-client-secret";

    let fetchCalls = 0;
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: "refreshed-notion-access",
          refresh_token: "r-notion-new",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const tok = await getValidNotionAccessToken(vault);
    expect(tok).toBe("refreshed-notion-access");
    expect(fetchCalls).toBe(1);
  });

  it("throws when the Notion refresh endpoint returns an error (refresh-error path)", async () => {
    await vault.set(
      "notion.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-notion-bad",
        expiresAt: Date.now() - 60_000,
      }),
    );

    mutableConfig.oauthNotionClientId = "notion-client-id";
    mutableConfig.oauthNotionClientSecret = "notion-client-secret";

    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(getValidNotionAccessToken(vault)).rejects.toThrow("Notion token refresh failed");
  });
});
