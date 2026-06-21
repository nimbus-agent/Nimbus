import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidWorkdayAccessToken } from "./workday-access-token.ts";

const mutableConfig = Config as {
  oauthWorkdayClientId: string;
  oauthWorkdayClientSecret: string;
  workdayTenantHost: string;
  workdayTenant: string;
};

const originalFetch = globalThis.fetch;

describe("getValidWorkdayAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    mutableConfig.oauthWorkdayClientId = "";
    mutableConfig.oauthWorkdayClientSecret = "";
    mutableConfig.workdayTenantHost = "https://wd5.workday.com";
    mutableConfig.workdayTenant = "acme";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mutableConfig.oauthWorkdayClientId = "";
    mutableConfig.oauthWorkdayClientSecret = "";
    mutableConfig.workdayTenantHost = "";
    mutableConfig.workdayTenant = "";
  });

  it("returns cached token immediately when expiresAt is well in the future (cache-hit path)", async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await vault.set(
      "workday.oauth",
      JSON.stringify({
        accessToken: "cached-workday-access",
        refreshToken: "r-workday",
        expiresAt: farFuture,
      }),
    );

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called on a cache hit");
    }) as unknown as typeof fetch;

    const tok = await getValidWorkdayAccessToken(vault);
    expect(tok).toBe("cached-workday-access");
    expect(fetchCalled).toBe(false);
  });

  it("throws an actionable error when workday.oauth vault key is absent (secret-missing path)", async () => {
    await expect(getValidWorkdayAccessToken(vault)).rejects.toThrow(/Workday OAuth not configured/);
  });

  it("throws when token is expired but NIMBUS_OAUTH_WORKDAY_CLIENT_ID/SECRET are not set", async () => {
    await vault.set(
      "workday.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r-old",
        expiresAt: Date.now() - 60_000,
      }),
    );

    await expect(getValidWorkdayAccessToken(vault)).rejects.toThrow(
      "NIMBUS_OAUTH_WORKDAY_CLIENT_ID",
    );
  });
});
