import { describe, expect, test } from "bun:test";

import { OAUTH_PROVIDERS } from "./oauth-registry.ts";

describe("OAUTH_PROVIDERS table", () => {
  test("has an entry for every existing provider with its vault key", () => {
    expect(OAUTH_PROVIDERS.google.vaultKey).toBe("google.oauth");
    expect(OAUTH_PROVIDERS.microsoft.vaultKey).toBe("microsoft.oauth");
    expect(OAUTH_PROVIDERS.slack.vaultKey).toBe("slack.oauth");
    expect(OAUTH_PROVIDERS.notion.vaultKey).toBe("notion.oauth");
  });

  test("each descriptor's id matches its table key", () => {
    for (const [key, d] of Object.entries(OAUTH_PROVIDERS)) {
      expect(d.id).toBe(key);
    }
  });
});

describe("google/microsoft descriptor hooks", () => {
  test("google authorize params include offline + consent + PKCE", () => {
    const p = OAUTH_PROVIDERS.google.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["openid", "email"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("openid email");
    expect(p["access_type"]).toBe("offline");
    expect(p["prompt"]).toBe("consent");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("microsoft authorize params omit google-only extras", () => {
    const p = OAUTH_PROVIDERS.microsoft.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["Calendars.Read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["access_type"]).toBeUndefined();
    expect(p["prompt"]).toBeUndefined();
    expect(p["scope"]).toBe("Calendars.Read");
  });

  test("standard parseTokenResponse maps fields and falls back scope to requested", () => {
    const r = OAUTH_PROVIDERS.google.parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      ["openid"],
    );
    expect(r.accessToken).toBe("a");
    expect(r.refreshToken).toBe("r");
    expect(r.scopes).toEqual(["openid"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("slack descriptor hooks", () => {
  test("authorize params use user_scope (comma) + empty scope", () => {
    const p = OAUTH_PROVIDERS.slack.buildAuthorizeParams({
      clientId: "123.456",
      scopes: ["channels:read", "channels:history"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["user_scope"]).toBe("channels:read,channels:history");
    expect(p["scope"]).toBe("");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse reads authed_user.access_token", () => {
    const r = OAUTH_PROVIDERS.slack.parseTokenResponse(
      {
        ok: true,
        authed_user: {
          access_token: "xoxp-a",
          refresh_token: "xoxe-r",
          expires_in: 3600,
          scope: "channels:read",
        },
      },
      ["channels:read"],
    );
    expect(r.accessToken).toBe("xoxp-a");
    expect(r.refreshToken).toBe("xoxe-r");
    expect(r.scopes).toEqual(["channels:read"]);
  });

  test("isTokenSuccess requires ok:true even on HTTP 200", () => {
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: false }, true)).toBe(false);
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: true }, true)).toBe(true);
  });
});

describe("notion descriptor hooks", () => {
  test("authorize params set owner=user, no PKCE challenge", () => {
    const p = OAUTH_PROVIDERS.notion.buildAuthorizeParams({
      clientId: "cid",
      scopes: [],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
    });
    expect(p["owner"]).toBe("user");
    expect(p["response_type"]).toBe("code");
    expect(p["code_challenge"]).toBeUndefined();
  });

  test("parseTokenResponse uses synthetic 24h expiry when expires_in absent", () => {
    const before = Date.now();
    const r = OAUTH_PROVIDERS.notion.parseTokenResponse(
      { access_token: "secret_a", refresh_token: "secret_r" },
      ["x"],
    );
    expect(r.accessToken).toBe("secret_a");
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
  });
});
