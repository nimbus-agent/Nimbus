import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidSlackAccessToken } from "./slack-access-token.ts";

const mutableConfig = Config as {
  oauthSlackClientId: string;
};

const originalFetch = globalThis.fetch;

describe("getValidSlackAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    mutableConfig.oauthSlackClientId = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mutableConfig.oauthSlackClientId = "";
  });

  it("throws when slack.oauth vault key is absent (vault-miss path)", async () => {
    await expect(getValidSlackAccessToken(vault)).rejects.toThrow("Slack OAuth not configured");
  });

  it("throws when slack.oauth vault key is an empty string", async () => {
    await vault.set("slack.oauth", "");
    await expect(getValidSlackAccessToken(vault)).rejects.toThrow("Slack OAuth not configured");
  });

  it("returns cached token immediately when expiresAt is well in the future (cache-hit path)", async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "cached-slack-access",
        refreshToken: "r-slack",
        expiresAt: farFuture,
      }),
    );

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called on a cache hit");
    }) as unknown as typeof fetch;

    const tok = await getValidSlackAccessToken(vault);
    expect(tok).toBe("cached-slack-access");
    expect(fetchCalled).toBe(false);
  });

  it("throws when token is expired but NIMBUS_OAUTH_SLACK_CLIENT_ID is not set", async () => {
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );

    await expect(getValidSlackAccessToken(vault)).rejects.toThrow("NIMBUS_OAUTH_SLACK_CLIENT_ID");
  });

  it("calls refreshSlackUserToken and returns new access token when token is expired (refresh-success path)", async () => {
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-slack-refresh",
        expiresAt: Date.now() - 60_000,
      }),
    );

    mutableConfig.oauthSlackClientId = "slack-client-id";

    let fetchCalls = 0;
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          authed_user: {
            access_token: "refreshed-slack-access",
            refresh_token: "r-slack-new",
            expires_in: 43200,
            scope: "channels:read",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tok = await getValidSlackAccessToken(vault);
    expect(tok).toBe("refreshed-slack-access");
    expect(fetchCalls).toBe(1);
  });

  it("throws when the Slack refresh endpoint returns ok:false (refresh-error path)", async () => {
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-slack-bad",
        expiresAt: Date.now() - 60_000,
      }),
    );

    mutableConfig.oauthSlackClientId = "slack-client-id";

    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      return new Response(JSON.stringify({ ok: false, error: "token_revoked" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(getValidSlackAccessToken(vault)).rejects.toThrow("Token exchange failed");
  });

  it("throws when the Slack refresh endpoint returns HTTP error status (refresh-http-error path)", async () => {
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-slack-http-err",
        expiresAt: Date.now() - 60_000,
      }),
    );

    mutableConfig.oauthSlackClientId = "slack-client-id";

    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      return new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(getValidSlackAccessToken(vault)).rejects.toThrow("Token exchange failed");
  });
});
