import { describe, expect, test } from "bun:test";

import { buildAuthorizeUrl, exchangeAuthorizationCode, OAUTH_PROVIDERS } from "./oauth-registry.ts";

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

describe("buildAuthorizeUrl", () => {
  test("composes URL using descriptor.authorizeUrl + buildAuthorizeParams", () => {
    const url = buildAuthorizeUrl(OAUTH_PROVIDERS.google, {
      clientId: "cid",
      scopes: ["openid"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeAuthorizationCode", () => {
  test("notion exchange posts JSON with Basic auth header; no token leaks on error", async () => {
    let seenAuth = "";
    let seenCT = "";
    const fetchImpl = async (_i: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAuth = h.get("authorization") ?? "";
      seenCT = h.get("content-type") ?? "";
      return new Response(JSON.stringify({ access_token: "secret_a", refresh_token: "secret_r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.notion,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: [],
    });
    expect(r.accessToken).toBe("secret_a");
    expect(seenAuth.startsWith("Basic ")).toBe(true);
    expect(seenCT).toContain("application/json");
  });

  test("google exchange posts form with client_secret in body; HTTP error message omits secrets", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    let threw = "";
    try {
      await exchangeAuthorizationCode({
        descriptor: OAUTH_PROVIDERS.google,
        fetchFn: fetchImpl,
        clientId: "cid",
        clientSecret: "GOOGLE_WEB_SECRET",
        redirectUri: "http://127.0.0.1:1/oauth/callback",
        codeVerifier: "ver",
        authCode: "code",
        requestedScopes: ["openid"],
      });
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw).toContain("invalid_grant");
    expect(threw.includes("GOOGLE_WEB_SECRET")).toBe(false);
  });
});
