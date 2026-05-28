import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { MockVault } from "../vault/mock.ts";
import {
  getValidVaultOAuthAccessToken,
  microsoftOAuthAccessFromConfig,
  type ParseStoredOAuthErrors,
  parseStoredOAuthTokens,
} from "./oauth-vault-tokens.ts";

const ERRS: ParseStoredOAuthErrors = {
  invalidJson: "invalid_json",
  invalidPayload: "invalid_payload",
  missingAccess: "missing_access",
  missingRefresh: "missing_refresh",
  missingExpiry: "missing_expiry",
};

describe("parseStoredOAuthTokens", () => {
  it("parses a well-formed JSON payload", () => {
    const raw = JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_700_000_000_000,
    });
    expect(parseStoredOAuthTokens(raw, ERRS)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_700_000_000_000,
    });
  });

  it("throws invalidJson on a malformed string", () => {
    expect(() => parseStoredOAuthTokens("{not-json", ERRS)).toThrow("invalid_json");
  });

  it("throws invalidPayload when the JSON root is an array", () => {
    expect(() => parseStoredOAuthTokens("[]", ERRS)).toThrow("invalid_payload");
  });

  it("throws on missing access / refresh / expiry", () => {
    const base = { accessToken: "a", refreshToken: "r", expiresAt: 1 };
    expect(() =>
      parseStoredOAuthTokens(JSON.stringify({ ...base, accessToken: "" }), ERRS),
    ).toThrow("missing_access");
    expect(() =>
      parseStoredOAuthTokens(JSON.stringify({ ...base, refreshToken: "" }), ERRS),
    ).toThrow("missing_refresh");
    expect(() =>
      parseStoredOAuthTokens(JSON.stringify({ ...base, expiresAt: Number.NaN }), ERRS),
    ).toThrow("missing_expiry");
  });
});

describe("microsoftOAuthAccessFromConfig", () => {
  it("returns a typed config bundle with the microsoft.oauth vault key", () => {
    const cfg = microsoftOAuthAccessFromConfig();
    expect(cfg.vaultKey).toBe("microsoft.oauth");
    expect(cfg.provider).toBe("microsoft");
    expect(cfg.notConfiguredError).toContain("Microsoft");
    expect(cfg.parseErrors.invalidJson.length).toBeGreaterThan(0);
    expect(cfg.parseErrors.missingExpiry.length).toBeGreaterThan(0);
  });
});

describe("getValidVaultOAuthAccessToken", () => {
  const originalFetch = globalThis.fetch;
  let vault: MockVault;

  beforeEach(() => {
    vault = new MockVault();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws notConfigured when the vault key is absent", async () => {
    await expect(
      getValidVaultOAuthAccessToken({
        vault,
        vaultKey: "microsoft.oauth",
        notConfiguredError: "not_set",
        parseErrors: ERRS,
        getClientId: () => "cid",
        emptyClientIdError: "no_client_id",
        provider: "microsoft",
      }),
    ).rejects.toThrow("not_set");
  });

  it("returns cached access token when expiresAt is well past now + margin (cache-hit path)", async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "cached-access",
        refreshToken: "r1",
        expiresAt: farFuture,
      }),
    );
    const tok = await getValidVaultOAuthAccessToken({
      vault,
      vaultKey: "microsoft.oauth",
      notConfiguredError: "not_set",
      parseErrors: ERRS,
      getClientId: () => "cid",
      emptyClientIdError: "no_client_id",
      provider: "microsoft",
    });
    expect(tok).toBe("cached-access");
  });

  it("throws emptyClientIdError when the cached token is expired but client id is empty", async () => {
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r2",
        expiresAt: Date.now() - 60_000,
      }),
    );
    await expect(
      getValidVaultOAuthAccessToken({
        vault,
        vaultKey: "microsoft.oauth",
        notConfiguredError: "not_set",
        parseErrors: ERRS,
        getClientId: () => "", // empty → refresh branch errors out.
        emptyClientIdError: "no_client_id_msg",
        provider: "microsoft",
      }),
    ).rejects.toThrow("no_client_id_msg");
  });

  it("refreshes via the network when the cached token is expired (refresh-success path)", async () => {
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "r3",
        expiresAt: Date.now() - 60_000,
      }),
    );
    let calls = 0;
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      calls += 1;
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "r3",
          expires_in: 3600,
          scope: "User.Read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const tok = await getValidVaultOAuthAccessToken({
      vault,
      vaultKey: "microsoft.oauth",
      notConfiguredError: "not_set",
      parseErrors: ERRS,
      getClientId: () => "cid",
      emptyClientIdError: "no_client_id",
      provider: "microsoft",
    });
    expect(tok).toBe("refreshed-access");
    expect(calls).toBe(1);
  });
});
