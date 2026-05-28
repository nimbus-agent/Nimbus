import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidZoomAccessToken } from "./zoom-access-token.ts";

const mutableConfig = Config as {
  oauthZoomClientId: string;
  oauthZoomClientSecret: string;
};

const originalFetch = globalThis.fetch;

describe("getValidZoomAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    mutableConfig.oauthZoomClientId = "";
    mutableConfig.oauthZoomClientSecret = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mutableConfig.oauthZoomClientId = "";
    mutableConfig.oauthZoomClientSecret = "";
  });

  it("throws when zoom.oauth vault key is absent", async () => {
    await expect(getValidZoomAccessToken(vault)).rejects.toThrow("Zoom OAuth not configured");
  });

  it("returns cached token without a network call when not near expiry", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "cached-zoom",
        refreshToken: "r-zoom",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    );
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("must not refresh on a cache hit");
    }) as unknown as typeof fetch;
    expect(await getValidZoomAccessToken(vault)).toBe("cached-zoom");
    expect(fetchCalled).toBe(false);
  });

  it("throws when token is expired but NIMBUS_OAUTH_ZOOM_CLIENT_ID is not set", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    await expect(getValidZoomAccessToken(vault)).rejects.toThrow("NIMBUS_OAUTH_ZOOM_CLIENT_ID");
  });

  it("refreshes when expired and persists rotated refresh token (Zoom rotates)", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "zoom-secret";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "r-new", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const tok = await getValidZoomAccessToken(vault);
    expect(tok).toBe("fresh");
    const persisted = await vault.get("zoom.oauth");
    expect(persisted).toContain("fresh");
    expect(persisted).toContain("r-new");
    expect(persisted).not.toContain("r-old");
  });

  it("retains old refresh token when Zoom omits a new one on refresh", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-keepme",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "zoom-secret";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await getValidZoomAccessToken(vault)).toBe("fresh");
    expect(await vault.get("zoom.oauth")).toContain("r-keepme");
  });

  it("never includes the client secret in a thrown error", async () => {
    await vault.set(
      "zoom.oauth",
      JSON.stringify({
        accessToken: "old",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );
    mutableConfig.oauthZoomClientId = "zoom-cid";
    mutableConfig.oauthZoomClientSecret = "ZOOM_SECRET_SHOULD_NOT_LEAK";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "refresh expired" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    let threw = "";
    try {
      await getValidZoomAccessToken(vault);
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw).toContain("invalid_grant");
    expect(threw.includes("ZOOM_SECRET_SHOULD_NOT_LEAK")).toBe(false);
  });
});
