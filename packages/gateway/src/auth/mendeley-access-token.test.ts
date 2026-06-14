import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Config } from "../config.ts";
import { MockVault } from "../vault/mock.ts";
import { getValidMendeleyAccessToken } from "./mendeley-access-token.ts";

const mutableConfig = Config as {
  oauthMendeleyClientId: string;
  oauthMendeleyClientSecret: string;
};

const originalFetch = globalThis.fetch;

describe("getValidMendeleyAccessToken", () => {
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
    mutableConfig.oauthMendeleyClientId = "";
    mutableConfig.oauthMendeleyClientSecret = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mutableConfig.oauthMendeleyClientId = "";
    mutableConfig.oauthMendeleyClientSecret = "";
  });

  it("returns cached token immediately when expiresAt is well in the future (cache-hit path)", async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await vault.set(
      "mendeley.oauth",
      JSON.stringify({
        accessToken: "cached-mendeley-access",
        refreshToken: "r-mendeley",
        expiresAt: farFuture,
      }),
    );

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called on a cache hit");
    }) as unknown as typeof fetch;

    const tok = await getValidMendeleyAccessToken(vault);
    expect(tok).toBe("cached-mendeley-access");
    expect(fetchCalled).toBe(false);
  });

  it("throws an actionable error when mendeley.oauth vault key is absent (secret-missing path)", async () => {
    await expect(getValidMendeleyAccessToken(vault)).rejects.toThrow(
      /Mendeley OAuth not configured/,
    );
  });
});
